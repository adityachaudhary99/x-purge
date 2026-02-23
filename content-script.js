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
      scanLimit: 250,              // 0 = scan all
    };
  }

  // ============================================================
  // CHROME MESSAGING (to service worker)
  // ============================================================
  const SW = {
    send(msg) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, (res) => {
            if (chrome.runtime.lastError) resolve(null); // stale context — graceful fallback
            else resolve(res);
          });
        } catch { resolve(null); } // context fully invalidated
      });
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
  // API INTERCEPTOR — receives data relayed from page-bridge.js
  // page-bridge.js patches window.fetch in the MAIN world and
  // postMessages every GraphQL "Following" response back here.
  // Also receives API_CREDENTIALS (queryId, features, authorization)
  // from the first organic Following request so we can make direct
  // API calls for scanning and unfollowing without DOM scrolling.
  // ============================================================
  const APIInterceptor = {
    _listeners: new Set(),
    _auth:   null,  // full scan credentials: { queryId, features, userId, authorization }
    _bearer: null,  // just the Bearer token — available earlier, used for direct unfollow

    // Subscribe a callback; called each time a batch of users arrives
    subscribe(fn) { this._listeners.add(fn); },
    unsubscribe(fn) { this._listeners.delete(fn); },

    // Parse a GraphQL Following response into our account objects
    parseResponse(json) {
      const accounts = [];
      try {
        // Walk the timeline instructions to find user entries
        const instructions =
          json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
          json?.data?.user?.result?.timeline?.timeline?.instructions ?? [];

        for (const instr of instructions) {
          if (instr.type !== 'TimelineAddEntries' && instr.type !== 'TimelineAddToModule') continue;
          const entries = instr.entries ?? instr.moduleItems ?? [];
          for (const entry of entries) {
            const item = entry?.content?.itemContent ?? entry?.item?.itemContent;
            const userResult = item?.user_results?.result;
            if (!userResult) continue;
            const acc = this._fromUserResult(userResult);
            if (acc) accounts.push(acc);
          }
        }
      } catch (e) {
        console.warn('[X-Purge] GraphQL parse error:', e);
      }
      return accounts;
    },

    _fromUserResult(result) {
      const legacy = result?.legacy;
      // X moved screen_name / name / created_at from legacy → result.core
      const core = result?.core;
      const screenName = core?.screen_name ?? legacy?.screen_name;
      if (!screenName) return null;

      const now = Date.now();
      // created_at is now in core; keep legacy fallback for older API versions
      const created = (core?.created_at || legacy?.created_at)
        ? new Date(core?.created_at ?? legacy?.created_at) : null;
      // X's Following endpoint rarely includes the latest tweet.
      // Fall back to statuses_count === 0 → treat as never tweeted (infinite inactivity).
      const lastTweet = legacy?.status?.created_at ? new Date(legacy.status.created_at) : null;
      const neverTweeted = !lastTweet && legacy?.statuses_count === 0;

      // followed_by moved to result.relationship_perspectives in newer API
      const relPersp = result?.relationship_perspectives;
      const isFollowingBack = relPersp?.followed_by ?? legacy?.followed_by ?? null;

      return {
        username: screenName.toLowerCase(),
        restId: result.rest_id ?? null,  // Twitter user ID — used for direct API unfollow
        displayName: core?.name ?? legacy?.name ?? '',
        bio: legacy?.description ?? '',
        isVerified: !!(legacy?.verified || result.is_blue_verified),
        hasDefaultAvatar: !!legacy?.default_profile_image,
        reason: null,
        element: null,   // resolved later from DOM when unfollowing
        profileData: {
          followers:       legacy?.followers_count ?? null,
          following:       legacy?.friends_count   ?? null,
          isFollowingBack,
          accountAgeMonths: created
            ? Math.floor((now - created) / (1000 * 60 * 60 * 24 * 30))
            : null,
          // 9999 = never tweeted; null = we simply don't know
          daysSinceLastPost: lastTweet
            ? Math.floor((now - lastTweet) / (1000 * 60 * 60 * 24))
            : neverTweeted ? 9999 : null,
        },
      };
    },
  };

  // ============================================================
  // DIRECT FETCHER — uses captured auth to hit X's API without scrolling
  // ============================================================
  const DirectFetcher = {
    _ct0() {
      return document.cookie.match(/(?:^|;\s*)ct0=([A-Za-z0-9]+)/)?.[1] ?? null;
    },

    // Fetch one page of the Following list.
    // cursor = null → first page; pass the Bottom cursor for subsequent pages.
    async fetchFollowingPage(cursor) {
      const auth = APIInterceptor._auth;
      const ct0  = this._ct0();
      if (!auth?.queryId || !auth?.userId || !ct0) return null;

      const vars = { userId: auth.userId, count: 200, includePromotedContent: false };
      if (cursor) vars.cursor = cursor;

      const url = `https://x.com/i/api/graphql/${auth.queryId}/Following` +
        `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
        (auth.features ? `&features=${encodeURIComponent(auth.features)}` : '');

      try {
        const resp = await fetch(url, {
          headers: {
            'Authorization':          auth.authorization,
            'X-Csrf-Token':           ct0,
            'X-Twitter-Active-User':  'yes',
            'X-Twitter-Auth-Type':    'OAuth2Session',
          },
          credentials: 'include',
        });
        if (!resp.ok) { console.warn('[X-Purge] DirectFetcher HTTP', resp.status); return null; }
        return resp.json();
      } catch (e) { console.warn('[X-Purge] DirectFetcher error:', e); return null; }
    },

    // Extract the "Bottom" cursor from a GraphQL response for the next page.
    extractCursor(json) {
      const instructions =
        json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
        json?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
      for (const instr of instructions) {
        for (const entry of (instr.entries ?? [])) {
          const c = entry.content;
          if (c?.cursorType === 'Bottom') return c.value;
        }
      }
      return null;
    },

    // Unfollow a user by their Twitter rest_id (numeric user ID).
    // Only needs the Bearer token + ct0 cookie — no queryId/userId required.
    // Returns true on success.
    async unfollowUser(restId) {
      const bearer = APIInterceptor._bearer || APIInterceptor._auth?.authorization;
      const ct0    = this._ct0();
      if (!restId || !ct0 || !bearer) return false;
      try {
        const resp = await fetch('https://x.com/i/api/1.1/friendships/destroy.json', {
          method: 'POST',
          headers: {
            'Authorization':          bearer,
            'X-Csrf-Token':           ct0,
            'Content-Type':           'application/x-www-form-urlencoded',
            'X-Twitter-Active-User':  'yes',
            'X-Twitter-Auth-Type':    'OAuth2Session',
          },
          credentials: 'include',
          body: `user_id=${restId}`,
        });
        return resp.ok;
      } catch { return false; }
    },
  };

  // Route postMessages from page-bridge.js → APIInterceptor
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.__xpurge === 'FOLLOWING_PAGE') {
      const accounts = APIInterceptor.parseResponse(event.data.json);
      if (accounts.length) APIInterceptor._listeners.forEach(fn => fn(accounts));
    }
    // Bearer token alone — available early via Headers.prototype.set patching.
    // Enough to unfollow via REST without needing the full scan credentials.
    if (event.data?.__xpurge === 'BEARER_TOKEN') {
      if (!APIInterceptor._bearer) {
        APIInterceptor._bearer = event.data.authorization;
      }
    }
    // Full scan credentials (queryId + userId + bearer) — needed for API scan.
    if (event.data?.__xpurge === 'API_CREDENTIALS') {
      try {
        const { queryId, features, variables, authorization } = event.data;
        const userId = variables ? JSON.parse(variables).userId : null;
        APIInterceptor._auth   = { queryId, features, userId, authorization };
        APIInterceptor._bearer = APIInterceptor._bearer || authorization;
      } catch {}
    }
  });

  // Pull any credentials the bridge already captured before this script loaded.
  // page-bridge.js runs at document_start (MAIN world); we run at document_idle
  // (ISOLATED world). The first organic Following request often fires before our
  // message listener above is registered, so we ask the bridge to re-send.
  window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');

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

    heatLevel(dailyLimit) {
      if (dailyLimit === 0 || dailyLimit > 500) return { label: 'Danger',   color: '#7f1d1d', width: '100%' };
      if (dailyLimit <= 50)  return                    { label: 'Safe',     color: '#22c55e', width: '15%' };
      if (dailyLimit <= 100) return                    { label: 'Moderate', color: '#f59e0b', width: '35%' };
      if (dailyLimit <= 200) return                    { label: 'Elevated', color: '#ef4444', width: '60%' };
      return                                           { label: 'Danger',   color: '#7f1d1d', width: '85%' };
    },
  };

  // ============================================================
  // UNFOLLOW ENGINE
  // ============================================================
  const Engine = {
    async unfollowOne(acc) {
      // ── Fast path: direct REST call — only needs restId + bearer + ct0 ────
      const hasBearer = !!(APIInterceptor._bearer || APIInterceptor._auth?.authorization);
      if (acc.restId && hasBearer) {
        const ok = await DirectFetcher.unfollowUser(acc.restId);
        if (ok) return true;
        console.warn('[X-Purge] Direct API unfollow failed for', acc.username, '— falling back to DOM');
      }

      // ── Slow path: find DOM button and click ──────────────────────────────
      // Used when restId is missing (DOM-only accounts) or API call failed.
      // Use the same regex as Scraper.fromCell so hrefs like
      // /username?referrer=following still match.
      const findBtn = () => {
        for (const cell of document.querySelectorAll(SEL.userCell)) {
          const hasLink = Array.from(cell.querySelectorAll('a[href]')).some(a => {
            const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,50})(?:[/?#].*)?$/);
            return m && m[1].toLowerCase() === acc.username;
          });
          if (!hasLink) continue;
          return Scraper.findUnfollowBtn(cell, acc.username);
        }
        return null;
      };

      let btn = findBtn();
      if (!btn) {
        // X virtualises the Following list — the account cell may not be in the DOM.
        // Scroll from the top in chunks until the cell appears.
        // Use window.scrollY (not col.scrollTop) — X scrolls via window, col.scrollTop stays 0.
        const col = document.querySelector('[data-testid="primaryColumn"]') ||
                    document.querySelector('main');
        window.scrollTo(0, 0);
        if (col) col.scrollTo(0, 0);
        await Safety.sleep(700);
        let lastY = -1;
        for (let i = 0; i < 40 && !btn; i++) {
          btn = findBtn();
          if (btn) break;
          if (window.scrollY === lastY) break; // reached the bottom of the page
          lastY = window.scrollY;
          window.scrollBy(0, 1200);
          if (col) col.scrollBy(0, 1200);
          await Safety.sleep(500);
        }
      }
      if (!btn) {
        console.warn('[X-Purge] No unfollow button found for', acc.username);
        return false;
      }

      try {
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        await Safety.sleep(150);
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
      const { onProgress, onDone, onEach } = callbacks;
      let unfollowed = 0;
      let batchCount = 0;

      for (let i = 0; i < targets.length; i++) {
        if (!state.running) break;

        const acc = targets[i];
        const daily = await SW.getDailyCount();

        if (filters.dailyLimit > 0 && daily >= filters.dailyLimit) {
          onProgress({ action: `Daily limit (${filters.dailyLimit}) reached`, unfollowed, total: targets.length });
          break;
        }

        onProgress({ action: `Unfollowing @${acc.username}…`, unfollowed, total: targets.length, next: targets[i + 1]?.username });

        const success = isDryRun ? true : await this.unfollowOne(acc);
        if (success) {
          unfollowed++;
          batchCount++;
          if (!isDryRun) await SW.incrementDaily();
          if (onEach) onEach(acc, i); // notify UI to remove from list
        }

        // Brief pause every 10 unfollows to avoid rate-limiting (silent — no UI message).
        if (i < targets.length - 1 && batchCount > 0 && batchCount % 10 === 0) {
          await Safety.sleep(isDryRun ? 150 : Math.floor(1000 + Math.random() * 2000));
        }
      }

      state.running = false;
      onDone(unfollowed);
    },
  };

  // (ScrollObs removed — scanning now driven by API interception)

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
      values: [10, 25, 50, 75, 100, 150, 200, 400, 1000, 2000, 0],
      labels: ['10', '25', '50', '75', '100', '150', '200', '400', '1K', '2K', 'All'],
      def: 2, // 50
    },
    'f-scanLimit': {
      values: [50, 100, 250, 500, 1000, 2000, 5000, 0],
      labels: ['50', '100', '250', '500', '1K', '2K', '5K', 'All'],
      def: 2, // 250
    },
  };

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtNum(n) {
    if (n == null) return '?';
    if (n >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'') + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'') + 'K';
    return String(n);
  }

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

  <div id="filters-toggle" class="xp-collapse-hdr">
    Filters <span id="filters-chevron" class="xp-chevron open">▾</span>
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
      ${sl('f-scanLimit',  'Scan limit')}
      ${sl('f-dailyLimit', 'Daily limit')}
      <div id="xpurge-heat">
        <span id="heat-label">Safe</span>
        <div id="heat-bar-bg"><div id="heat-bar"></div></div>
      </div>
      <div id="daily-warn" style="display:none; margin-top:6px; font-size:11px; color:#f59e0b; line-height:1.4">
        &#9888; High limits may trigger X rate-limiting or account restrictions.
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

  </div><!-- /body -->

  <!-- Progress bar -->
  <div id="xpurge-progress" style="display:none">
    <div id="prog-action">Idle</div>
    <div id="prog-bar-bg"><div id="prog-bar"></div></div>
    <div id="prog-stats">0 / 0 unfollowed</div>
    <div id="prog-next"></div>
  </div>

  <!-- Results panel -->
  <div id="xpurge-results" style="display:none">
    <div id="result-hdr">
      <span id="result-count-label">0 accounts match filters</span>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <button id="btn-unfollow-all" class="xp-btn xp-btn-danger" style="display:none">Unfollow All</button>
        <span id="results-chevron" class="xp-chevron open">▾</span>
      </div>
    </div>
    <ul id="result-list"></ul>
  </div>

  <!-- Action buttons (outside body so they stay visible when results are shown) -->
  <div id="xpurge-actions">
    <button id="btn-scan" class="xp-btn xp-btn-secondary">Scan</button>
  </div>

  <div id="btn-stop-wrap" style="display:none">
    <button id="btn-stop" class="xp-btn xp-btn-secondary">⏹ Stop</button>
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

      // Scan — collects following list and shows results for manual review
      document.getElementById('btn-scan').addEventListener('click', () => this._startScan(true));

      // Filters collapse toggle
      document.getElementById('filters-toggle').addEventListener('click', () => {
        const body    = document.getElementById('xpurge-body');
        const chevron = document.getElementById('filters-chevron');
        const isOpen  = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        chevron.classList.toggle('open', !isOpen);
      });

      // Results list collapse toggle (click header, but not the Unfollow All button)
      document.getElementById('result-hdr').addEventListener('click', (e) => {
        if (e.target.closest('#btn-unfollow-all')) return;
        const list    = document.getElementById('result-list');
        const chevron = document.getElementById('results-chevron');
        const isOpen  = list.style.display !== 'none';
        list.style.display = isOpen ? 'none' : 'block';
        chevron.classList.toggle('open', !isOpen);
      });

      // Stop — during scan: stops scroll and shows results with what was collected so far
      //         during purge: aborts the unfollow loop
      document.getElementById('btn-stop').addEventListener('click', () => {
        if (state.scanning) {
          state.scanning = false;
          // _startScan will continue to the filter+results phase automatically
        } else {
          state.running = false;
          this._finishUI('Stopped.');
        }
      });
    },

    async _loadSaved() {
      const saved = await SW.getFilters();
      if (saved === null) return; // context died mid-call
      if (saved) {
        state.filters = { ...state.filters, ...saved };
        this._fillForm(state.filters);
      }
      state.whitelist = (await SW.getWhitelist()) ?? [];
      state.dailyCount = (await SW.getDailyCount()) ?? 0;
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
      setSlider('f-scanLimit',          f.scanLimit);
      setSlider('f-dailyLimit',         f.dailyLimit);

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
        scanLimit:           sliderVal('f-scanLimit'),         // 0 = no limit
        dailyLimit:          sliderVal('f-dailyLimit'),  // 0 = no limit (All)
      };
    },

    _updateHeat() {
      const limit = sliderVal('f-dailyLimit');
      const heat = Safety.heatLevel(limit);
      const label = document.getElementById('heat-label');
      const bar   = document.getElementById('heat-bar');
      const warn  = document.getElementById('daily-warn');
      if (label) label.textContent = heat.label;
      if (bar) { bar.style.width = heat.width; bar.style.backgroundColor = heat.color; }
      if (warn) warn.style.display = (limit === 0 || limit > 200) ? 'block' : 'none';
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

      this._updateAction('Scanning…');

      // Phase 1: scroll + scrape DOM cells; organic API calls triggered by
      // scroll are intercepted by page-bridge.js and enrich account data.
      state.scanning = true;
      await this._scrollAndCollect();
      // scanning may be false here (user stopped or limit hit) — either way,
      // continue to filter + show results with what was collected

      // Phase 2: apply filters
      state.targets = state.scanned.filter(acc => Filters.evaluate(acc, state.filters, state.whitelist));

      const apiEnriched = state.scanned.filter(a => a.profileData).length;
      this._showResults(state.targets, dryRun);

      const statsEl = document.getElementById('prog-stats');
      if (statsEl) statsEl.textContent =
        `Scanned ${state.scanned.length} · ${state.targets.length} match · ${apiEnriched} enriched`;

      this._finishUI(`Scanned ${state.scanned.length} — ${state.targets.length} match filters`);
    },

    // ── Fast path: direct GraphQL pagination, no DOM scrolling ──────────────
    // Used when page-bridge.js has already captured auth credentials from the
    // organic Following request that fires on page load.
    async _scrollAndCollect() {
      const scanLimit = state.filters.scanLimit > 0 ? state.filters.scanLimit : Infinity;

      // Wait for auth credentials if not yet available.
      // X fires the organic Following request as soon as the list renders;
      // we give it up to 5s to arrive before falling back to DOM scroll.
      if (!APIInterceptor._auth) {
        this._updateAction('Waiting for API credentials…');
        await new Promise(resolve => {
          let elapsed = 0;
          const poll = () => {
            if (APIInterceptor._auth || elapsed >= 5000) { resolve(); return; }
            elapsed += 200;
            setTimeout(poll, 200);
          };
          poll();
        });
      }

      if (APIInterceptor._auth) {
        await this._collectViaApi(scanLimit);
      } else {
        console.warn('[X-Purge] API credentials unavailable — falling back to DOM scroll');
        await this._collectViaScroll(scanLimit);
      }
    },

    async _collectViaApi(scanLimit) {
      const seenUsernames = new Set();
      let cursor = null;
      let page = 0;

      while (state.scanning && state.scanned.length < scanLimit) {
        page++;
        this._updateAction(`Scanning… ${state.scanned.length} accounts (API page ${page})`);
        const json = await DirectFetcher.fetchFollowingPage(cursor);
        if (!json) {
          console.warn('[X-Purge] _collectViaApi: fetchFollowingPage returned null', { page, cursor });
          break;
        }

        const accounts = APIInterceptor.parseResponse(json);
        if (!accounts.length) break;

        for (const acc of accounts) {
          if (state.scanned.length >= scanLimit) break;
          if (!seenUsernames.has(acc.username)) {
            seenUsernames.add(acc.username);
            state.scanned.push(acc);
          }
        }

        cursor = DirectFetcher.extractCursor(json);
        if (!cursor) break; // end of list
        await Safety.sleep(300); // brief pause between pages to avoid rate-limits
      }
    },

    // ── Fallback: organic scroll + DOM scrape ───────────────────────────────
    // Keeps working if auth credentials haven't been captured yet.
    // The first organic Following request also triggers API_CREDENTIALS relay
    // so subsequent scans use the fast path above.
    _scrollDown() {
      window.scrollBy(0, 1400);
      const col = document.querySelector('[data-testid="primaryColumn"]') ||
                  document.querySelector('main');
      if (col) col.scrollBy(0, 1400);
    },

    async _collectViaScroll(scanLimit) {
      const seenUsernames = new Set();
      const apiCache = new Map();

      const enrichFrom = (scanned, apiAcc) => {
        scanned.profileData = apiAcc.profileData;
        if (apiAcc.restId)                               scanned.restId          = apiAcc.restId;
        if (typeof apiAcc.hasDefaultAvatar === 'boolean') scanned.hasDefaultAvatar = apiAcc.hasDefaultAvatar;
        if (typeof apiAcc.isVerified       === 'boolean') scanned.isVerified       = apiAcc.isVerified;
        if (apiAcc.bio)         scanned.bio         = apiAcc.bio;
        if (apiAcc.displayName) scanned.displayName = scanned.displayName || apiAcc.displayName;
      };

      const onBatch = (accounts) => {
        for (const acc of accounts) { if (acc.username) apiCache.set(acc.username, acc); }
        for (const scanned of state.scanned) {
          const a = apiCache.get(scanned.username);
          if (a) enrichFrom(scanned, a);
        }
      };
      APIInterceptor.subscribe(onBatch);

      const collectVisible = () => {
        let found = 0;
        for (const cell of document.querySelectorAll(SEL.userCell)) {
          if (state.scanned.length >= scanLimit) break;
          const acc = Scraper.fromCell(cell);
          if (!acc.username || seenUsernames.has(acc.username)) continue;
          seenUsernames.add(acc.username);
          const apiAcc = apiCache.get(acc.username);
          if (apiAcc) enrichFrom(acc, apiAcc);
          state.scanned.push(acc);
          found++;
        }
        return found;
      };

      collectVisible();

      return new Promise((resolve) => {
        let emptyRounds = 0;
        const MAX_EMPTY = 4;

        const doScroll = () => {
          if (!state.scanning || state.scanned.length >= scanLimit) {
            APIInterceptor.unsubscribe(onBatch); resolve(); return;
          }
          const countBefore = state.scanned.length;
          this._scrollDown();

          let fallbackTimer;
          const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
          const obs = new MutationObserver(() => {
            if (collectVisible() > 0) {
              clearTimeout(fallbackTimer); obs.disconnect();
              emptyRounds = 0;
              this._updateAction(`Scanning… ${state.scanned.length} accounts`);
              setTimeout(doScroll, 350);
            }
          });
          obs.observe(root, { childList: true, subtree: true });

          fallbackTimer = setTimeout(() => {
            obs.disconnect();
            collectVisible();
            if (state.scanned.length > countBefore) { emptyRounds = 0; } else { emptyRounds++; }
            this._updateAction(`Scanning… ${state.scanned.length} accounts`);
            if (emptyRounds >= MAX_EMPTY) { APIInterceptor.unsubscribe(onBatch); resolve(); }
            else { doScroll(); }
          }, 2000);
        };

        doScroll();
      });
    },

    _showResults(targets, dryRun) {
      const wrap        = document.getElementById('xpurge-results');
      const list        = document.getElementById('result-list');
      const countLabel  = document.getElementById('result-count-label');
      const unfAllBtn   = document.getElementById('btn-unfollow-all');
      wrap.style.display = 'block';
      document.getElementById('result-list').style.display = 'block';
      document.getElementById('results-chevron')?.classList.add('open');

      const updateHeader = () => {
        countLabel.textContent = `${state.targets.length} accounts match filters`;
        if (state.targets.length > 0) {
          const willUnfollow = state.filters.dailyLimit === 0
            ? state.targets.length
            : Math.min(state.targets.length, Math.max(0, state.filters.dailyLimit - state.dailyCount));
          const limitNote = state.filters.dailyLimit === 0 ? 'no daily limit' : `${willUnfollow} under daily limit`;
          unfAllBtn.textContent = `Unfollow All (${limitNote})`;
          unfAllBtn.style.display = 'block';
        } else {
          unfAllBtn.style.display = 'none';
        }
      };

      const renderList = () => {
        if (!state.targets.length) {
          list.innerHTML = '<li class="xp-hint" style="padding:8px 14px">No accounts match current filters</li>';
          return;
        }
        list.innerHTML = state.targets.map((acc, idx) => {
          const pd = acc.profileData;
          const stats = [
            pd?.followers != null ? `${fmtNum(pd.followers)} followers` : null,
            pd?.accountAgeMonths != null ? `${pd.accountAgeMonths}mo old` : null,
          ].filter(Boolean).join(' · ');
          const bio = acc.bio
            ? escHtml(acc.bio.slice(0, 65)) + (acc.bio.length > 65 ? '…' : '')
            : '';
          return `<li class="result-item" data-idx="${idx}">
            <div class="ri-main">
              <a class="ri-name" href="https://x.com/${acc.username}" target="_blank" rel="noopener noreferrer">@${acc.username}</a>
              <span class="ri-reason">${acc.reason || ''}</span>
              ${stats ? `<span class="ri-stats">${stats}</span>` : ''}
              ${bio   ? `<span class="ri-bio">${bio}</span>` : ''}
            </div>
            <div class="ri-btns">
              <button class="ri-skip-btn" data-idx="${idx}">Skip</button>
              <button class="ri-unf-btn" data-idx="${idx}">Unfollow</button>
            </div>
          </li>`;
        }).join('');

        list.querySelectorAll('.ri-skip-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            state.targets.splice(parseInt(btn.dataset.idx, 10), 1);
            updateHeader();
            renderList();
          });
        });

        list.querySelectorAll('.ri-unf-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const acc = state.targets[idx];
            btn.disabled = true;
            btn.textContent = '…';
            const daily = await SW.getDailyCount();
            if (state.filters.dailyLimit > 0 && daily >= state.filters.dailyLimit) { btn.textContent = 'Limit!'; return; }
            state.running = true;
            const ok = await Engine.unfollowOne(acc);
            state.running = false;
            if (ok) {
              await SW.incrementDaily();
              state.dailyCount++;
              state.targets.splice(idx, 1);
              updateHeader();
              renderList();
            } else {
              btn.disabled = false;
              btn.textContent = 'Unfollow';
            }
          });
        });
      };

      unfAllBtn.onclick = null;
      unfAllBtn.addEventListener('click', () => this._runPurge());
      updateHeader();
      renderList();
    },

    async _runPurge() {
      if (state.running || !state.targets.length) return;
      const unfAllBtn = document.getElementById('btn-unfollow-all');
      if (unfAllBtn) unfAllBtn.style.display = 'none';
      document.getElementById('btn-stop-wrap').style.display = 'block';
      document.getElementById('xpurge-actions').style.display = 'none';

      const totalTargets = state.targets.length; // capture before any removal
      const unfollowedUsernames = new Set();
      state.running = true;
      await Engine.run(
        state.targets,
        state.filters,
        false,
        {
          onProgress: ({ action, unfollowed, total, next }) => {
            this._updateAction(action);
            this._updateProgress(unfollowed, total, next);
          },
          onEach: (acc, idx) => {
            unfollowedUsernames.add(acc.username);
            // Remove the item from the results list live
            const li = document.querySelector(`#result-list li[data-idx="${idx}"]`);
            if (li) li.remove();
            // Update the header count
            const remaining = state.targets.length - unfollowedUsernames.size;
            const countLabel = document.getElementById('result-count-label');
            if (countLabel) countLabel.textContent = `${remaining} accounts match filters`;
          },
          onDone: (count) => {
            // Sync progress bar to final accurate count
            this._updateProgress(count, totalTargets, null);
            // Prune successfully unfollowed accounts from state
            state.targets = state.targets.filter(a => !unfollowedUsernames.has(a.username));
            const unfAllBtn2 = document.getElementById('btn-unfollow-all');
            if (unfAllBtn2) unfAllBtn2.style.display = 'none';
            const list = document.getElementById('result-list');
            if (list && state.targets.length === 0) {
              list.innerHTML = '<li class="xp-hint" style="padding:8px 14px">All done — no more accounts match.</li>';
            }
            this._finishUI(`Done! Unfollowed ${count} accounts today.`);
          },
        }
      );
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
