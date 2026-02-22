// X-Purge Content Script
// Injected on x.com/* — activates when URL is /following.
// Handles scanning, filtering, and unfollowing.

(function () {
  'use strict';
  if (window.__xPurgeLoaded) return;
  window.__xPurgeLoaded = true;

  // ============================================================
  // DOM SELECTORS
  // X.com uses data-testid attrs (more stable than class names)
  // ============================================================
  const SEL = {
    userCell: '[data-testid="UserCell"]',
    userName: '[data-testid="UserName"]',
    userDescription: '[data-testid="UserDescription"]',
    avatarImg: '[data-testid="UserAvatar"] img, [data-testid="UserAvatarImage"], [data-testid^="UserAvatar-Container"] img',
    verifiedBadge: '[data-testid="icon-verified"], [data-testid="verifiedIcon"], svg[aria-label="Verified account"]',
    primaryColumn: '[data-testid="primaryColumn"]',
    confirmDialog: '[data-testid="confirmationSheetDialog"]',
    confirmBtn: '[data-testid="confirmationSheetConfirm"]',
  };

  // ============================================================
  // RUNTIME STATE
  // ============================================================
  let state = {
    active: false,         // overlay visible
    scanning: false,
    running: false,
    dryRun: false,
    scanned: [],           // all accounts seen during scroll
    targets: [],           // accounts that pass filters
    unfollowedCount: 0,
    filters: defaultFilters(),
    whitelist: [],
    dailyCount: 0,
  };

  function defaultFilters() {
    return {
      // Relationship
      notFollowingBack: false,
      protectMutuals: true,
      followedMonthsAgo: 0,       // 0 = disabled

      // Activity
      inactiveDays: 0,             // 0 = disabled

      // Profile quality
      defaultAvatar: false,
      excludeVerified: false,
      followerRatioBelow: 0,       // 0 = disabled
      minFollowerProtect: 0,       // 0 = disabled  (protect accounts WITH >=N followers)
      accountAgeMonths: 0,         // 0 = disabled  (unfollow if age < N months)

      // Keywords
      bioBlacklist: [],
      bioWhitelist: [],

      // Safety
      dailyLimit: 50,
      minDelay: 5,
      maxDelay: 15,
      batchSize: 10,
    };
  }

  // ============================================================
  // CHROME MESSAGING (to service worker)
  // ============================================================
  const SW = {
    send(msg) {
      return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
    },
    getDailyCount: () => SW.send({ type: 'GET_DAILY_COUNT' }),
    incrementDaily: () => SW.send({ type: 'INCREMENT_DAILY_COUNT' }),
    getWhitelist: () => SW.send({ type: 'GET_WHITELIST' }),
    addWhitelist: (u) => SW.send({ type: 'ADD_TO_WHITELIST', username: u }),
    removeWhitelist: (u) => SW.send({ type: 'REMOVE_FROM_WHITELIST', username: u }),
    getFilters: () => SW.send({ type: 'GET_FILTERS' }),
    saveFilters: (f) => SW.send({ type: 'SAVE_FILTERS', filters: f }),
  };

  // Reserved path segments that look like usernames but aren't
  const RESERVED_PATHS = new Set([
    'home','explore','notifications','messages','settings','i','following',
    'followers','compose','search','lists','bookmarks','communities',
    'verified-orgs','premium','jobs','grok',
  ]);

  // ============================================================
  // SCRAPER — extract account data from a UserCell DOM node
  // ============================================================
  const Scraper = {
    fromCell(cell) {
      const acc = { element: cell, reason: null, profileData: null };

      // ── Username: read from profile-link href (most reliable) ──
      // Every UserCell has an <a href="/username"> link to the profile.
      for (const a of cell.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([A-Za-z0-9_]{1,50})(?:[/?#].*)?$/);
        if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
          acc.username = m[1].toLowerCase();
          break;
        }
      }

      // ── Fallback: span containing @handle ──
      if (!acc.username) {
        const nameEl = cell.querySelector(SEL.userName);
        if (nameEl) {
          for (const s of nameEl.querySelectorAll('span')) {
            const t = s.textContent.trim();
            if (t.startsWith('@') && t.length > 1) {
              acc.username = t.slice(1).toLowerCase();
              break;
            }
          }
        }
      }

      // ── Display name ──
      const nameEl = cell.querySelector(SEL.userName);
      acc.displayName = nameEl ? (nameEl.querySelector('span')?.textContent.trim() || '') : '';

      // ── Bio ──
      const bioEl = cell.querySelector(SEL.userDescription);
      acc.bio = bioEl ? bioEl.textContent.trim() : '';

      // ── Verified badge ──
      acc.isVerified = !!cell.querySelector(SEL.verifiedBadge);

      // ── Default avatar ──
      const avatarImg = cell.querySelector(SEL.avatarImg);
      acc.hasDefaultAvatar = this._isDefaultAvatar(avatarImg);

      return acc;
    },

    _isDefaultAvatar(img) {
      if (!img) return false;
      const src = img.getAttribute('src') || '';
      return src.includes('default_profile') || src.includes('/placeholder') || src === '';
    },

    // Re-query the unfollow button fresh at execution time
    findUnfollowBtn(cell, username) {
      if (username) {
        const el = cell.querySelector(`[data-testid="${username}-unfollow"]`);
        if (el) return el;
      }
      for (const btn of cell.querySelectorAll('button')) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text  = btn.textContent.trim().toLowerCase();
        if (label.startsWith('following @') || text === 'following') return btn;
      }
      return null;
    },

    collectCells() {
      return Array.from(document.querySelectorAll(SEL.userCell));
    },
  };

  // ============================================================
  // PROFILE FETCHER — lightweight async fetch for extra data
  // Results cached in sessionStorage to avoid re-fetching.
  // ============================================================
  const Fetcher = {
    cache: new Map(),

    async fetchProfile(username) {
      if (this.cache.has(username)) return this.cache.get(username);

      try {
        const res = await fetch(`https://x.com/${username}`, { credentials: 'include' });
        const html = await res.text();
        const data = this._parse(html, username);
        this.cache.set(username, data);
        return data;
      } catch {
        return null;
      }
    },

    _parse(html, username) {
      // Extract __NEXT_DATA__ JSON embedded in the page
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) return this._parseMeta(html);

      try {
        const json = JSON.parse(match[1]);
        // Traverse to user entity
        const user = this._findUser(json, username);
        if (!user) return null;

        const created = user.created_at ? new Date(user.created_at) : null;
        const now = new Date();
        const accountAgeMonths = created
          ? Math.floor((now - created) / (1000 * 60 * 60 * 24 * 30))
          : null;

        return {
          followers: user.followers_count ?? null,
          following: user.friends_count ?? null,
          isFollowingBack: user.followed_by ?? null,
          accountAgeMonths,
          daysSinceLastPost: this._daysSince(user.status?.created_at),
        };
      } catch {
        return this._parseMeta(html);
      }
    },

    _findUser(obj, username) {
      if (obj && typeof obj === 'object') {
        if (obj.screen_name?.toLowerCase() === username) return obj;
        for (const v of Object.values(obj)) {
          const found = this._findUser(v, username);
          if (found) return found;
        }
      }
      return null;
    },

    _parseMeta(html) {
      // Fallback: extract follower count from og:description meta tag
      // "X followers, Y following, Z Tweets"
      const m = html.match(/(\d[\d,]*)\s+Followers/i);
      return m ? { followers: parseInt(m[1].replace(/,/g, ''), 10), following: null, isFollowingBack: null, accountAgeMonths: null, daysSinceLastPost: null } : null;
    },

    _daysSince(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      return Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
    },
  };

  // ============================================================
  // FILTER ENGINE
  // Returns true if account SHOULD be unfollowed.
  // ============================================================
  const Filters = {
    evaluate(acc, filters, whitelist) {
      // Whitelist always wins
      if (acc.username && whitelist.includes(acc.username.toLowerCase())) return false;

      // Bio whitelist protection
      if (filters.bioWhitelist.length) {
        const bioLow = acc.bio.toLowerCase();
        for (const kw of filters.bioWhitelist) {
          if (kw && bioLow.includes(kw.toLowerCase())) return false;
        }
      }

      // Verified protection
      if (filters.excludeVerified && acc.isVerified) return false;

      let flag = false;

      // Default avatar
      if (filters.defaultAvatar && acc.hasDefaultAvatar) {
        flag = true;
        acc.reason = 'Default avatar';
      }

      // Bio blacklist
      if (filters.bioBlacklist.length) {
        const bioLow = acc.bio.toLowerCase();
        for (const kw of filters.bioBlacklist) {
          if (kw && bioLow.includes(kw.toLowerCase())) {
            flag = true;
            acc.reason = `Bio: "${kw}"`;
            break;
          }
        }
      }

      // === Profile-data-dependent filters ===
      const pd = acc.profileData;
      if (pd) {
        // Protect big accounts
        if (filters.minFollowerProtect > 0 && pd.followers >= filters.minFollowerProtect) return false;

        // Protect mutuals
        if (filters.protectMutuals && pd.isFollowingBack === true) return false;

        // Not following back
        if (filters.notFollowingBack && pd.isFollowingBack === false) {
          flag = true;
          acc.reason = acc.reason || 'Not following back';
        }

        // Inactivity
        if (filters.inactiveDays > 0 && pd.daysSinceLastPost !== null && pd.daysSinceLastPost > filters.inactiveDays) {
          flag = true;
          acc.reason = acc.reason || `Inactive ${pd.daysSinceLastPost}d`;
        }

        // Follower ratio
        if (filters.followerRatioBelow > 0 && pd.followers !== null && pd.following !== null) {
          const ratio = pd.following > 0 ? pd.followers / pd.following : 0;
          if (ratio < filters.followerRatioBelow) {
            flag = true;
            acc.reason = acc.reason || `Ratio ${ratio.toFixed(2)}`;
          }
        }

        // Account age (unfollow if account is too new)
        if (filters.accountAgeMonths > 0 && pd.accountAgeMonths !== null && pd.accountAgeMonths < filters.accountAgeMonths) {
          flag = true;
          acc.reason = acc.reason || `New acct (${pd.accountAgeMonths}mo)`;
        }
      }

      return flag;
    },
  };

  // ============================================================
  // SAFETY — delays and heat meter
  // ============================================================
  const Safety = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    randomDelay(minSec, maxSec) {
      const lo = (minSec || 5) * 1000;
      const hi = (maxSec || 15) * 1000;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },

    heatLevel(dailyLimit) {
      if (dailyLimit <= 50)  return { label: 'Safe',     color: '#22c55e', width: '25%' };
      if (dailyLimit <= 100) return { label: 'Moderate', color: '#f59e0b', width: '55%' };
      if (dailyLimit <= 150) return { label: 'Elevated', color: '#ef4444', width: '80%' };
      return                        { label: 'Danger',   color: '#7f1d1d', width: '100%' };
    },
  };

  // ============================================================
  // UNFOLLOW ENGINE
  // ============================================================
  const Engine = {
    async unfollowOne(acc) {
      // Re-query button at execution time (DOM may have changed)
      const cell = acc.element;
      let btn = Scraper.findUnfollowBtn(cell, acc.username);
      if (!btn) {
        console.warn('[X-Purge] No unfollow button for', acc.username);
        return false;
      }

      try {
        btn.click(); // Opens "Unfollow?" modal

        // Wait for confirm dialog
        const confirmBtn = await this._waitFor(SEL.confirmBtn, 5000);
        if (!confirmBtn) {
          // Dismiss any accidental modal
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return false;
        }

        confirmBtn.click();
        await Safety.sleep(800);
        return true;
      } catch (e) {
        console.error('[X-Purge] unfollowOne error:', e);
        return false;
      }
    },

    _waitFor(selector, timeout) {
      return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);

        const obs = new MutationObserver(() => {
          const found = document.querySelector(selector);
          if (found) { obs.disconnect(); resolve(found); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
      });
    },

    async run(targets, filters, isDryRun, callbacks) {
      const { onProgress, onDone } = callbacks;
      let unfollowed = 0;
      let batchCount = 0;

      for (let i = 0; i < targets.length; i++) {
        if (!state.running) break;

        const acc = targets[i];
        const daily = await SW.getDailyCount();

        if (daily >= filters.dailyLimit) {
          onProgress({ action: `Daily limit (${filters.dailyLimit}) reached`, unfollowed, total: targets.length });
          break;
        }

        onProgress({ action: `Unfollowing @${acc.username}…`, unfollowed, total: targets.length, next: targets[i + 1]?.username });

        const success = isDryRun ? true : await this.unfollowOne(acc);
        if (success) {
          unfollowed++;
          batchCount++;
          if (!isDryRun) await SW.incrementDaily();
        }

        // Batch break every batchSize unfollows
        if (batchCount > 0 && batchCount % filters.batchSize === 0 && i < targets.length - 1) {
          const breakMs = isDryRun ? 300 : 15 * 60 * 1000;
          onProgress({ action: `Batch break: resting 15min after ${batchCount}…`, unfollowed, total: targets.length });
          await Safety.sleep(breakMs);
        } else {
          const delay = Safety.randomDelay(filters.minDelay, filters.maxDelay);
          onProgress({ action: `Waiting ${(delay / 1000).toFixed(1)}s…`, unfollowed, total: targets.length, next: targets[i + 1]?.username });
          await Safety.sleep(isDryRun ? 150 : delay);
        }
      }

      state.running = false;
      onDone(unfollowed);
    },
  };

  // ============================================================
  // AUTO-SCROLL OBSERVER
  // Appends a sentinel at bottom of timeline; fires callback
  // whenever it enters the viewport (triggers X's lazy load).
  // ============================================================
  const ScrollObs = {
    _obs: null,
    _sentinel: null,

    start(onVisible) {
      const container = document.querySelector(SEL.primaryColumn) || document.querySelector('main');
      if (!container) return;

      this._sentinel = document.createElement('div');
      this._sentinel.id = 'xpurge-sentinel';
      container.appendChild(this._sentinel);

      this._obs = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) onVisible();
      }, { threshold: 0.1 });
      this._obs.observe(this._sentinel);
    },

    stop() {
      if (this._obs) { this._obs.disconnect(); this._obs = null; }
      if (this._sentinel?.parentNode) { this._sentinel.remove(); this._sentinel = null; }
    },
  };

  // ============================================================
  // SLIDER CHECKPOINTS
  // Each entry: { values[], labels[], def (default index) }
  // ============================================================
  const SLIDERS = {
    'f-followedMonthsAgo': {
      values: [0, 1, 2, 3, 6, 12, 18, 24, 36],
      labels: ['Off', '1mo', '2mo', '3mo', '6mo', '1yr', '18mo', '2yr', '3yr'],
      def: 0,
    },
    'f-inactiveDays': {
      values: [0, 7, 14, 30, 60, 90, 180, 365, 730],
      labels: ['Off', '7d', '2wk', '30d', '60d', '90d', '6mo', '1yr', '2yr'],
      def: 0,
    },
    'f-followerRatioBelow': {
      values: [0, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      labels: ['Off', '0.1', '0.25', '0.5', '1:1', '2:1', '5:1', '10:1'],
      def: 0,
    },
    'f-minFollowerProtect': {
      values: [0, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
      labels: ['Off', '100', '500', '1K', '5K', '10K', '50K', '100K', '500K', '1M+'],
      def: 0,
    },
    'f-accountAgeMonths': {
      values: [0, 1, 3, 6, 12, 24, 36],
      labels: ['Off', '1mo', '3mo', '6mo', '1yr', '2yr', '3yr'],
      def: 0,
    },
    'f-dailyLimit': {
      values: [10, 25, 50, 75, 100, 150, 200, 300, 400],
      labels: ['10', '25', '50', '75', '100', '150', '200', '300', '400'],
      def: 2, // 50
    },
    'f-minDelay': {
      values: [2, 3, 5, 7, 10, 15, 20, 30],
      labels: ['2s', '3s', '5s', '7s', '10s', '15s', '20s', '30s'],
      def: 2, // 5s
    },
    'f-maxDelay': {
      values: [3, 5, 7, 10, 15, 20, 30, 45, 60],
      labels: ['3s', '5s', '7s', '10s', '15s', '20s', '30s', '45s', '60s'],
      def: 4, // 15s
    },
    'f-batchSize': {
      values: [5, 10, 15, 20, 25, 30, 40, 50],
      labels: ['5', '10', '15', '20', '25', '30', '40', '50'],
      def: 1, // 10
    },
  };

  // Read the actual numeric value from a slider
  function sliderVal(id) {
    const el = document.getElementById(id);
    const cfg = SLIDERS[id];
    if (!el || !cfg) return 0;
    return cfg.values[parseInt(el.value, 10)] ?? 0;
  }

  // Set a slider to the checkpoint nearest to `value` and update its label
  function setSlider(id, value) {
    const el = document.getElementById(id);
    const cfg = SLIDERS[id];
    if (!el || !cfg) return;
    let idx = 0, best = Infinity;
    cfg.values.forEach((v, i) => { const d = Math.abs(v - value); if (d < best) { best = d; idx = i; } });
    el.value = idx;
    const lbl = document.getElementById(`${id}-val`);
    if (lbl) lbl.textContent = cfg.labels[idx];
    _paintSlider(el);
  }

  // Fill the track left of the thumb with accent colour
  function _paintSlider(el) {
    const pct = parseInt(el.max) > 0 ? (parseInt(el.value) / parseInt(el.max)) * 100 : 0;
    el.style.background = `linear-gradient(to right, #1d9bf0 ${pct}%, #2f3336 ${pct}%)`;
  }

  // Wire up live label + fill updates for a slider
  function initSlider(id, onChange) {
    const el = document.getElementById(id);
    const cfg = SLIDERS[id];
    if (!el || !cfg) return;
    el.addEventListener('input', () => {
      const lbl = document.getElementById(`${id}-val`);
      if (lbl) lbl.textContent = cfg.labels[parseInt(el.value, 10)];
      _paintSlider(el);
      if (onChange) onChange();
    });
    _paintSlider(el); // paint initial state
  }

  // ============================================================
  // UI — side-panel overlay injected into the page
  // ============================================================
  const UI = {
    panel: null,

    inject() {
      if (document.getElementById('xpurge-panel')) return;
      const div = document.createElement('div');
      div.id = 'xpurge-panel';
      div.innerHTML = this._html();
      document.body.appendChild(div);
      this.panel = div;
      this._bind();
      this._loadSaved();
    },

    remove() {
      document.getElementById('xpurge-panel')?.remove();
      this.panel = null;
    },

    // ---- HTML template ----
    // Slider rows are generated via _sl(id, label) for DRY markup.
    _sl(id, label) {
      const cfg = SLIDERS[id];
      const max = cfg.values.length - 1;
      return `
        <div class="xp-sf">
          <div class="xp-sfrow">
            <span class="xp-sflabel">${label}</span>
            <span class="xp-val" id="${id}-val">${cfg.labels[cfg.def]}</span>
          </div>
          <input type="range" id="${id}" class="xp-slider" min="0" max="${max}" value="${cfg.def}">
        </div>`;
    },

    _html() {
      const sl = (id, label) => this._sl(id, label);
      return `
<div id="xpurge-inner">
  <div id="xpurge-header">
    <span id="xpurge-title">⚡ X-Purge</span>
    <button id="xpurge-close" title="Close">✕</button>
  </div>

  <div id="xpurge-body">

    <!-- Relationship -->
    <div class="xp-section">
      <div class="xp-section-title">Relationship</div>
      <label class="xp-row"><input type="checkbox" id="f-notFollowingBack"> Not following back</label>
      <label class="xp-row"><input type="checkbox" id="f-protectMutuals" checked> Protect mutuals</label>
      ${sl('f-followedMonthsAgo', 'Followed more than … ago')}
    </div>

    <!-- Activity -->
    <div class="xp-section">
      <div class="xp-section-title">Activity <span class="xp-hint">(requires scan)</span></div>
      ${sl('f-inactiveDays', 'Inactive for more than')}
    </div>

    <!-- Profile Quality -->
    <div class="xp-section">
      <div class="xp-section-title">Profile Quality</div>
      <label class="xp-row"><input type="checkbox" id="f-defaultAvatar"> Default avatar (egg)</label>
      <label class="xp-row"><input type="checkbox" id="f-excludeVerified"> Exclude verified ✓</label>
      ${sl('f-followerRatioBelow', 'Follower ratio below')}
      ${sl('f-minFollowerProtect', 'Protect if followers ≥')}
      ${sl('f-accountAgeMonths', 'Account age below')}
    </div>

    <!-- Keywords -->
    <div class="xp-section">
      <div class="xp-section-title">Bio Keywords</div>
      <div class="xp-kw-row">
        <span class="xp-kw-label">Blacklist</span>
        <input type="text" id="f-bioBlacklist" placeholder="crypto, nft, bot" class="xp-text">
      </div>
      <div class="xp-kw-row">
        <span class="xp-kw-label">Whitelist</span>
        <input type="text" id="f-bioWhitelist" placeholder="founder, vc, engineer" class="xp-text">
      </div>
    </div>

    <!-- Safety -->
    <div class="xp-section">
      <div class="xp-section-title">Safety</div>
      ${sl('f-dailyLimit', 'Daily limit')}
      ${sl('f-minDelay',   'Min delay')}
      ${sl('f-maxDelay',   'Max delay')}
      ${sl('f-batchSize',  'Batch size')}
      <div id="xpurge-heat">
        <span id="heat-label">Safe</span>
        <div id="heat-bar-bg"><div id="heat-bar"></div></div>
      </div>
    </div>

    <!-- Whitelist Manager -->
    <div class="xp-section">
      <div class="xp-section-title">Global Whitelist <span class="xp-hint">(never unfollow)</span></div>
      <div class="xp-row xp-inline">
        <input type="text" id="wl-input" placeholder="@username" class="xp-text-sm">
        <button id="wl-add" class="xp-btn-sm">Add</button>
      </div>
      <div id="wl-list"></div>
    </div>

    <!-- Action buttons -->
    <div id="xpurge-actions">
      <button id="btn-scan" class="xp-btn xp-btn-secondary">Dry Run / Scan</button>
      <button id="btn-purge" class="xp-btn xp-btn-danger">Start Purge</button>
    </div>

    <div id="btn-stop-wrap" style="display:none">
      <button id="btn-stop" class="xp-btn xp-btn-secondary">⏹ Stop</button>
    </div>

  </div><!-- /body -->

  <!-- Progress bar -->
  <div id="xpurge-progress" style="display:none">
    <div id="prog-action">Idle</div>
    <div id="prog-bar-bg"><div id="prog-bar"></div></div>
    <div id="prog-stats">0 / 0 unfollowed</div>
    <div id="prog-next"></div>
  </div>

  <!-- Results -->
  <div id="xpurge-results" style="display:none">
    <div class="xp-section-title">Scan Results (<span id="result-count">0</span> targets)</div>
    <ul id="result-list"></ul>
  </div>

</div><!-- /inner -->
      `;
    },

    // ---- Bind events ----
    _bind() {
      // Close
      document.getElementById('xpurge-close').addEventListener('click', () => this.remove());

      // Init all sliders (live label + fill; heat meter on dailyLimit change)
      Object.keys(SLIDERS).forEach(id => {
        initSlider(id, id === 'f-dailyLimit' ? () => this._updateHeat() : null);
      });

      // Whitelist add
      document.getElementById('wl-add').addEventListener('click', async () => {
        const input = document.getElementById('wl-input');
        const val = input.value.replace('@', '').trim().toLowerCase();
        if (!val) return;
        await SW.addWhitelist(val);
        input.value = '';
        this._renderWhitelist();
      });

      // Scan (dry run)
      document.getElementById('btn-scan').addEventListener('click', () => this._startScan(true));

      // Purge
      document.getElementById('btn-purge').addEventListener('click', () => this._startScan(false));

      // Stop
      document.getElementById('btn-stop').addEventListener('click', () => {
        state.running = false;
        state.scanning = false;
        this._updateAction('Stopped.');
      });
    },

    async _loadSaved() {
      const saved = await SW.getFilters();
      if (saved) {
        state.filters = { ...state.filters, ...saved };
        this._fillForm(state.filters);
      }
      state.whitelist = await SW.getWhitelist();
      state.dailyCount = await SW.getDailyCount();
      this._renderWhitelist();
      this._updateHeat();
    },

    _fillForm(f) {
      const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
      const txt = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

      chk('f-notFollowingBack', f.notFollowingBack);
      chk('f-protectMutuals',   f.protectMutuals);
      chk('f-defaultAvatar',    f.defaultAvatar);
      chk('f-excludeVerified',  f.excludeVerified);

      setSlider('f-followedMonthsAgo',  f.followedMonthsAgo);
      setSlider('f-inactiveDays',       f.inactiveDays);
      setSlider('f-followerRatioBelow', f.followerRatioBelow);
      setSlider('f-minFollowerProtect', f.minFollowerProtect);
      setSlider('f-accountAgeMonths',   f.accountAgeMonths);
      setSlider('f-dailyLimit',         f.dailyLimit);
      setSlider('f-minDelay',           f.minDelay);
      setSlider('f-maxDelay',           f.maxDelay);
      setSlider('f-batchSize',          f.batchSize);

      txt('f-bioBlacklist', f.bioBlacklist.join(', '));
      txt('f-bioWhitelist', f.bioWhitelist.join(', '));
    },

    _readForm() {
      const b   = (id) => !!document.getElementById(id)?.checked;
      const txt = (id) => document.getElementById(id)?.value ?? '';
      const kws = (id) => txt(id).split(',').map(s => s.trim()).filter(Boolean);

      return {
        notFollowingBack:    b('f-notFollowingBack'),
        protectMutuals:      b('f-protectMutuals'),
        followedMonthsAgo:   sliderVal('f-followedMonthsAgo'),
        inactiveDays:        sliderVal('f-inactiveDays'),
        defaultAvatar:       b('f-defaultAvatar'),
        excludeVerified:     b('f-excludeVerified'),
        followerRatioBelow:  sliderVal('f-followerRatioBelow'),
        minFollowerProtect:  sliderVal('f-minFollowerProtect'),
        accountAgeMonths:    sliderVal('f-accountAgeMonths'),
        bioBlacklist:        kws('f-bioBlacklist'),
        bioWhitelist:        kws('f-bioWhitelist'),
        dailyLimit:          sliderVal('f-dailyLimit') || 50,
        minDelay:            sliderVal('f-minDelay')   || 5,
        maxDelay:            sliderVal('f-maxDelay')   || 15,
        batchSize:           sliderVal('f-batchSize')  || 10,
      };
    },

    _updateHeat() {
      const limit = sliderVal('f-dailyLimit') || 50;
      const heat = Safety.heatLevel(limit);
      const label = document.getElementById('heat-label');
      const bar = document.getElementById('heat-bar');
      if (label) label.textContent = heat.label;
      if (bar) {
        bar.style.width = heat.width;
        bar.style.backgroundColor = heat.color;
      }
    },

    async _renderWhitelist() {
      state.whitelist = await SW.getWhitelist();
      const list = document.getElementById('wl-list');
      if (!list) return;
      if (!state.whitelist.length) { list.innerHTML = '<span class="xp-hint">Empty</span>'; return; }
      list.innerHTML = state.whitelist.map(u =>
        `<span class="wl-tag">@${u} <button class="wl-remove" data-u="${u}">×</button></span>`
      ).join('');
      list.querySelectorAll('.wl-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await SW.removeWhitelist(btn.dataset.u);
          this._renderWhitelist();
        });
      });
    },

    // Returns true if at least one filter is active
    _anyFilterActive(f) {
      return f.notFollowingBack || f.defaultAvatar || f.excludeVerified ||
             f.followedMonthsAgo > 0 || f.inactiveDays > 0 ||
             f.followerRatioBelow > 0 || f.minFollowerProtect > 0 ||
             f.accountAgeMonths > 0 || f.bioBlacklist.length > 0;
    },

    // ---- Scan / Purge flow ----
    async _startScan(dryRun) {
      if (state.running || state.scanning) return;

      state.filters = this._readForm();

      // Warn if no filters are enabled — nothing will match
      if (!this._anyFilterActive(state.filters)) {
        this._updateAction('⚠ No filters enabled — enable at least one filter above.');
        document.getElementById('xpurge-progress').style.display = 'block';
        document.getElementById('btn-stop-wrap').style.display = 'none';
        return;
      }

      await SW.saveFilters(state.filters);
      state.whitelist = await SW.getWhitelist();
      state.dailyCount = await SW.getDailyCount();
      state.dryRun = dryRun;
      state.scanned = [];
      state.targets = [];

      document.getElementById('xpurge-results').style.display = 'none';
      document.getElementById('xpurge-progress').style.display = 'block';
      document.getElementById('btn-stop-wrap').style.display = 'block';
      document.getElementById('xpurge-actions').style.display = 'none';

      this._updateAction(dryRun ? 'Scanning (dry run)…' : 'Scanning before purge…');

      // Phase 1: scroll and collect all accounts via MutationObserver
      state.scanning = true;
      await this._scrollAndCollect();

      if (!state.scanning) return; // stopped

      // Phase 2: deep-fetch profiles if needed
      const needsFetch = state.filters.notFollowingBack || state.filters.inactiveDays > 0 ||
        state.filters.followerRatioBelow > 0 || state.filters.minFollowerProtect > 0 ||
        state.filters.accountAgeMonths > 0;

      if (needsFetch) {
        await this._deepFetchAll();
      }

      // Phase 3: apply filters
      state.targets = state.scanned.filter(acc => Filters.evaluate(acc, state.filters, state.whitelist));

      this._showResults(state.targets);

      // Update progress stats to show scan summary
      const statsEl = document.getElementById('prog-stats');
      if (statsEl) statsEl.textContent = `Scanned ${state.scanned.length} accounts — ${state.targets.length} match filters`;

      if (dryRun) {
        this._finishUI(`Dry run complete: ${state.targets.length} of ${state.scanned.length} accounts would be unfollowed.`);
        return;
      }

      // Phase 4: execute unfollows
      state.running = true;
      state.scanning = false;
      await Engine.run(
        state.targets,
        state.filters,
        false,
        {
          onProgress: ({ action, unfollowed, total, next }) => {
            this._updateAction(action);
            this._updateProgress(unfollowed, total, next);
          },
          onDone: (count) => {
            this._finishUI(`Done! Unfollowed ${count} accounts today.`);
          },
        }
      );
    },

    async _scrollAndCollect() {
      const seenUsernames = new Set();

      // Harvest every currently visible UserCell that hasn't been processed yet
      const harvest = () => {
        let newFound = 0;
        for (const cell of document.querySelectorAll(SEL.userCell)) {
          if (cell._xpScanned) continue;
          cell._xpScanned = true;
          const acc = Scraper.fromCell(cell);
          if (acc.username && !seenUsernames.has(acc.username)) {
            seenUsernames.add(acc.username);
            state.scanned.push(acc);
            newFound++;
          }
        }
        return newFound;
      };

      // Scroll both the window AND the inner container X uses
      const scrollDown = () => {
        const inner = document.querySelector('[data-testid="primaryColumn"]') ||
                      document.querySelector('main');
        window.scrollBy(0, 1200);
        if (inner) inner.scrollTop += 1200;
      };

      return new Promise((resolve) => {
        let noNewStreak = 0;
        const MAX_EMPTY = 4; // 4 × 1.5s = 6s of no new accounts before stopping

        // MutationObserver fires as soon as X appends new rows to the DOM
        const mo = new MutationObserver(() => {
          const n = harvest();
          if (n > 0) {
            noNewStreak = 0;
            this._updateAction(`Scanning… ${state.scanned.length} accounts found`);
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });

        const tick = () => {
          if (!state.scanning) { mo.disconnect(); resolve(); return; }

          const before = state.scanned.length;
          harvest();
          scrollDown();

          setTimeout(() => {
            if (!state.scanning) { mo.disconnect(); resolve(); return; }

            if (state.scanned.length === before) {
              noNewStreak++;
            } else {
              noNewStreak = 0;
            }

            this._updateAction(`Scanning… ${state.scanned.length} accounts found`);

            if (noNewStreak >= MAX_EMPTY) {
              mo.disconnect();
              resolve();
            } else {
              tick();
            }
          }, 1500);
        };

        harvest(); // grab what's already on screen before first scroll
        tick();
      });
    },

    async _deepFetchAll() {
      const total = state.scanned.length;
      for (let i = 0; i < total; i++) {
        if (!state.scanning) break;
        const acc = state.scanned[i];
        if (acc.username) {
          this._updateAction(`Fetching profile ${i + 1}/${total}: @${acc.username}`);
          acc.profileData = await Fetcher.fetchProfile(acc.username);
          await Safety.sleep(400); // gentle pacing
        }
      }
    },

    _showResults(targets) {
      const wrap = document.getElementById('xpurge-results');
      const list = document.getElementById('result-list');
      const count = document.getElementById('result-count');
      wrap.style.display = 'block';
      count.textContent = targets.length;
      list.innerHTML = targets.slice(0, 50).map(acc =>
        `<li class="result-item">
          <span class="result-name">@${acc.username}</span>
          <span class="result-reason">${acc.reason || ''}</span>
        </li>`
      ).join('') + (targets.length > 50 ? `<li class="xp-hint">…and ${targets.length - 50} more</li>` : '');
    },

    _updateAction(text) {
      const el = document.getElementById('prog-action');
      if (el) el.textContent = text;
    },

    _updateProgress(unfollowed, total, next) {
      const bar = document.getElementById('prog-bar');
      const stats = document.getElementById('prog-stats');
      const nextEl = document.getElementById('prog-next');
      const pct = total > 0 ? Math.round((unfollowed / total) * 100) : 0;
      if (bar) bar.style.width = pct + '%';
      if (stats) stats.textContent = `${unfollowed} / ${total} unfollowed`;
      if (nextEl) nextEl.textContent = next ? `Next: @${next}` : '';
    },

    _finishUI(msg) {
      state.running = false;
      state.scanning = false;
      this._updateAction(msg);
      document.getElementById('btn-stop-wrap').style.display = 'none';
      document.getElementById('xpurge-actions').style.display = 'flex';
    },
  };

  // ============================================================
  // ROUTER — watch for SPA navigation to /following
  // ============================================================
  function isFollowingPage() {
    return /\/(following|followers_you_follow)\/?$/.test(location.pathname);
  }

  function onNavChange() {
    if (isFollowingPage()) {
      if (!document.getElementById('xpurge-panel')) {
        // Small delay for React to render the page
        setTimeout(() => UI.inject(), 1200);
      }
    } else {
      UI.remove();
    }
  }

  // Patch pushState / replaceState to catch SPA navigation
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = (...a) => { _push(...a); onNavChange(); };
  history.replaceState = (...a) => { _replace(...a); onNavChange(); };
  window.addEventListener('popstate', onNavChange);

  // ── Message listener (from popup) ──────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE_PANEL') {
      const panel = document.getElementById('xpurge-panel');
      if (panel) {
        UI.remove();
      } else if (isFollowingPage()) {
        UI.inject();
      } else {
        // Navigate to /following and the router will inject the panel
        history.pushState({}, '', '/following');
        onNavChange();
      }
      sendResponse({ ok: true });
    }
  });

  // Initial check
  onNavChange();
})();
