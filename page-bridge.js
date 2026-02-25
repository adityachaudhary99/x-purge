// X-Purge Page Bridge
// Runs in the PAGE's main JS context (world: "MAIN", document_start).
// Intercepts X's GraphQL Following + Followers responses and relays:
//   FOLLOWING_PAGE           — raw response JSON (profile data for enrichment)
//   FOLLOWERS_PAGE           — raw response JSON for followers list
//   BEARER_TOKEN             — Authorization header captured from any X API request
//   API_CREDENTIALS          — full credentials for Following scan
//   FOLLOWERS_CREDENTIALS    — full credentials for Followers scan (separate queryId + fieldToggles)
//   FOLLOWER_REMOVE_ENDPOINT — captured endpoint/body X uses for "Remove this follower"

(function () {
  'use strict';
  if (window.__xPurgeBridgeLoaded) return;
  window.__xPurgeBridgeLoaded = true;

  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[X-Purge bridge DEBUG]', ...args); };

  const FOLLOWING_RE    = /\/i\/api\/graphql\/[A-Za-z0-9_-]+\/Following(?!\w)/;
  // Matches Followers AND VerifiedFollowers endpoints (X sub-tab for verified followers)
  const FOLLOWERS_RE    = /\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(Followers|VerifiedFollowers)(?!\w)/;

  // Matches POSTs to X's social-graph REST endpoints and the RemoveFollower GraphQL mutation.
  const SOCIAL_POST_RE  = /\/i\/api\/(1\.1\/(friendships|followers|blocks|mutes)|graphql\/[A-Za-z0-9_-]+\/RemoveFollower)/;

  let _lastCreds          = null;   // Following credentials
  let _followersLastCreds = null;   // Followers credentials
  let _bearer      = null;
  let _queryId     = null;          // Following queryId
  let _followersQueryId   = null;
  let _features    = null;          // shared last-seen features string
  let _fieldToggles = null;         // Followers fieldToggles param (may differ from Following)
  let _userId      = null;

  let _removeFollowerRelayed = false; // relay only once per page
  let _pendingFollowerBatches = [];   // { json, cursor } buffered until content-script listener is ready
  let _followersRawVars = null;       // Exact variables string from X's own Followers API call
  let _followersOperationName = null; // Followers operation name (Followers/VerifiedFollowers)
  let _followersRequestUrl = null;    // Last full Followers request URL from native X client
  let _followersNativeHeaders = null; // { transactionId, clientLanguage, clientUuid } from X's own Followers XHR
  let _followersNativeHeaderBag = null; // last full custom header bag seen on Followers request

  // Extract the bottom cursor from a Followers/Following GraphQL response.
  // Doing this in page-bridge (MAIN world) avoids a second parse in the isolated content-script.
  const _extractBottomCursor = (json) => {
    // Fast path: walk known instruction paths
    try {
      const tryInstructions = (instructions) => {
        if (!Array.isArray(instructions)) return null;
        for (const instr of instructions) {
          const entries = instr.entries ?? (instr.entry ? [instr.entry] : []);
          for (const entry of entries) {
            const c = entry?.content;
            if (!c) continue;
            if (/bottom/i.test(c.cursorType ?? '') && c.value) return c.value;
            if (/cursor[\-_]bottom/i.test(entry.entryId ?? '') && c.value) return c.value;
          }
        }
        return null;
      };
      const r = json?.data?.user?.result;
      const fast = (
        tryInstructions(r?.timeline_v2?.timeline?.instructions) ??
        tryInstructions(r?.timeline?.timeline?.instructions) ??
        null
      );
      if (fast) return fast;
    } catch {}

    // Deep-walk fallback: recursively search the entire JSON tree for any object
    // with cursorType='Bottom' and a value field — handles unexpected response structures.
    const deepFind = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      if (Array.isArray(obj)) {
        for (const item of obj) { const r = deepFind(item); if (r) return r; }
        return null;
      }
      if (obj.cursorType && /bottom/i.test(String(obj.cursorType)) && obj.value && typeof obj.value === 'string') {
        return obj.value;
      }
      for (const key of Object.keys(obj)) { const r = deepFind(obj[key]); if (r) return r; }
      return null;
    };
    try { return deepFind(json); } catch {}
    return null;
  };

  // Fallback: read userId from twid cookie ("u%3D{id}" or "u={id}").
  const _getUserIdFromCookie = () => {
    const m = document.cookie.match(/(?:^|;\s*)twid=u(?:%3D|=)"?(\d+)/i);
    return m ? m[1] : null;
  };

  // ── Following credentials ──────────────────────────────────────────────────
  const _tryRelay = () => {
    if (_lastCreds) return;
    const userId = _userId || _getUserIdFromCookie();
    if (!_queryId || !_bearer || !userId) return;
    _lastCreds = { queryId: _queryId, features: _features, variables: JSON.stringify({ userId }), authorization: _bearer };
    window.postMessage({ __xpurge: 'API_CREDENTIALS', ..._lastCreds }, '*');
  };

  // ── Followers credentials ──────────────────────────────────────────────────
  const _tryRelayFollowers = () => {
    const userId = _userId || _getUserIdFromCookie();
    if (!_followersQueryId || !_bearer || !userId) return;
    const nextCreds = {
      queryId:      _followersQueryId,
      operation:    _followersOperationName || 'Followers',
      features:     _features,
      fieldToggles: _fieldToggles,
      variables:    JSON.stringify({ userId }),
      rawVars:      _followersRawVars,   // X's exact variables string — mirror it for direct API calls
      requestUrl:   _followersRequestUrl,
      authorization: _bearer,
    };
    const same = !!_followersLastCreds
      && _followersLastCreds.queryId      === nextCreds.queryId
      && _followersLastCreds.operation    === nextCreds.operation
      && _followersLastCreds.features     === nextCreds.features
      && _followersLastCreds.fieldToggles === nextCreds.fieldToggles
      && _followersLastCreds.variables    === nextCreds.variables
      && _followersLastCreds.rawVars      === nextCreds.rawVars
      && _followersLastCreds.requestUrl   === nextCreds.requestUrl
      && _followersLastCreds.authorization === nextCreds.authorization;
    if (same) return;
    _followersLastCreds = nextCreds;
    dbg('FOLLOWERS_CREDENTIALS assembled', {
      queryId: _followersLastCreds.queryId,
      operation: _followersLastCreds.operation,
      hasFeatures: !!_followersLastCreds.features,
      hasFieldToggles: !!_followersLastCreds.fieldToggles,
      hasRawVars: !!_followersLastCreds.rawVars,
      hasRequestUrl: !!_followersLastCreds.requestUrl,
      userId,
    });
    window.postMessage({ __xpurge: 'FOLLOWERS_CREDENTIALS', ..._followersLastCreds }, '*');
  };

  // ── Bearer capture ─────────────────────────────────────────────────────────
  const _captureBearer = (value) => {
    if (String(value).startsWith('Bearer ')) {
      const changed = _bearer !== value;
      _bearer = value;
      if (changed) {
        window.postMessage({ __xpurge: 'BEARER_TOKEN', authorization: _bearer }, '*');
        _tryRelay();
        _tryRelayFollowers();
      }
    }
  };

  const _nativeHSet = Headers.prototype.set;
  Headers.prototype.set = function (name, value) {
    if (name.toLowerCase() === 'authorization') _captureBearer(value);
    return _nativeHSet.apply(this, arguments);
  };

  const _nativeHAppend = Headers.prototype.append;
  Headers.prototype.append = function (name, value) {
    if (name.toLowerCase() === 'authorization') _captureBearer(value);
    return _nativeHAppend.apply(this, arguments);
  };

  // ── Re-send buffered credentials on request ────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.__xpurge === 'REQUEST_CREDENTIALS') {
      _tryRelayFollowers();
      if (_lastCreds) window.postMessage({ __xpurge: 'API_CREDENTIALS', ..._lastCreds }, '*');
      else if (_bearer) { window.postMessage({ __xpurge: 'BEARER_TOKEN', authorization: _bearer }, '*'); _tryRelay(); }
      if (_followersLastCreds) window.postMessage({ __xpurge: 'FOLLOWERS_CREDENTIALS', ..._followersLastCreds }, '*');
      // Replay any buffered FOLLOWERS_PAGE batches so the content-script's pre-scan cache is seeded.
      // These fire at document_start before content-script's listener exists — buffering here bridges that gap.
      if (_followersNativeHeaders) {
        window.postMessage({ __xpurge: 'FOLLOWERS_NATIVE_HEADERS', ..._followersNativeHeaders }, '*');
      }
      if (_pendingFollowerBatches.length) {
        for (const batch of _pendingFollowerBatches) {
          window.postMessage({ __xpurge: 'FOLLOWERS_PAGE', json: batch.json, cursor: batch.cursor }, '*');
        }
      }
      dbg('REQUEST_CREDENTIALS replay', {
        hasFollowersCreds: !!_followersLastCreds,
        hasFollowersHeaders: !!_followersNativeHeaders,
        hasFollowersHeaderBag: !!_followersNativeHeaderBag,
        pendingFollowerBatches: _pendingFollowerBatches.length,
      });
      return;
    }

    // Execute followers GraphQL request from PAGE context (x.com origin) and return
    // response to content-script. This avoids extension-origin fetch fingerprints.
    if (event.data?.__xpurge === 'DIRECT_FETCH_FOLLOWERS_PAGE') {
      const { requestId, url, headers } = event.data || {};
      if (!requestId || !url) return;
      (async () => {
        try {
          const getCI = (obj, key) => {
            const k = Object.keys(obj || {}).find((x) => x.toLowerCase() === key.toLowerCase());
            return k ? obj[k] : null;
          };
          const mergeHeadersCI = (...sources) => {
            const out = {};
            const seen = new Set();
            for (const src of sources) {
              for (const [k, v] of Object.entries(src || {})) {
                if (v == null || v === '') continue;
                const lk = String(k).toLowerCase();
                if (seen.has(lk)) continue; // first source wins
                seen.add(lk);
                out[k] = String(v);
              }
            }
            return out;
          };
          // Prefer headers from native followers XHR/fetch over forwarded content-script headers.
          // Using native values avoids token mismatches (401 code 89).
          const nativeBag = _followersNativeHeaderBag || {};
          const forwarded = headers || {};
          const mergedHeaders = mergeHeadersCI(nativeBag, forwarded);
          if (!getCI(mergedHeaders, 'X-Client-Transaction-Id') && _followersNativeHeaders?.transactionId) {
            mergedHeaders['X-Client-Transaction-Id'] = _followersNativeHeaders.transactionId;
          }
          if (!getCI(mergedHeaders, 'X-Twitter-Client-Language') && _followersNativeHeaders?.clientLanguage) {
            mergedHeaders['X-Twitter-Client-Language'] = _followersNativeHeaders.clientLanguage;
          }
          if (!getCI(mergedHeaders, 'X-Client-Uuid') && _followersNativeHeaders?.clientUuid) {
            mergedHeaders['X-Client-Uuid'] = _followersNativeHeaders.clientUuid;
          }

          dbg('DIRECT_FETCH_FOLLOWERS_PAGE request', {
            requestId,
            url,
            headerKeys: Object.keys(mergedHeaders),
            hasTransactionId: !!getCI(mergedHeaders, 'X-Client-Transaction-Id'),
            hasClientLanguage: !!getCI(mergedHeaders, 'X-Twitter-Client-Language'),
            hasClientUuid: !!getCI(mergedHeaders, 'X-Client-Uuid'),
            hasAuthorization: !!getCI(mergedHeaders, 'Authorization'),
            hasCsrf: !!getCI(mergedHeaders, 'X-Csrf-Token'),
            hasNativeAuth: !!getCI(nativeBag, 'Authorization'),
            hasForwardedAuth: !!getCI(forwarded, 'Authorization'),
          });

          const result = await new Promise((resolve) => {
            try {
              const xhr = new XMLHttpRequest();
              xhr.__xpSyntheticFollowers = true;
              xhr.open('GET', url, true);
              xhr.withCredentials = true;
              for (const [k, v] of Object.entries(mergedHeaders)) {
                if (v == null || v === '') continue;
                try { xhr.setRequestHeader(k, String(v)); } catch {}
              }
              xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                resolve({ status: xhr.status, body: xhr.responseText || '' });
              };
              xhr.onerror = function () { resolve({ status: 0, body: '' }); };
              xhr.send();
            } catch {
              resolve({ status: 0, body: '' });
            }
          });

          const { status, body } = result;
          if (!(status >= 200 && status < 300)) {
            window.postMessage({
              __xpurge: 'DIRECT_FETCH_FOLLOWERS_PAGE_RESULT',
              requestId,
              ok: false,
              status,
              body,
            }, '*');
            dbg('DIRECT_FETCH_FOLLOWERS_PAGE failure', { requestId, status, bodyPreview: String(body).slice(0, 120) });
            return;
          }

          let json = null;
          try { json = JSON.parse(body); } catch {}
          if (!json) {
            window.postMessage({
              __xpurge: 'DIRECT_FETCH_FOLLOWERS_PAGE_RESULT',
              requestId,
              ok: false,
              status,
              body,
            }, '*');
            dbg('DIRECT_FETCH_FOLLOWERS_PAGE non-json', { requestId, status });
            return;
          }
          window.postMessage({
            __xpurge: 'DIRECT_FETCH_FOLLOWERS_PAGE_RESULT',
            requestId,
            ok: true,
            status,
            json,
          }, '*');
          dbg('DIRECT_FETCH_FOLLOWERS_PAGE success', { requestId, status });
        } catch (e) {
          window.postMessage({
            __xpurge: 'DIRECT_FETCH_FOLLOWERS_PAGE_RESULT',
            requestId,
            ok: false,
            status: 0,
            error: String(e),
          }, '*');
          dbg('DIRECT_FETCH_FOLLOWERS_PAGE error', { requestId, error: String(e) });
        }
      })();
    }
  });

  // ── Helper: extract all useful params from a GraphQL URL ───────────────────
  const _extractFromUrl = (url) => {
    const queryId = url.match(/\/graphql\/([A-Za-z0-9_-]+)\//)?.[1];
    const operation = url.match(/\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)(?:$|[/?#])/i)?.[1] ?? null;
    if (!queryId) return null;
    const urlObj     = new URL(url, location.href);
    const features   = urlObj.searchParams.get('features');
    const fieldToggles = urlObj.searchParams.get('fieldToggles');
    const rawVars    = urlObj.searchParams.get('variables');
    let userId = null;
    if (rawVars && !_userId) {
      try { userId = JSON.parse(rawVars).userId ?? null; } catch {}
    }
    const out = { queryId, operation, features, fieldToggles, userId, rawVars, requestUrl: new URL(url, location.href).href };
    try {
      const varsObj = rawVars ? JSON.parse(rawVars) : null;
      dbg('GraphQL URL captured', {
        queryId,
        operation,
        paramKeys: Array.from(urlObj.searchParams.keys()),
        varsKeys: varsObj && typeof varsObj === 'object' ? Object.keys(varsObj) : [],
      });
    } catch {
      dbg('GraphQL URL captured', { queryId, operation, paramKeys: Array.from(urlObj.searchParams.keys()), varsKeys: ['(unparseable)'] });
    }
    return out;
  };

  // ── Helper: read request headers into a plain object ──────────────────────
  const _readHeaders = (args) => {
    const init = args[1] ?? {};
    const hdrs = init.headers ?? (typeof args[0] === 'object' ? args[0]?.headers : null);
    const get = (n) => {
      if (!hdrs) return null;
      if (typeof hdrs.get === 'function') return hdrs.get(n);
      return hdrs[n] ?? hdrs[n.toLowerCase()] ?? null;
    };
    return get;
  };

  // Read request headers as a plain object when possible (for replaying full native header sets).
  const _readHeadersObject = (args) => {
    const init = args[1] ?? {};
    const hdrs = init.headers ?? (typeof args[0] === 'object' ? args[0]?.headers : null);
    if (!hdrs) return {};
    if (typeof hdrs.forEach === 'function') {
      const out = {};
      hdrs.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(hdrs)) {
      const out = {};
      for (const [k, v] of hdrs) out[String(k)] = String(v);
      return out;
    }
    if (typeof hdrs === 'object') return { ...hdrs };
    return {};
  };

  // ── Patch fetch ────────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url    = (typeof args[0] === 'string' ? args[0] : args[0]?.url) ?? '';
    const method = (args[1]?.method ?? (typeof args[0] === 'object' ? args[0]?.method : null) ?? 'GET').toUpperCase();
    const resp   = await _fetch.apply(this, args);

    // ── Following GraphQL ──────────────────────────────────────────────────
    if (FOLLOWING_RE.test(url)) {
      resp.clone().json().then(json => {
        window.postMessage({ __xpurge: 'FOLLOWING_PAGE', json }, '*');
      }).catch(() => {});

      if (!_lastCreds) {
        try {
          const extracted = _extractFromUrl(url);
          if (extracted) {
            _queryId = extracted.queryId;
            if (extracted.features) _features = extracted.features;
            if (extracted.userId)   _userId   = extracted.userId;
            const get = _readHeaders(args);
            const authFromOpts = get('Authorization');
            if (authFromOpts) _captureBearer(authFromOpts);
            _tryRelay();
          }
        } catch (e) { console.warn('[X-Purge bridge] Following credential capture error:', e); }
      }
    }

    // ── Followers GraphQL ──────────────────────────────────────────────────
    if (FOLLOWERS_RE.test(url)) {
      dbg('Followers native request intercepted (fetch)', { method, url });
      // Capture native headers from fetch call (X may use fetch, not XHR, so setRequestHeader won't fire).
      try {
        const bag = _readHeadersObject(args);
        if (Object.keys(bag).length) {
          _followersNativeHeaderBag = bag;
          dbg('Followers native header bag captured (fetch)', { headerKeys: Object.keys(bag) });
        }
        const get = _readHeaders(args);
        const tid  = get('x-client-transaction-id');
        const lang = get('x-twitter-client-language');
        const uuid = get('x-client-uuid');
        if (tid || lang || uuid) {
          _followersNativeHeaders = { transactionId: tid ?? null, clientLanguage: lang ?? null, clientUuid: uuid ?? null };
          dbg('Followers native headers captured (fetch)', {
            hasTransactionId: !!tid,
            hasClientLanguage: !!lang,
            hasClientUuid: !!uuid,
          });
          window.postMessage({ __xpurge: 'FOLLOWERS_NATIVE_HEADERS', ..._followersNativeHeaders }, '*');
        }
      } catch {}

      if (!resp.ok) return resp;
      resp.clone().json().then(json => {
        // Buffer raw JSON — content-script may not have its listener up yet (loads at document_idle,
        // this fires at document_start). Replayed via REQUEST_CREDENTIALS handler below.
        const cursor = _extractBottomCursor(json);
        dbg('Followers native response (fetch)', {
          status: resp.status,
          ok: resp.ok,
          cursor: cursor ?? null,
          bufferedBatchesBefore: _pendingFollowerBatches.length,
        });
        _pendingFollowerBatches.push({ json, cursor });
        window.postMessage({ __xpurge: 'FOLLOWERS_PAGE', json, cursor }, '*');
      }).catch((e) => { console.warn('[X-Purge bridge] FOLLOWERS_PAGE JSON parse failed:', e); });

      try {
        const extracted = _extractFromUrl(url);
        if (extracted) {
          _followersQueryId = extracted.queryId;
          if (extracted.operation)    _followersOperationName = extracted.operation;
          if (extracted.features)     _features        = extracted.features;
          if (extracted.fieldToggles) _fieldToggles    = extracted.fieldToggles;
          if (extracted.userId)       _userId          = extracted.userId;
          if (extracted.rawVars)      _followersRawVars = extracted.rawVars;
          if (extracted.requestUrl)   _followersRequestUrl = extracted.requestUrl;
          _tryRelayFollowers();
        }
      } catch (e) { console.warn('[X-Purge bridge] Followers credential capture error:', e); }
    }

    // ── Social-graph POST — capture remove-follower / unfollow endpoints ───
    if (method === 'POST' && SOCIAL_POST_RE.test(url)) {
      const bodyRaw = args[1]?.body ?? (typeof args[0] === 'object' ? args[0]?.body : null) ?? '';
      const bodyStr = typeof bodyRaw === 'string' ? bodyRaw : '(non-string body)';

      // Detect X's "Remove this follower" endpoint and relay it.
      // X uses a GraphQL mutation: POST /i/api/graphql/{queryId}/RemoveFollower
      // with JSON body {"variables":{"target_user_id":"..."},"queryId":"..."}
      if (!_removeFollowerRelayed && /RemoveFollower|followers\/remove|friendships\/(remove|destroy)|followers\/destroy/i.test(url)) {
        _removeFollowerRelayed = true;
        window.postMessage({ __xpurge: 'FOLLOWER_REMOVE_ENDPOINT', url, bodyExample: bodyStr }, '*');
      }
    }

    return resp;
  };

  // ── Patch XHR ──────────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xpMode   = null;
    this.__xpMethod = (method || 'GET').toUpperCase();
    this.__xpUrl    = url;

    if (FOLLOWING_RE.test(url)) {
      this.__xpMode = 'following';
      if (!_lastCreds) {
        try {
          const extracted = _extractFromUrl(url);
          if (extracted) {
            _queryId = extracted.queryId;
            if (extracted.features) _features = extracted.features;
            if (extracted.userId)   _userId   = extracted.userId;
            _tryRelay();
          }
        } catch {}
      }
    } else if (FOLLOWERS_RE.test(url)) {
      this.__xpMode = this.__xpSyntheticFollowers ? 'followers_synthetic' : 'followers';
      dbg('Followers native request intercepted (xhr/open)', { method: this.__xpMethod, url, synthetic: !!this.__xpSyntheticFollowers });
      if (!this.__xpSyntheticFollowers) {
        try {
          const extracted = _extractFromUrl(url);
          if (extracted) {
            _followersQueryId = extracted.queryId;
            if (extracted.operation)    _followersOperationName = extracted.operation;
            if (extracted.features)     _features          = extracted.features;
            if (extracted.fieldToggles) _fieldToggles      = extracted.fieldToggles;
            if (extracted.userId)       _userId            = extracted.userId;
            if (extracted.rawVars)      _followersRawVars  = extracted.rawVars;
            if (extracted.requestUrl)   _followersRequestUrl = extracted.requestUrl;
            _tryRelayFollowers();
          }
        } catch {}
      }
    } else if (this.__xpMethod === 'POST' && SOCIAL_POST_RE.test(url)) {
      this.__xpMode = 'social_post';
    }

    return _open.apply(this, [method, url, ...rest]);
  };

  const _setReqHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'authorization' && !this.__xpSyntheticFollowers) _captureBearer(value);
    // Capture X's dynamically-generated headers from native Followers XHR so we can mirror them.
    if (this.__xpMode === 'followers' || this.__xpMode === 'following') {
      const lower = name.toLowerCase();
      if (this.__xpMode === 'followers' && !this.__xpSyntheticFollowers) {
        this.__xpHeaderBag = this.__xpHeaderBag || {};
        this.__xpHeaderBag[name] = value;
      }
      if (lower === 'x-client-transaction-id') this.__xpTransactionId = value;
      if (lower === 'x-twitter-client-language') this.__xpClientLang = value;
      if (lower === 'x-client-uuid') this.__xpClientUuid = value;
      if (this.__xpMode === 'followers' && !this.__xpSyntheticFollowers
        && /^(x-client-transaction-id|x-twitter-client-language|x-client-uuid)$/i.test(name)) {
        dbg('Followers native request header (xhr)', { name: lower, present: !!value });
      }
    }
    return _setReqHdr.apply(this, arguments);
  };

  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xpMode === 'following') {
      this.addEventListener('load', function () {
        try { window.postMessage({ __xpurge: 'FOLLOWING_PAGE', json: JSON.parse(this.responseText) }, '*'); } catch {}
      });
    } else if (this.__xpMode === 'followers') {
      if (this.__xpSyntheticFollowers) {
        return _send.apply(this, args);
      }
      // Store and relay X's dynamic request headers — content-script needs them to make its own
      // Followers requests. x-client-transaction-id is required by the Followers endpoint.
      // Stored globally so REQUEST_CREDENTIALS can replay them (handles hard-reload race condition).
      if (this.__xpTransactionId || this.__xpClientLang || this.__xpClientUuid) {
        _followersNativeHeaders = {
          transactionId:  this.__xpTransactionId  ?? null,
          clientLanguage: this.__xpClientLang ?? null,
          clientUuid: this.__xpClientUuid ?? null,
        };
        window.postMessage({ __xpurge: 'FOLLOWERS_NATIVE_HEADERS', ..._followersNativeHeaders }, '*');
      }
      if (this.__xpHeaderBag && Object.keys(this.__xpHeaderBag).length) {
        _followersNativeHeaderBag = { ...this.__xpHeaderBag };
        dbg('Followers native header bag captured (xhr)', { headerKeys: Object.keys(_followersNativeHeaderBag) });
      }
      this.addEventListener('load', function () {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const json = JSON.parse(this.responseText);
          const cursor = _extractBottomCursor(json);
          _pendingFollowerBatches.push({ json, cursor });
          dbg('Followers native response (xhr)', {
            status: this.status,
            ok: this.status >= 200 && this.status < 300,
            cursor: cursor ?? null,
            bufferedBatches: _pendingFollowerBatches.length,
          });
          window.postMessage({ __xpurge: 'FOLLOWERS_PAGE', json, cursor }, '*');
        } catch {}
      });
    } else if (this.__xpMode === 'social_post') {
      const url = this.__xpUrl;
      const bodyStr = typeof args[0] === 'string' ? args[0] : '(non-string)';
      this.addEventListener('load', function () {
        if (!_removeFollowerRelayed && /RemoveFollower|followers\/remove|friendships\/(remove|destroy)|followers\/destroy/i.test(url)) {
          _removeFollowerRelayed = true;
          window.postMessage({ __xpurge: 'FOLLOWER_REMOVE_ENDPOINT', url, bodyExample: bodyStr }, '*');
        }
      });
    }
    return _send.apply(this, args);
  };

})();
