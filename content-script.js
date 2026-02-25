// X-Purge Content Script
// Injected on x.com/* — activates when URL is /following or /followers.
// Handles scanning, filtering, unfollowing (following mode) and
// removing followers (followers mode).

  (function () {
  'use strict';
  if (window.__xPurgeLoaded) return;
  window.__xPurgeLoaded = true;

  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[X-Purge DEBUG]', ...args); };

  // ============================================================
  // DOM SELECTORS
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
    active: false,
    scanning: false,
    running: false,
    dryRun: false,
    scanned: [],
    targets: [],
    unfollowedCount: 0,
    filters: defaultFilters(),
    whitelist: [],
    dailyCount: 0,
    mode: 'following',      // 'following' | 'followers' — set by router
    cachedAccounts: [],     // all accounts from last API scan (in-memory)
    cacheTime: null,        // Date.now() of last scan
  };

  function defaultFilters() {
    return {
      notFollowingBack:  false,
      protectMutuals:    true,
      followedMonthsAgo: 0,
      inactiveDays:      0,
      defaultAvatar:     false,
      excludeVerified:   false,
      followerRatioBelow: 0,
      minFollowerProtect: 0,
      accountAgeMonths:  0,
      bioBlacklist:      [],
      bioWhitelist:      [],
      dailyLimit:        50,
      scanLimit:         250,
    };
  }

  // Strip non-serialisable DOM ref before storing in chrome.storage
  function stripElement(acc) {
    const { element, ...rest } = acc; // eslint-disable-line no-unused-vars
    return rest;
  }

  // ============================================================
  // CHROME MESSAGING (to service worker)
  // ============================================================
  const SW = {
    send(msg) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, (res) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(res);
          });
        } catch { resolve(null); }
      });
    },
    getDailyCount:    ()      => SW.send({ type: 'GET_DAILY_COUNT' }),
    incrementDaily:   ()      => SW.send({ type: 'INCREMENT_DAILY_COUNT' }),
    getWhitelist:     ()      => SW.send({ type: 'GET_WHITELIST' }),
    addWhitelist:     (u)     => SW.send({ type: 'ADD_TO_WHITELIST', username: u }),
    removeWhitelist:  (u)     => SW.send({ type: 'REMOVE_FROM_WHITELIST', username: u }),
    getFilters:       ()      => SW.send({ type: 'GET_FILTERS' }),
    saveFilters:      (f)     => SW.send({ type: 'SAVE_FILTERS', filters: f }),
    getScanCache:     (mode)  => SW.send({ type: 'GET_SCAN_CACHE', mode }),
    setScanCache:     (mode, accounts, scannedAt) => SW.send({ type: 'SET_SCAN_CACHE', mode, accounts, scannedAt }),
  };

  const RESERVED_PATHS = new Set([
    'home','explore','notifications','messages','settings','i','following',
    'followers','compose','search','lists','bookmarks','communities',
    'verified-orgs','premium','jobs','grok',
  ]);

  // ============================================================
  // SCRAPER
  // ============================================================
  const Scraper = {
    fromCell(cell) {
      const acc = { element: cell, reason: null, profileData: null };

      for (const a of cell.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([A-Za-z0-9_]{1,50})(?:[/?#].*)?$/);
        if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
          acc.username = m[1].toLowerCase();
          break;
        }
      }

      if (!acc.username) {
        const nameEl = cell.querySelector(SEL.userName);
        if (nameEl) {
          for (const s of nameEl.querySelectorAll('span')) {
            const t = s.textContent.trim();
            if (t.startsWith('@') && t.length > 1) { acc.username = t.slice(1).toLowerCase(); break; }
          }
        }
      }

      const nameEl = cell.querySelector(SEL.userName);
      acc.displayName = nameEl ? (nameEl.querySelector('span')?.textContent.trim() || '') : '';
      const bioEl = cell.querySelector(SEL.userDescription);
      acc.bio = bioEl ? bioEl.textContent.trim() : '';
      acc.isVerified = !!cell.querySelector(SEL.verifiedBadge);
      const avatarImg = cell.querySelector(SEL.avatarImg);
      acc.hasDefaultAvatar = this._isDefaultAvatar(avatarImg);
      return acc;
    },

    _isDefaultAvatar(img) {
      if (!img) return false;
      const src = img.getAttribute('src') || '';
      return src.includes('default_profile') || src.includes('/placeholder') || src === '';
    },

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

    collectCells() { return Array.from(document.querySelectorAll(SEL.userCell)); },
  };

  // ============================================================
  // API INTERCEPTOR
  // ============================================================
  const APIInterceptor = {
    _listeners:              new Set(),
    _followersListeners:     new Set(),
    _auth:                   null,  // Following credentials
    _followersAuth:          null,  // Followers credentials (different queryId + fieldToggles)
    _bearer:                 null,
    _removeFollowerUrl:      null,  // Captured from X's own "Remove this follower" click (overrides default below)
    // Default RemoveFollower GQL queryId — captured from X's network tab 2025-02.
    // Overridden dynamically once page-bridge intercepts a live RemoveFollower call.
    _removeFollowerQueryId: 'QpNfg0kpPRfjROQ_9eOLXA',
    // Pre-scan cache: accumulates FOLLOWERS_PAGE data that arrives before scan starts.
    // X fires the first API batch on page-load (before user clicks Scan), so we buffer
    // it here and use it to seed apiCache immediately when _collectViaScroll begins.
    _preScanFollowersCache:  new Map(),
    _preScanFollowersCursor: null,   // Bottom cursor from the last natively-intercepted Followers page
    // Dynamic headers captured from X's own Followers XHR — needed for first-page (no-cursor) requests.
    // x-client-transaction-id is the anti-bot token X requires; cursor-based requests don't need it.
    _followersTransactionId: null,
    _followersClientLanguage: null,
    _followersClientUuid: null,

    subscribe(fn)              { this._listeners.add(fn); },
    unsubscribe(fn)            { this._listeners.delete(fn); },
    subscribeFollowers(fn)     { this._followersListeners.add(fn); },
    unsubscribeFollowers(fn)   { this._followersListeners.delete(fn); },

    parseResponse(json) {
      const accounts = [];
      try {
        const timelineV2 = json?.data?.user?.result?.timeline_v2?.timeline;
        const timelineV1 = json?.data?.user?.result?.timeline?.timeline;
        const instructions = timelineV2?.instructions ?? timelineV1?.instructions ?? [];

        if (!instructions.length) {
          console.warn('[X-Purge] parseResponse — no instructions. json.data keys:', Object.keys(json?.data ?? {}), '| user.result keys:', Object.keys(json?.data?.user?.result ?? {}));
        }

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

      } catch (e) { console.warn('[X-Purge] GraphQL parse error:', e); }
      return accounts;
    },

    _fromUserResult(result) {
      const legacy = result?.legacy;
      const core   = result?.core;
      const screenName = core?.screen_name ?? legacy?.screen_name;
      if (!screenName) return null;

      const now = Date.now();
      const created = (core?.created_at || legacy?.created_at)
        ? new Date(core?.created_at ?? legacy?.created_at) : null;
      const lastTweet = legacy?.status?.created_at ? new Date(legacy.status.created_at) : null;
      const neverTweeted = !lastTweet && legacy?.statuses_count === 0;
      const relPersp = result?.relationship_perspectives;
      // followed_by = they follow you | following = you follow them
      const isFollowingBack = relPersp?.followed_by ?? legacy?.followed_by ?? null;
      const isFollowing     = relPersp?.following    ?? null;

      return {
        username:        screenName.toLowerCase(),
        restId:          result.rest_id ?? null,
        displayName:     core?.name ?? legacy?.name ?? '',
        bio:             legacy?.description ?? '',
        isVerified:      !!(legacy?.verified || result.is_blue_verified),
        hasDefaultAvatar: !!legacy?.default_profile_image,
        reason:          null,
        element:         null,
        profileData: {
          followers:        legacy?.followers_count ?? null,
          following:        legacy?.friends_count   ?? null,
          isFollowingBack,
          isFollowing,      // you follow them — used for protectMutuals in followers mode
          accountAgeMonths: created ? Math.floor((now - created) / (1000 * 60 * 60 * 24 * 30)) : null,
          daysSinceLastPost: lastTweet
            ? Math.floor((now - lastTweet) / (1000 * 60 * 60 * 24))
            : neverTweeted ? 9999 : null,
        },
      };
    },
  };

  const BridgeRPC = {
    _nextId: 1,
    _pending: new Map(),

    fetchFollowersPage(url, headers, timeoutMs = 12000) {
      const requestId = this._nextId++;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this._pending.delete(requestId);
          resolve({ ok: false, status: 0, error: 'timeout' });
        }, timeoutMs);
        this._pending.set(requestId, { resolve, timeout });
        window.postMessage({ __xpurge: 'DIRECT_FETCH_FOLLOWERS_PAGE', requestId, url, headers }, '*');
      });
    },

    handleResult(data) {
      const p = this._pending.get(data.requestId);
      if (!p) return;
      clearTimeout(p.timeout);
      this._pending.delete(data.requestId);
      p.resolve({
        ok: !!data.ok,
        status: data.status ?? 0,
        json: data.json ?? null,
        body: data.body ?? '',
        error: data.error ?? null,
      });
    },
  };

  // ============================================================
  // DIRECT FETCHER
  // ============================================================
  const DirectFetcher = {
    _ct0() {
      return document.cookie.match(/(?:^|;\s*)ct0=([A-Za-z0-9]+)/)?.[1] ?? null;
    },

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
            'Authorization':         auth.authorization,
            'X-Csrf-Token':          ct0,
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Auth-Type':   'OAuth2Session',
          },
          credentials: 'include',
        });
        if (!resp.ok) { console.warn('[X-Purge] fetchFollowingPage HTTP', resp.status); return null; }
        return resp.json();
      } catch (e) { console.warn('[X-Purge] fetchFollowingPage error:', e); return null; }
    },

    async fetchFollowersPage(cursor) {
      const auth = APIInterceptor._followersAuth;
      const ct0  = this._ct0();
      if (!auth?.queryId || !auth?.userId || !ct0) return null;

      const parseVars = (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch { return null; }
      };

      const templateUrl = (() => {
        try { return auth.requestUrl ? new URL(auth.requestUrl, location.href) : null; } catch { return null; }
      })();

      const templateVars = parseVars(auth.rawVars)
        || (templateUrl ? parseVars(templateUrl.searchParams.get('variables')) : null);

      const vars = (() => {
        const base = templateVars ? { ...templateVars } : { userId: auth.userId, count: 20, includePromotedContent: false };
        if (cursor) base.cursor = cursor;
        else delete base.cursor;
        if (!base.userId) base.userId = auth.userId;
        return base;
      })();

      // For no-cursor (first page) requests, include X's dynamic anti-bot headers captured from
      // the native Followers XHR. These are required by the Followers endpoint but not Following.
      // Cursor-based requests (page 2+) are accepted without them.
      const headers = {
        'Authorization':         auth.authorization,
        'X-Csrf-Token':          ct0,
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Auth-Type':   'OAuth2Session',
      };
      // Keep native anti-bot headers on every page (cursor and non-cursor).
      // In recent X behavior, cursor pages can still be rejected without these.
      const tid  = APIInterceptor._followersTransactionId;
      const lang = APIInterceptor._followersClientLanguage;
      const uuid = APIInterceptor._followersClientUuid;
      if (tid)  headers['X-Client-Transaction-Id']    = tid;
      if (lang) headers['X-Twitter-Client-Language']  = lang;
      if (uuid) headers['X-Client-Uuid']              = uuid;

      try {
        const opFromTemplate = (() => {
          if (!templateUrl) return null;
          const m = templateUrl.pathname.match(/\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)(?:\/)?$/i);
          return m?.[1] ?? null;
        })();
        const primaryOps = Array.from(new Set([opFromTemplate, auth.operation || 'Followers'].filter(Boolean)));
        const needsVerifiedFallback = primaryOps.some((op) => /verifiedfollowers/i.test(String(op)));
        const ops = needsVerifiedFallback
          ? Array.from(new Set([...primaryOps, 'VerifiedFollowers', 'Followers']))
          : Array.from(new Set([...primaryOps, 'Followers']));
        dbg('fetchFollowersPage start', {
          cursor: cursor ?? null,
          queryId: auth.queryId,
          preferredOp: auth.operation || 'Followers',
          ops,
          hasRawVars: !!auth.rawVars,
          hasRequestUrl: !!auth.requestUrl,
          varsKeys: Object.keys(vars),
          templateParamKeys: templateUrl ? Array.from(templateUrl.searchParams.keys()) : [],
          headerPresence: {
            csrf: !!headers['X-Csrf-Token'],
            transactionId: !!headers['X-Client-Transaction-Id'],
            clientLanguage: !!headers['X-Twitter-Client-Language'],
            clientUuid: !!headers['X-Client-Uuid'],
          },
        });
        for (const op of ops) {
          let url;
          if (templateUrl) {
            const u = new URL(templateUrl.toString());
            const m = u.pathname.match(/(\/i\/api\/graphql\/[A-Za-z0-9_-]+\/)([A-Za-z0-9_]+)(\/?)/i);
            if (m) u.pathname = `${m[1]}${op}${m[3] || ''}`;
            else u.pathname = `/i/api/graphql/${auth.queryId}/${op}`;
            u.searchParams.set('variables', JSON.stringify(vars));
            if (!u.searchParams.has('features') && auth.features) u.searchParams.set('features', auth.features);
            if (!u.searchParams.has('fieldToggles') && auth.fieldToggles) u.searchParams.set('fieldToggles', auth.fieldToggles);
            url = u.toString();
          } else {
            url = `https://x.com/i/api/graphql/${auth.queryId}/${op}` +
              `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
              (auth.features ? `&features=${encodeURIComponent(auth.features)}` : '') +
              (auth.fieldToggles ? `&fieldToggles=${encodeURIComponent(auth.fieldToggles)}` : '');
          }

          dbg('fetchFollowersPage request', { op, cursor: cursor ?? null, url });
          const resp = await BridgeRPC.fetchFollowersPage(url, headers);
          if (resp.ok && resp.json) {
            dbg('fetchFollowersPage success', { op, status: resp.status, cursor: cursor ?? null, via: 'page-bridge' });
            return resp.json;
          }
          const body = resp.body || '';
          console.warn('[X-Purge] fetchFollowersPage HTTP', resp.status, 'op=' + op, '— body:', body.slice(0, 300));
          dbg('fetchFollowersPage failure details', {
            op,
            status: resp.status,
            cursor: cursor ?? null,
            bodyPreview: body.slice(0, 120) || resp.error || '',
            via: 'page-bridge',
          });
        }
        return null;
      } catch (e) { console.warn('[X-Purge] fetchFollowersPage error:', e); return null; }
    },

    extractCursor(json) {
      // Fast path: known instruction paths
      const instructions =
        json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
        json?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
      for (const instr of instructions) {
        for (const entry of (instr.entries ?? [])) {
          const c = entry.content;
          if (c?.cursorType && /bottom/i.test(c.cursorType) && c.value) return c.value;
          if (/cursor[\-_]bottom/i.test(entry.entryId ?? '') && c?.value) return c.value;
        }
      }
      // Deep-walk fallback: handles unexpected response structures
      const deepFind = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj)) { for (const item of obj) { const r = deepFind(item); if (r) return r; } return null; }
        if (obj.cursorType && /bottom/i.test(String(obj.cursorType)) && obj.value && typeof obj.value === 'string') return obj.value;
        for (const key of Object.keys(obj)) { const r = deepFind(obj[key]); if (r) return r; }
        return null;
      };
      try { return deepFind(json); } catch {}
      return null;
    },

    // Fetch followers via REST v1.1 — no x-client-transaction-id needed (unlike the GraphQL
    // Followers endpoint). Returns up to 200 accounts per page (10× more than GraphQL's 20).
    async fetchFollowersPageV1(cursor) {
      const auth   = APIInterceptor._followersAuth ?? APIInterceptor._auth;
      const ct0    = this._ct0();
      const userId = auth?.userId;
      const bearer = auth?.authorization ?? APIInterceptor._bearer;
      if (!userId || !ct0 || !bearer) return null;

      const params = new URLSearchParams({
        user_id:               userId,
        count:                 '200',
        skip_status:           'false',   // need status.created_at for last-tweet date
        include_user_entities: 'false',
      });
      if (cursor) params.set('cursor', cursor);

      try {
        const resp = await fetch(`https://x.com/i/api/1.1/followers/list.json?${params}`, {
          headers: {
            'Authorization':         bearer,
            'X-Csrf-Token':          ct0,
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Auth-Type':   'OAuth2Session',
          },
          credentials: 'include',
        });
        if (!resp.ok) { console.warn('[X-Purge] fetchFollowersPageV1 HTTP', resp.status); return null; }
        return resp.json();
      } catch (e) { console.warn('[X-Purge] fetchFollowersPageV1 error:', e); return null; }
    },

    // Parse a v1.1 followers/list.json response into the same account format as _fromUserResult.
    parseResponseV1(json) {
      if (!Array.isArray(json?.users)) return [];
      const now = Date.now();
      return json.users.flatMap((user) => {
        if (!user?.screen_name) return [];
        const created      = user.created_at ? new Date(user.created_at).getTime() : null;
        const lastTweet    = user.status?.created_at ? new Date(user.status.created_at).getTime() : null;
        const neverTweeted = !lastTweet && user.statuses_count === 0;
        return [{
          username:        user.screen_name.toLowerCase(),
          restId:          user.id_str ?? String(user.id),
          displayName:     user.name ?? '',
          bio:             user.description ?? '',
          isVerified:      !!(user.verified || user.is_blue_verified),
          hasDefaultAvatar: !!user.default_profile_image,
          reason:          null,
          element:         null,
          profileData: {
            followers:         user.followers_count ?? null,
            following:         user.friends_count   ?? null,
            isFollowingBack:   true,          // by definition: they're in your followers list
            isFollowing:       user.following ?? null,  // you follow them back
            accountAgeMonths:  created ? Math.floor((now - created)    / (1000 * 60 * 60 * 24 * 30)) : null,
            daysSinceLastPost: lastTweet
              ? Math.floor((now - lastTweet) / (1000 * 60 * 60 * 24))
              : neverTweeted ? 9999 : null,
          },
        }];
      });
    },

    // Extract next-page cursor from a v1.1 followers/list response.
    // next_cursor === 0 means no more pages.
    extractCursorV1(json) {
      const next = json?.next_cursor_str ?? (json?.next_cursor != null ? String(json.next_cursor) : null);
      return (!next || next === '0') ? null : next;
    },

    // Unfollow (following mode) — returns { ok, rateLimited }
    async unfollowUser(restId) {
      const bearer = APIInterceptor._bearer || APIInterceptor._auth?.authorization;
      const ct0    = this._ct0();
      if (!restId || !ct0 || !bearer) return { ok: false, rateLimited: false };
      try {
        const resp = await fetch('https://x.com/i/api/1.1/friendships/destroy.json', {
          method: 'POST',
          headers: {
            'Authorization':         bearer,
            'X-Csrf-Token':          ct0,
            'Content-Type':          'application/x-www-form-urlencoded',
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Auth-Type':   'OAuth2Session',
          },
          credentials: 'include',
          body: `user_id=${restId}`,
        });
        return { ok: resp.ok, rateLimited: resp.status === 429 };
      } catch { return { ok: false, rateLimited: false }; }
    },

    // Remove follower via X's native "Remove this follower" endpoint.
    // If the endpoint hasn't been captured yet via page intercept, falls back to block+unblock.
    // Returns { ok, rateLimited, method }
    async removeFollower(restId) {
      const bearer = APIInterceptor._bearer
        || APIInterceptor._followersAuth?.authorization
        || APIInterceptor._auth?.authorization;
      const ct0    = this._ct0();
      if (!restId || !ct0 || !bearer) {
        console.warn('[X-Purge] removeFollower ABORTED — missing:', !restId ? 'restId' : !ct0 ? 'ct0' : 'bearer');
        return { ok: false, rateLimited: false, method: 'none' };
      }

      const baseHeaders = {
        'Authorization':         bearer,
        'X-Csrf-Token':          ct0,
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Auth-Type':   'OAuth2Session',
      };

      // ── Primary: RemoveFollower GraphQL mutation ──────────────────────────
      // X uses: POST /i/api/graphql/{queryId}/RemoveFollower
      //         body: {"variables":{"target_user_id":"..."},"queryId":"..."}
      // Use captured URL from page-bridge if available; otherwise use known default queryId.
      const capturedUrl = APIInterceptor._removeFollowerUrl;
      const removeGqlUrl = (capturedUrl && /\/RemoveFollower/.test(capturedUrl))
        ? capturedUrl
        : `https://x.com/i/api/graphql/${APIInterceptor._removeFollowerQueryId}/RemoveFollower`;
      const removeQueryId = removeGqlUrl.match(/\/graphql\/([A-Za-z0-9_-]+)\/RemoveFollower/)?.[1];
      try {
        const resp = await fetch(removeGqlUrl, {
          method: 'POST',
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ variables: { target_user_id: restId }, queryId: removeQueryId }),
        });
        if (resp.status === 429) return { ok: false, rateLimited: true, method: 'remove' };
        if (resp.ok) return { ok: true, rateLimited: false, method: 'remove' };
        const body = await resp.text().catch(() => '');
        console.warn('[X-Purge] RemoveFollower GQL failed', resp.status, body.slice(0, 200), '— falling back to block+unblock');
      } catch (e) {
        console.warn('[X-Purge] RemoveFollower fetch error:', e, '— falling back to block+unblock');
      }

      // ── Fallback: block + immediate unblock ───────────────────────────────
      // Soft-block: block removes their follow, unblock lets them re-follow later.
      try {
        const formHeaders = { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' };
        const block = await fetch('https://x.com/i/api/1.1/blocks/create.json', {
          method: 'POST', headers: formHeaders, credentials: 'include', body: `user_id=${restId}`,
        });
        if (block.status === 429) return { ok: false, rateLimited: true, method: 'block' };
        if (!block.ok) { console.warn('[X-Purge] blocks/create.json failed', block.status); return { ok: false, rateLimited: false, method: 'block' }; }
        // Brief pause so X processes the block before we unblock
        await Safety.sleep(600);
        const unblock = await fetch('https://x.com/i/api/1.1/blocks/destroy.json', {
          method: 'POST', headers: formHeaders, credentials: 'include', body: `user_id=${restId}`,
        });
        return { ok: true, rateLimited: false, method: 'block+unblock' };
      } catch (e) { console.warn('[X-Purge] block+unblock error:', e); return { ok: false, rateLimited: false, method: 'block' }; }
    },
  };

  // Route postMessages from page-bridge.js → APIInterceptor
  let _followersCredSig = null;
  let _followersHeaderSig = null;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.__xpurge === 'DIRECT_FETCH_FOLLOWERS_PAGE_RESULT') {
      BridgeRPC.handleResult(event.data);
      return;
    }

    if (event.data?.__xpurge === 'FOLLOWING_PAGE') {
      const accounts = APIInterceptor.parseResponse(event.data.json);
      if (accounts.length) APIInterceptor._listeners.forEach(fn => fn(accounts));
    }
    if (event.data?.__xpurge === 'FOLLOWERS_PAGE') {
      const accounts = APIInterceptor.parseResponse(event.data.json);
      // Always extract cursor — we use it to bootstrap the direct API scan from page 2
      // (X's first page requires X-Client-Transaction-Id we can't generate, but cursor pages work)
      const cursor = event.data.cursor ?? DirectFetcher.extractCursor(event.data.json);
      if (cursor) APIInterceptor._preScanFollowersCursor = cursor;
      dbg('FOLLOWERS_PAGE received', {
        parsedAccounts: accounts.length,
        cursor: cursor ?? null,
        preScanCacheBefore: APIInterceptor._preScanFollowersCache.size,
      });
      if (accounts.length) {
        // Buffer into pre-scan cache — available immediately when _collectViaScroll starts,
        // even if this fires before the user clicks Scan.
        for (const acc of accounts) {
          if (acc.username) APIInterceptor._preScanFollowersCache.set(acc.username, acc);
        }
        APIInterceptor._followersListeners.forEach(fn => fn(accounts));
      }
    }
    if (event.data?.__xpurge === 'BEARER_TOKEN') {
      APIInterceptor._bearer = event.data.authorization;
    }
    if (event.data?.__xpurge === 'API_CREDENTIALS') {
      try {
        const { queryId, features, variables, authorization } = event.data;
        const userId = variables ? JSON.parse(variables).userId : null;
        APIInterceptor._auth   = { queryId, features, userId, authorization };
        APIInterceptor._bearer = APIInterceptor._bearer || authorization;
      } catch {}
    }
    if (event.data?.__xpurge === 'FOLLOWERS_CREDENTIALS') {
      try {
        const { queryId, operation, features, fieldToggles, variables, rawVars, requestUrl, authorization } = event.data;
        const userId = variables ? JSON.parse(variables).userId : null;
        APIInterceptor._followersAuth = { queryId, operation, features, fieldToggles, userId, rawVars, requestUrl, authorization };
        APIInterceptor._bearer = authorization;
        const sig = JSON.stringify([queryId, operation || 'Followers', !!features, !!fieldToggles, !!rawVars, requestUrl || '', userId]);
        if (sig !== _followersCredSig) {
          _followersCredSig = sig;
          dbg('FOLLOWERS_CREDENTIALS received', {
            queryId,
            operation: operation || 'Followers',
            hasFeatures: !!features,
            hasFieldToggles: !!fieldToggles,
            hasRawVars: !!rawVars,
            hasRequestUrl: !!requestUrl,
            userId,
          });
        }
      } catch {}
    }
    if (event.data?.__xpurge === 'FOLLOWERS_NATIVE_HEADERS') {
      // Fresh per X request — always overwrite (token may refresh each page load).
      if (event.data.transactionId)  APIInterceptor._followersTransactionId  = event.data.transactionId;
      if (event.data.clientLanguage) APIInterceptor._followersClientLanguage = event.data.clientLanguage;
      if (event.data.clientUuid)     APIInterceptor._followersClientUuid     = event.data.clientUuid;
      const sig = JSON.stringify([!!event.data.transactionId, !!event.data.clientLanguage, !!event.data.clientUuid]);
      if (sig !== _followersHeaderSig) {
        _followersHeaderSig = sig;
        dbg('FOLLOWERS_NATIVE_HEADERS received', {
          hasTransactionId: !!event.data.transactionId,
          hasClientLanguage: !!event.data.clientLanguage,
          hasClientUuid: !!event.data.clientUuid,
        });
      }
    }
    if (event.data?.__xpurge === 'FOLLOWER_REMOVE_ENDPOINT') {
      const { url } = event.data;
      const cleanUrl = url.split('?')[0];
      APIInterceptor._removeFollowerUrl = cleanUrl;
      // If this is a GQL RemoveFollower, also update the stored queryId for future use
      const qid = cleanUrl.match(/\/graphql\/([A-Za-z0-9_-]+)\/RemoveFollower/)?.[1];
      if (qid) APIInterceptor._removeFollowerQueryId = qid;
    }
  });

  window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');

  // ============================================================
  // FILTER ENGINE
  // ============================================================
  const Filters = {
    evaluate(acc, filters, whitelist) {
      if (acc.username && whitelist.includes(acc.username.toLowerCase())) return false;

      if (filters.bioWhitelist.length) {
        const bioLow = acc.bio.toLowerCase();
        for (const kw of filters.bioWhitelist) {
          if (kw && bioLow.includes(kw.toLowerCase())) return false;
        }
      }

      if (filters.excludeVerified && acc.isVerified) return false;

      let flag = false;

      if (filters.defaultAvatar && acc.hasDefaultAvatar) {
        flag = true;
        acc.reason = 'Default avatar';
      }

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

      const pd = acc.profileData;
      if (pd) {
        const isFollowersMode = state.mode === 'followers';

        if (filters.minFollowerProtect > 0 && pd.followers >= filters.minFollowerProtect) return false;

        // protectMutuals:
        //   following mode → "they follow me back" (isFollowingBack / followed_by)
        //   followers mode → "I follow them back" (isFollowing / following)
        //   In followers mode isFollowingBack is always true (everyone there follows you),
        //   so we MUST use isFollowing to detect real mutuals.
        const isMutual = isFollowersMode ? pd.isFollowing === true : pd.isFollowingBack === true;
        if (filters.protectMutuals && isMutual) return false;

        // notFollowingBack: following-mode only — in followers mode all accounts have
        // isFollowingBack=true by definition so this filter is meaningless there.
        if (!isFollowersMode && filters.notFollowingBack && pd.isFollowingBack === false) {
          flag = true;
          acc.reason = acc.reason || 'Not following back';
        }

        if (filters.inactiveDays > 0 && pd.daysSinceLastPost !== null && pd.daysSinceLastPost > filters.inactiveDays) {
          flag = true;
          acc.reason = acc.reason || (pd.daysSinceLastPost >= 9999 ? 'Never posted' : `Inactive ${pd.daysSinceLastPost}d`);
        }

        if (filters.followerRatioBelow > 0 && pd.followers !== null && pd.following !== null) {
          const ratio = pd.following > 0 ? pd.followers / pd.following : 0;
          if (ratio < filters.followerRatioBelow) {
            flag = true;
            acc.reason = acc.reason || `Ratio ${ratio.toFixed(2)}`;
          }
        }

        if (filters.accountAgeMonths > 0 && pd.accountAgeMonths !== null && pd.accountAgeMonths < filters.accountAgeMonths) {
          flag = true;
          acc.reason = acc.reason || `New acct (${pd.accountAgeMonths}mo)`;
        }
      }

      return flag;
    },
  };

  // ============================================================
  // SAFETY
  // ============================================================
  const Safety = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    heatLevel(dailyLimit) {
      if (dailyLimit === 0 || dailyLimit > 500) return { label: 'Danger',   color: '#7f1d1d', width: '100%' };
      if (dailyLimit <= 50)  return               { label: 'Safe',     color: '#22c55e', width: '15%' };
      if (dailyLimit <= 100) return               { label: 'Moderate', color: '#f59e0b', width: '35%' };
      if (dailyLimit <= 200) return               { label: 'Elevated', color: '#ef4444', width: '60%' };
      return                                      { label: 'Danger',   color: '#7f1d1d', width: '85%' };
    },
  };

  // ============================================================
  // UNFOLLOW ENGINE
  // ============================================================
  const Engine = {
    // mode: 'following' | 'followers'
    // Returns { ok, rateLimited }
    async unfollowOne(acc, mode) {
      const hasBearer = !!(APIInterceptor._bearer
        || APIInterceptor._followersAuth?.authorization
        || APIInterceptor._auth?.authorization);
      if (!acc.restId) {
        console.warn('[X-Purge] unfollowOne — restId is NULL for @' + acc.username +
          ' — API enrichment may have failed. Cannot use API path.');
      }

      if (acc.restId && hasBearer) {
        const result = (mode === 'followers')
          ? await DirectFetcher.removeFollower(acc.restId)
          : await DirectFetcher.unfollowUser(acc.restId);

        if (result.rateLimited) return { ok: false, rateLimited: true };
        if (result.ok)          return { ok: true,  rateLimited: false };

        // Followers mode has no DOM fallback
        if (mode === 'followers') {
          console.warn('[X-Purge] removeFollower failed for', acc.username);
          return { ok: false, rateLimited: false };
        }
        console.warn('[X-Purge] Direct API unfollow failed for', acc.username, '— falling back to DOM');
      }

      // ── DOM fallback (following mode only) ──────────────────
      if (mode === 'followers') return { ok: false, rateLimited: false };

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
        const col = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
        window.scrollTo(0, 0);
        if (col) col.scrollTo(0, 0);
        await Safety.sleep(700);
        let lastY = -1;
        for (let i = 0; i < 40 && !btn; i++) {
          btn = findBtn();
          if (btn) break;
          if (window.scrollY === lastY) break;
          lastY = window.scrollY;
          window.scrollBy(0, 1200);
          if (col) col.scrollBy(0, 1200);
          await Safety.sleep(500);
        }
      }
      if (!btn) { console.warn('[X-Purge] No unfollow button found for', acc.username); return { ok: false, rateLimited: false }; }

      try {
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        await Safety.sleep(150);
        btn.click();
        const confirmBtn = await this._waitFor(SEL.confirmBtn, 5000);
        if (!confirmBtn) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { ok: false, rateLimited: false };
        }
        confirmBtn.click();
        await Safety.sleep(800);
        return { ok: true, rateLimited: false };
      } catch (e) {
        console.error('[X-Purge] unfollowOne DOM error:', e);
        return { ok: false, rateLimited: false };
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

    // Countdown helper — ticks every second, respects state.running
    async _countdown(totalMs, label, onProgress, unfollowed, total) {
      const end = Date.now() + totalMs;
      while (state.running && Date.now() < end) {
        const secs  = Math.ceil((end - Date.now()) / 1000);
        const mins  = Math.floor(secs / 60);
        const sPart = secs % 60;
        const tStr  = mins > 0 ? `${mins}m ${sPart}s` : `${secs}s`;
        onProgress({ action: `${label} — resuming in ${tStr}`, unfollowed, total, next: null });
        await Safety.sleep(Math.min(1000, end - Date.now()));
      }
    },

    async run(targets, filters, isDryRun, mode, callbacks) {
      const { onProgress, onDone, onEach } = callbacks;
      let unfollowed = 0;
      let batchCount = 0;

      for (let i = 0; i < targets.length; i++) {
        if (!state.running) break;

        const acc   = targets[i];
        const daily = await SW.getDailyCount();

        if (filters.dailyLimit > 0 && daily >= filters.dailyLimit) {
          onProgress({ action: `Daily limit (${filters.dailyLimit}) reached`, unfollowed, total: targets.length });
          break;
        }

        onProgress({ action: `${mode === 'followers' ? 'Removing' : 'Unfollowing'} @${acc.username}…`, unfollowed, total: targets.length, next: targets[i + 1]?.username });

        const result = isDryRun ? { ok: true, rateLimited: false } : await this.unfollowOne(acc, mode);

        if (result.rateLimited) {
          // Back off 10 minutes then retry this account
          await this._countdown(10 * 60 * 1000, 'Rate limited', onProgress, unfollowed, targets.length);
          if (!state.running) break;
          i--;  // retry same account
          continue;
        }

        if (result.ok) {
          unfollowed++;
          batchCount++;
          if (!isDryRun) await SW.incrementDaily();
          if (onEach) onEach(acc, i);
        }

        // Per-action delay: 1.5–4s to reduce rate-limit risk
        if (i < targets.length - 1) {
          await Safety.sleep(isDryRun ? 100 : Math.floor(1500 + Math.random() * 2500));
        }

        // Longer break every 50 unfollows: 3–5 min
        if (!isDryRun && batchCount > 0 && batchCount % 50 === 0 && i < targets.length - 1) {
          const breakMs = Math.floor(180000 + Math.random() * 120000);
          await this._countdown(breakMs, 'Cooling down to avoid rate limits', onProgress, unfollowed, targets.length);
          if (!state.running) break;
        }
      }

      state.running = false;
      onDone(unfollowed);
    },
  };

  // ============================================================
  // SLIDER CHECKPOINTS
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
  function fmtAge(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 60)   return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)    return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function sliderVal(id) {
    const el = document.getElementById(id);
    const cfg = SLIDERS[id];
    if (!el || !cfg) return 0;
    return cfg.values[parseInt(el.value, 10)] ?? 0;
  }

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

  function _paintSlider(el) {
    const pct = parseInt(el.max) > 0 ? (parseInt(el.value) / parseInt(el.max)) * 100 : 0;
    el.style.background = `linear-gradient(to right, #1d9bf0 ${pct}%, #2f3336 ${pct}%)`;
  }

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
    _paintSlider(el);
  }

  // ============================================================
  // UI — side-panel overlay
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
      this._setModeBadge(state.mode);
    },

    remove() {
      document.getElementById('xpurge-panel')?.remove();
      this.panel = null;
    },

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
    <span id="xpurge-title">&#9889; X-Purge<span id="xp-mode-badge">Following</span></span>
    <button id="xpurge-close" title="Close">&#x2715;</button>
  </div>

  <div id="filters-toggle" class="xp-collapse-hdr">
    Filters <span id="filters-chevron" class="xp-chevron open">&#9662;</span>
  </div>

  <div id="xpurge-body">

    <!-- Relationship -->
    <div class="xp-section">
      <div class="xp-section-title">Relationship</div>
      <label class="xp-row"><input type="checkbox" id="f-notFollowingBack"> Not following back</label>
      <label class="xp-row"><input type="checkbox" id="f-protectMutuals" checked> Protect mutuals</label>
      ${sl('f-followedMonthsAgo', 'Followed more than &hellip; ago')}
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
      <label class="xp-row"><input type="checkbox" id="f-excludeVerified"> Exclude verified &#10003;</label>
      ${sl('f-followerRatioBelow', 'Follower ratio below')}
      ${sl('f-minFollowerProtect', 'Protect if followers &ge;')}
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
      <div class="xp-section-title">Global Whitelist <span class="xp-hint">(never remove)</span></div>
      <div class="xp-row xp-inline">
        <input type="text" id="wl-input" placeholder="@username" class="xp-text-sm">
        <button id="wl-add" class="xp-btn-sm">Add</button>
      </div>
      <div id="wl-list"></div>
    </div>

  </div><!-- /body -->

  <!-- Drag-to-resize handle between filters and results -->
  <div id="xp-resizer"></div>

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
        <span id="results-chevron" class="xp-chevron open">&#9662;</span>
      </div>
    </div>
    <ul id="result-list"></ul>
  </div>

  <div id="xpurge-actions">
    <button id="btn-scan" class="xp-btn xp-btn-secondary">Scan</button>
    <div id="xp-cache-info" style="display:none">
      <button id="btn-rescan">&#8635; Rescan</button>
      <span id="xp-cache-time"></span>
    </div>
  </div>

  <div id="btn-stop-wrap" style="display:none">
    <button id="btn-stop" class="xp-btn xp-btn-secondary">&#9646; Stop</button>
  </div>

</div><!-- /inner -->
      `;
    },

    // ── Set mode badge text + colour ──
    _setModeBadge(mode) {
      const badge = document.getElementById('xp-mode-badge');
      if (!badge) return;
      badge.textContent = mode === 'followers' ? 'Followers' : 'Following';
      badge.className = mode === 'followers' ? 'followers' : '';
      // Also relabel the "Unfollow All" button
      const unfAll = document.getElementById('btn-unfollow-all');
      if (unfAll && unfAll.style.display !== 'none') {
        unfAll.textContent = unfAll.textContent.replace(/^(Unfollow|Remove) All/, mode === 'followers' ? 'Remove All' : 'Unfollow All');
      }
      this._updateFiltersForMode(mode);
    },

    // ── Show/hide filters that only apply to one mode ──
    _updateFiltersForMode(mode) {
      const isFollowers = mode === 'followers';

      // "Not following back" — in followers mode ALL accounts have followed_by=true,
      // so this filter would never trigger. Hide it to avoid confusion.
      const notFollowRow = document.getElementById('f-notFollowingBack')?.closest('.xp-row');
      if (notFollowRow) notFollowRow.style.display = isFollowers ? 'none' : '';

      // "Followed more than X ago" — checks when YOU followed them; not applicable
      // for the followers list. (Also currently unimplemented in Filters.evaluate.)
      const followedAgoRow = document.getElementById('f-followedMonthsAgo')?.closest('.xp-sf');
      if (followedAgoRow) followedAgoRow.style.display = isFollowers ? 'none' : '';

    },

    // ── Bind events ──
    _bind() {
      document.getElementById('xpurge-close').addEventListener('click', () => this.remove());

      Object.keys(SLIDERS).forEach(id => {
        initSlider(id, id === 'f-dailyLimit' ? () => this._updateHeat() : null);
      });

      document.getElementById('wl-add').addEventListener('click', async () => {
        const input = document.getElementById('wl-input');
        const val = input.value.replace('@', '').trim().toLowerCase();
        if (!val) return;
        await SW.addWhitelist(val);
        input.value = '';
        this._renderWhitelist();
      });

      document.getElementById('btn-scan').addEventListener('click', () => this._startScan(true, false));
      document.getElementById('btn-rescan').addEventListener('click', () => this._startScan(true, true));

      document.getElementById('filters-toggle').addEventListener('click', () => {
        const body    = document.getElementById('xpurge-body');
        const chevron = document.getElementById('filters-chevron');
        const isOpen  = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        chevron.classList.toggle('open', !isOpen);
      });

      document.getElementById('result-hdr').addEventListener('click', (e) => {
        if (e.target.closest('#btn-unfollow-all')) return;
        const list    = document.getElementById('result-list');
        const chevron = document.getElementById('results-chevron');
        const isOpen  = list.style.display !== 'none';
        list.style.display = isOpen ? 'none' : 'block';
        chevron.classList.toggle('open', !isOpen);
      });

      document.getElementById('btn-stop').addEventListener('click', () => {
        if (state.scanning) {
          state.scanning = false;
        } else {
          state.running = false;
          this._finishUI('Stopped.');
        }
      });

      this._initResizer();
    },

    // ── Drag-to-resize ──
    _initResizer() {
      const resizer = document.getElementById('xp-resizer');
      const body    = document.getElementById('xpurge-body');
      const results = document.getElementById('xpurge-results');
      if (!resizer || !body || !results) return;

      resizer.addEventListener('mousedown', (e) => {
        const startY          = e.clientY;
        const startBodyH      = body.getBoundingClientRect().height;
        const startResultsH   = results.getBoundingClientRect().height;
        resizer.classList.add('dragging');

        const onMove = (ev) => {
          const delta = ev.clientY - startY;
          const newBodyH    = Math.max(80, startBodyH    + delta);
          const newResultsH = Math.max(80, startResultsH - delta);
          body.style.flex    = 'none';
          body.style.height  = newBodyH    + 'px';
          results.style.flex   = 'none';
          results.style.height = newResultsH + 'px';
        };

        const onUp = () => {
          resizer.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        e.preventDefault(); // prevent text selection during drag
      });
    },

    async _loadSaved() {
      const saved = await SW.getFilters();
      if (saved === null) return;
      if (saved) {
        state.filters = { ...state.filters, ...saved };
        this._fillForm(state.filters);
      }
      state.whitelist  = (await SW.getWhitelist())    ?? [];
      state.dailyCount = (await SW.getDailyCount())   ?? 0;
      this._renderWhitelist();
      this._updateHeat();

      // Load cached scan data for this mode
      const cache = await SW.getScanCache(state.mode);
      if (cache?.accounts?.length) {
        state.cachedAccounts = cache.accounts;
        state.cacheTime      = cache.scannedAt;
        // Apply current filters and show results immediately
        state.targets = state.cachedAccounts.filter(acc =>
          Filters.evaluate(acc, state.filters, state.whitelist)
        );
        if (state.targets.length > 0) {
          this._showResults(state.targets, false);
        }
        this._updateCacheInfo();
      }
    },

    _fillForm(f) {
      const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
      const txt = (id, val) => { const el = document.getElementById(id); if (el) el.value  = val; };

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
        notFollowingBack:   b('f-notFollowingBack'),
        protectMutuals:     b('f-protectMutuals'),
        followedMonthsAgo:  sliderVal('f-followedMonthsAgo'),
        inactiveDays:       sliderVal('f-inactiveDays'),
        defaultAvatar:      b('f-defaultAvatar'),
        excludeVerified:    b('f-excludeVerified'),
        followerRatioBelow: sliderVal('f-followerRatioBelow'),
        minFollowerProtect: sliderVal('f-minFollowerProtect'),
        accountAgeMonths:   sliderVal('f-accountAgeMonths'),
        bioBlacklist:       kws('f-bioBlacklist'),
        bioWhitelist:       kws('f-bioWhitelist'),
        scanLimit:          sliderVal('f-scanLimit'),
        dailyLimit:         sliderVal('f-dailyLimit'),  // 0 = no limit
      };
    },

    _updateHeat() {
      const limit = sliderVal('f-dailyLimit');
      const heat  = Safety.heatLevel(limit);
      const label = document.getElementById('heat-label');
      const bar   = document.getElementById('heat-bar');
      const warn  = document.getElementById('daily-warn');
      if (label) label.textContent = heat.label;
      if (bar)   { bar.style.width = heat.width; bar.style.backgroundColor = heat.color; }
      if (warn)  warn.style.display = (limit === 0 || limit > 200) ? 'block' : 'none';
    },

    // ── Update the cache age label and show/hide resizer ──
    _updateCacheInfo() {
      const infoEl = document.getElementById('xp-cache-info');
      const timeEl = document.getElementById('xp-cache-time');
      const resizer = document.getElementById('xp-resizer');
      if (!infoEl) return;
      if (state.cacheTime) {
        if (timeEl) timeEl.textContent = 'Cached ' + fmtAge(Date.now() - state.cacheTime);
        infoEl.style.display = 'flex';
        if (resizer) resizer.style.display = 'block';
      } else {
        infoEl.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
      }
    },

    async _renderWhitelist() {
      state.whitelist = await SW.getWhitelist();
      const list = document.getElementById('wl-list');
      if (!list) return;
      if (!state.whitelist.length) { list.innerHTML = '<span class="xp-hint">Empty</span>'; return; }
      list.innerHTML = state.whitelist.map(u =>
        `<span class="wl-tag">@${u} <button class="wl-remove" data-u="${u}">&times;</button></span>`
      ).join('');
      list.querySelectorAll('.wl-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await SW.removeWhitelist(btn.dataset.u);
          this._renderWhitelist();
        });
      });
    },

    _anyFilterActive(f) {
      return f.notFollowingBack || f.defaultAvatar || f.excludeVerified ||
             f.followedMonthsAgo > 0 || f.inactiveDays > 0 ||
             f.followerRatioBelow > 0 || f.minFollowerProtect > 0 ||
             f.accountAgeMonths > 0 || f.bioBlacklist.length > 0;
    },

    // ─────────────────────────────────────────────────────────────
    // SCAN — if cache exists and not forceRescan: re-filter from cache.
    //         otherwise: full API scan → save cache → show results.
    // ─────────────────────────────────────────────────────────────
    async _startScan(dryRun, forceRescan = false) {
      if (state.running || state.scanning) return;

      state.filters = this._readForm();

      if (!this._anyFilterActive(state.filters)) {
        this._updateAction('&#9888; No filters enabled — enable at least one filter above.');
        document.getElementById('xpurge-progress').style.display = 'block';
        document.getElementById('btn-stop-wrap').style.display = 'none';
        return;
      }

      await SW.saveFilters(state.filters);
      state.whitelist  = await SW.getWhitelist();
      state.dailyCount = await SW.getDailyCount();
      state.dryRun     = dryRun;

      // ── Fast path: re-filter from cache ──────────────────────
      if (state.cachedAccounts.length && !forceRescan) {
        state.targets = state.cachedAccounts.filter(acc =>
          Filters.evaluate(acc, state.filters, state.whitelist)
        );
        this._showResults(state.targets, dryRun);
        this._finishUI(`${state.targets.length} match filters (cached — ${fmtAge(Date.now() - state.cacheTime)})`);
        return;
      }

      // ── Full API scan ─────────────────────────────────────────
      state.scanned = [];
      state.targets = [];
      // Clear pre-scan buffer on forced rescan so we don't enrich with stale data
      if (forceRescan && state.mode === 'followers') {
        APIInterceptor._preScanFollowersCache.clear();
        APIInterceptor._preScanFollowersCursor = null;
      }

      document.getElementById('xpurge-results').style.display = 'none';
      document.getElementById('xpurge-progress').style.display = 'block';
      document.getElementById('btn-stop-wrap').style.display = 'block';
      document.getElementById('xpurge-actions').style.display = 'none';

      this._updateAction('Scanning…');
      state.scanning = true;
      await this._scrollAndCollect();

      // Save results to cache
      state.cachedAccounts = [...state.scanned];
      state.cacheTime      = Date.now();
      await SW.setScanCache(state.mode, state.cachedAccounts.map(stripElement), state.cacheTime);

      // Apply filters
      state.targets = state.scanned.filter(acc => Filters.evaluate(acc, state.filters, state.whitelist));

      const apiEnriched = state.scanned.filter(a => a.profileData).length;
      this._showResults(state.targets, dryRun);
      this._updateCacheInfo();

      const statsEl = document.getElementById('prog-stats');
      if (statsEl) statsEl.textContent =
        `Scanned ${state.scanned.length} · ${state.targets.length} match · ${apiEnriched} enriched`;

      this._finishUI(`Scanned ${state.scanned.length} — ${state.targets.length} match filters`);
    },

    async _scrollAndCollect() {
      const scanLimit   = state.filters.scanLimit > 0 ? state.filters.scanLimit : Infinity;
      const isFollowers = state.mode === 'followers';

      // Helper: poll for credentials up to 5s
      const waitForAuth = (authFn) => new Promise(resolve => {
        let elapsed = 0;
        const poll = () => {
          if (authFn() || elapsed >= 5000) { resolve(); return; }
          elapsed += 200;
          setTimeout(poll, 200);
        };
        poll();
      });

      if (isFollowers) {
        // Followers mode: try direct GraphQL first using intercepted credentials + headers.
        // If X rejects (404/422) or collection is incomplete, fall back to scroll+intercept.
        const hasFollowersAuth = () => !!APIInterceptor._followersAuth;
        if (!hasFollowersAuth()) {
          this._updateAction('Waiting for followers API credentials…');
          window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');
          await waitForAuth(hasFollowersAuth);
        }

        if (hasFollowersAuth()) {
          dbg('followers auth ready', {
            queryId: APIInterceptor._followersAuth?.queryId,
            operation: APIInterceptor._followersAuth?.operation || 'Followers',
            hasRawVars: !!APIInterceptor._followersAuth?.rawVars,
            preScanCache: APIInterceptor._preScanFollowersCache.size,
            hasPreScanCursor: !!APIInterceptor._preScanFollowersCursor,
            nativeHeaders: {
              transactionId: !!APIInterceptor._followersTransactionId,
              clientLanguage: !!APIInterceptor._followersClientLanguage,
              clientUuid: !!APIInterceptor._followersClientUuid,
            },
          });

          const hasCursor = () => !!APIInterceptor._preScanFollowersCursor;
          if (!hasCursor()) {
            this._updateAction('Waiting for first followers cursor…');
            const retryCredsInterval = setInterval(() => {
              if (!APIInterceptor._preScanFollowersCursor) {
                window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');
              }
            }, 800);
            await waitForAuth(hasCursor);
            clearInterval(retryCredsInterval);
          }

          let apiSummary = null;
          let stalledPasses = 0;
          for (let pass = 1; pass <= 6 && state.scanning && state.scanned.length < scanLimit; pass++) {
            const before = state.scanned.length;
            apiSummary = await this._collectViaApi(scanLimit, true);
            const gained = state.scanned.length - before;
            dbg('followers API summary', { pass, ...apiSummary, gained });

            if (state.scanned.length >= scanLimit) return;

            if (gained > 0) {
              stalledPasses = 0;
              // Refresh creds/header replay between passes.
              window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');
              await Safety.sleep(250);
              continue;
            }

            stalledPasses++;
            if (!apiSummary.nullPageHit || stalledPasses >= 2) break;
            window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');
            await Safety.sleep(400);
          }
          console.warn('[X-Purge] followers API incomplete/blocked — falling back to scroll+intercept', apiSummary);
        } else {
          console.warn('[X-Purge] followers credentials unavailable — using scroll+intercept');
        }

        await this._collectViaScroll(scanLimit);
        return;
      }

      // Following: try direct API first (fast), fall back to scroll if credentials missing
      const hasAuth = () => !!APIInterceptor._auth;
      if (!hasAuth()) {
        this._updateAction('Waiting for API credentials…');
        await waitForAuth(hasAuth);
      }

      if (hasAuth()) {
        await this._collectViaApi(scanLimit, false);
      } else {
        console.warn('[X-Purge] API credentials unavailable — falling back to DOM scroll');
        await this._collectViaScroll(scanLimit);
      }
    },

    async _collectViaApi(scanLimit, isFollowers) {
      const seenUsernames = new Set(state.scanned.map(a => a.username).filter(Boolean));
      let page   = 0;
      let nullPageHit = false;
      const startCount = state.scanned.length;
      // Followers: use v1.1 REST API (no x-client-transaction-id needed, 200 accounts/page).
      // Following: use GraphQL direct fetch (existing fast path).
      const fetchPage = isFollowers ? DirectFetcher.fetchFollowersPageV1.bind(DirectFetcher)
                                    : DirectFetcher.fetchFollowingPage.bind(DirectFetcher);

      // v1.1 followers API starts from cursor=null (first page); Following also starts from null.
      let cursor = null;
      const ingestFollowersPreScan = () => {
        if (!isFollowers) return 0;
        let added = 0;
        for (const [username, acc] of APIInterceptor._preScanFollowersCache) {
          if (state.scanned.length >= scanLimit) break;
          if (!seenUsernames.has(username)) {
            seenUsernames.add(username);
            state.scanned.push(acc);
            added++;
          }
        }
        return added;
      };
      if (isFollowers) ingestFollowersPreScan();

      // If v1.1 fetch fails for followers (unexpected), fall back to scroll+intercept.
      let followersDirectSkip = false;
      let nativeStallCount = 0;  // consecutive scroll recoveries that didn't advance

      while (state.scanning && state.scanned.length < scanLimit) {
        page++;
        dbg('_collectViaApi page start', { mode: isFollowers ? 'followers' : 'following', page, cursor });
        this._updateAction(`Scanning… ${state.scanned.length} accounts (page ${page})`);
        const json = (isFollowers && followersDirectSkip) ? null : await fetchPage(cursor);
        if (!json) {
          nullPageHit = true;
          if (isFollowers) {
            followersDirectSkip = true;  // skip direct API for all remaining pages this pass
            const prevCursor = APIInterceptor._preScanFollowersCursor ?? null;
            const prevSize   = APIInterceptor._preScanFollowersCache.size;
            this._scrollDown();

            const waited = await (async () => {
              const start = Date.now();
              let nextNudgeAt = start + 700;
              while (Date.now() - start < 5000) {
                const cursorNow = APIInterceptor._preScanFollowersCursor ?? null;
                const sizeNow   = APIInterceptor._preScanFollowersCache.size;
                if (cursorNow !== prevCursor || sizeNow > prevSize) return true;
                if (Date.now() >= nextNudgeAt) {
                  this._scrollDown();
                  nextNudgeAt = Date.now() + 700;
                }
                await Safety.sleep(150);
              }
              return false;
            })();

            if (waited) {
              const added = ingestFollowersPreScan();
              const sizeNow = APIInterceptor._preScanFollowersCache.size;
              const nextCursor = APIInterceptor._preScanFollowersCursor ?? cursor;
              if (added > 0 || nextCursor !== cursor || sizeNow > prevSize) {
                nativeStallCount = 0;
                cursor = nextCursor;
                await Safety.sleep(250);
                continue;
              }
            }
            nativeStallCount++;
            if (nativeStallCount < 3) continue;  // retry scrolling before giving up
          }
          console.warn('[X-Purge] _collectViaApi: fetchPage returned null', { page, cursor });
          break;
        }

        // Successful direct call — reset skip flag in case token refreshed between passes.
        followersDirectSkip = false;
        nativeStallCount = 0;

        const accounts = isFollowers
          ? DirectFetcher.parseResponseV1(json)
          : APIInterceptor.parseResponse(json);
        if (!accounts.length) break;

        for (const acc of accounts) {
          if (state.scanned.length >= scanLimit) break;
          if (!seenUsernames.has(acc.username)) {
            seenUsernames.add(acc.username);
            state.scanned.push(acc);
          }
        }

        cursor = isFollowers
          ? DirectFetcher.extractCursorV1(json)
          : DirectFetcher.extractCursor(json);
        dbg('_collectViaApi page done', {
          mode: isFollowers ? 'followers' : 'following',
          page,
          scanned: state.scanned.length,
          nextCursor: cursor ?? null,
        });
        if (!cursor) break;
        await Safety.sleep(300);
      }

      return {
        mode: isFollowers ? 'followers' : 'following',
        pages: page,
        added: state.scanned.length - startCount,
        scanned: state.scanned.length,
        nullPageHit,
        lastCursor: cursor ?? null,
      };
    },

    _scrollDown() {
      window.scrollBy(0, 1400);
      const col = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
      if (col) col.scrollBy(0, 1400);
    },

    async _collectViaScroll(scanLimit) {
      const seenUsernames = new Set(state.scanned.map(a => a.username).filter(Boolean));
      const isFollowers   = state.mode === 'followers';
      dbg('_collectViaScroll start', {
        mode: isFollowers ? 'followers' : 'following',
        scanLimit,
        existingScanned: state.scanned.length,
        preScanCache: APIInterceptor._preScanFollowersCache.size,
      });
      // Seed with any followers data intercepted before scan started (X fires first batch on page load)
      const apiCache = isFollowers
        ? new Map(APIInterceptor._preScanFollowersCache)
        : new Map();
      const enrichFrom = (scanned, apiAcc) => {
        scanned.profileData = apiAcc.profileData;
        if (apiAcc.restId)                                scanned.restId           = apiAcc.restId;
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

      // Subscribe to the right intercept channel for the current mode
      if (isFollowers) {
        APIInterceptor.subscribeFollowers(onBatch);
      } else {
        APIInterceptor.subscribe(onBatch);
      }

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

        const unsub = () => {
          if (isFollowers) APIInterceptor.unsubscribeFollowers(onBatch);
          else             APIInterceptor.unsubscribe(onBatch);
        };

        const doScroll = () => {
          if (!state.scanning || state.scanned.length >= scanLimit) {
            unsub(); resolve(); return;
          }
          const countBefore = state.scanned.length;
          this._scrollDown();

          let fallbackTimer;
          const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
          const obs  = new MutationObserver(() => {
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
            if (emptyRounds >= MAX_EMPTY) { unsub(); resolve(); }
            else { doScroll(); }
          }, 2000);
        };

        doScroll();
      });
    },

    _showResults(targets, dryRun) {
      const wrap       = document.getElementById('xpurge-results');
      const list       = document.getElementById('result-list');
      const countLabel = document.getElementById('result-count-label');
      const unfAllBtn  = document.getElementById('btn-unfollow-all');
      const isFollowers = state.mode === 'followers';

      wrap.style.display = 'block';
      document.getElementById('result-list').style.display = 'block';
      document.getElementById('results-chevron')?.classList.add('open');

      const updateHeader = () => {
        countLabel.textContent = `${state.targets.length} accounts match filters`;
        if (state.targets.length > 0) {
          const willAct = state.filters.dailyLimit === 0
            ? state.targets.length
            : Math.min(state.targets.length, Math.max(0, state.filters.dailyLimit - state.dailyCount));
          const limitNote = state.filters.dailyLimit === 0 ? 'no daily limit' : `${willAct} under daily limit`;
          const verb = isFollowers ? 'Remove' : 'Unfollow';
          unfAllBtn.textContent = `${verb} All (${limitNote})`;
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
        const verb = isFollowers ? 'Remove' : 'Unfollow';
        list.innerHTML = state.targets.map((acc, idx) => {
          const pd = acc.profileData;
          const stats = [
            pd?.followers != null ? `${fmtNum(pd.followers)} followers` : null,
            pd?.accountAgeMonths != null ? `${pd.accountAgeMonths}mo old` : null,
          ].filter(Boolean).join(' · ');
          const bio = acc.bio
            ? escHtml(acc.bio.slice(0, 65)) + (acc.bio.length > 65 ? '&hellip;' : '')
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
              <button class="ri-unf-btn" data-idx="${idx}">${verb}</button>
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
            const result = await Engine.unfollowOne(acc, state.mode);
            state.running = false;
            if (result.ok) {
              await SW.incrementDaily();
              state.dailyCount++;
              state.targets.splice(idx, 1);
              // Remove from cache
              const ci = state.cachedAccounts.findIndex(a => a.username === acc.username);
              if (ci !== -1) state.cachedAccounts.splice(ci, 1);
              updateHeader();
              renderList();
            } else if (result.rateLimited) {
              btn.disabled = false;
              btn.textContent = verb;
              this._updateAction('Rate limited — wait a few minutes before retrying.');
            } else {
              btn.disabled = false;
              btn.textContent = verb;
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

      const totalTargets = state.targets.length;
      const removedUsernames = new Set();
      state.running = true;

      await Engine.run(
        state.targets,
        state.filters,
        false,
        state.mode,
        {
          onProgress: ({ action, unfollowed, total, next }) => {
            this._updateAction(action);
            this._updateProgress(unfollowed, total, next);
          },
          onEach: (acc, idx) => {
            removedUsernames.add(acc.username);
            const li = document.querySelector(`#result-list li[data-idx="${idx}"]`);
            if (li) li.remove();
            const remaining = state.targets.length - removedUsernames.size;
            const countLabel = document.getElementById('result-count-label');
            if (countLabel) countLabel.textContent = `${remaining} accounts match filters`;
            // Update in-memory cache
            const ci = state.cachedAccounts.findIndex(a => a.username === acc.username);
            if (ci !== -1) state.cachedAccounts.splice(ci, 1);
          },
          onDone: async (count) => {
            this._updateProgress(count, totalTargets, null);
            state.targets = state.targets.filter(a => !removedUsernames.has(a.username));
            // Persist updated cache
            await SW.setScanCache(state.mode, state.cachedAccounts.map(stripElement), state.cacheTime);
            this._updateCacheInfo();

            const unfAllBtn2 = document.getElementById('btn-unfollow-all');
            if (unfAllBtn2) unfAllBtn2.style.display = 'none';
            const list = document.getElementById('result-list');
            if (list && state.targets.length === 0) {
              list.innerHTML = '<li class="xp-hint" style="padding:8px 14px">All done — no more accounts match.</li>';
            }
            this._finishUI(`Done! ${state.mode === 'followers' ? 'Removed' : 'Unfollowed'} ${count} accounts today.`);
          },
        }
      );
    },

    _updateAction(text) {
      const el = document.getElementById('prog-action');
      if (el) el.textContent = text;
    },

    _updateProgress(unfollowed, total, next) {
      const bar    = document.getElementById('prog-bar');
      const stats  = document.getElementById('prog-stats');
      const nextEl = document.getElementById('prog-next');
      const pct    = total > 0 ? Math.round((unfollowed / total) * 100) : 0;
      const verb   = state.mode === 'followers' ? 'removed' : 'unfollowed';
      if (bar)    bar.style.width = pct + '%';
      if (stats)  stats.textContent = `${unfollowed} / ${total} ${verb}`;
      if (nextEl) nextEl.textContent = next ? `Next: @${next}` : '';
    },

    _finishUI(msg) {
      state.running  = false;
      state.scanning = false;
      this._updateAction(msg);
      document.getElementById('btn-stop-wrap').style.display   = 'none';
      document.getElementById('xpurge-actions').style.display  = 'flex';
    },
  };

  // ============================================================
  // ROUTER
  // ============================================================
  function getPageMode() {
    // /followers, /verified_followers, or /{username}/followers → followers mode
    return /\/(followers|verified_followers)\/?$/.test(location.pathname) ? 'followers' : 'following';
  }

  function isFollowingPage() {
    // following, followers, or verified_followers — bare or profile-prefixed paths
    return /\/(following|followers|verified_followers)\/?$/.test(location.pathname);
  }

  function onNavChange() {
    if (isFollowingPage()) {
      const newMode    = getPageMode();
      const modeChanged = state.mode !== newMode;

      state.mode = newMode;
      if (modeChanged) {
        // Reset all scan state when switching between following ↔ followers
        state.cachedAccounts = [];
        state.cacheTime      = null;
        state.targets        = [];
        state.scanned        = [];
      }

      const panel = document.getElementById('xpurge-panel');
      if (!panel) {
        setTimeout(() => {
          UI.inject();
          window.postMessage({ __xpurge: 'REQUEST_CREDENTIALS' }, '*');
        }, 1200);
      } else {
        // Panel already open — update badge immediately
        UI._setModeBadge(state.mode);
        // Reload cache/settings for the new mode
        if (modeChanged) UI._loadSaved();
      }
    } else {
      UI.remove();
    }
  }

  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = (...a) => { _push(...a);    onNavChange(); };
  history.replaceState = (...a) => { _replace(...a); onNavChange(); };
  window.addEventListener('popstate', onNavChange);

  // Belt-and-suspenders: poll the URL every 600ms as fallback for SPAs that navigate
  // without going through the history API (or if X has captured a reference to the
  // original pushState before our patch ran).
  let _lastPolledPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== _lastPolledPath) {
      _lastPolledPath = location.pathname;
      onNavChange();
    }
  }, 600);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE_PANEL') {
      const panel = document.getElementById('xpurge-panel');
      if (panel) {
        UI.remove();
      } else if (isFollowingPage()) {
        UI.inject();
      } else {
        history.pushState({}, '', '/following');
        onNavChange();
      }
      sendResponse({ ok: true });
    }
  });

  // Initial check
  onNavChange();
})();
