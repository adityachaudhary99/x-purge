// X-Purge Page Bridge
// Runs in the PAGE's main JS context (world: "MAIN", document_start).
// Intercepts X's GraphQL Following responses and relays:
//   FOLLOWING_PAGE   — raw response JSON (profile data for enrichment)
//   BEARER_TOKEN     — Authorization header captured from any X API request
//   API_CREDENTIALS  — full credentials (queryId + features + userId + bearer)
//                      assembled once all pieces are available

(function () {
  'use strict';
  if (window.__xPurgeBridgeLoaded) return;
  window.__xPurgeBridgeLoaded = true;

  const FOLLOWING_RE = /\/i\/api\/graphql\/[A-Za-z0-9_-]+\/Following/;

  let _lastCreds = null;  // full assembled credentials for API scan
  let _bearer    = null;  // Bearer token — captured as soon as X sets it on any Headers object
  let _queryId   = null;  // captured from Following request URL
  let _features  = null;
  let _userId    = null;  // logged-in user's numeric ID — from Following URL variables

  // Fallback: read userId from the twid cookie (value is "u%3D{id}" or "u={id}").
  const _getUserIdFromCookie = () => {
    const m = document.cookie.match(/(?:^|;\s*)twid=u(?:%3D|=)"?(\d+)/i);
    return m ? m[1] : null;
  };

  // Try to assemble full scan credentials once all pieces are ready.
  const _tryRelay = () => {
    if (_lastCreds) return;
    const userId = _userId || _getUserIdFromCookie();
    if (!_queryId || !_bearer || !userId) return;
    _lastCreds = {
      queryId:       _queryId,
      features:      _features,
      variables:     JSON.stringify({ userId }),
      authorization: _bearer,
    };
    window.postMessage({ __xpurge: 'API_CREDENTIALS', ..._lastCreds }, '*');
  };

  // ── Patch Headers to capture the Bearer token ──────────────────────────────
  // X's service worker injects Authorization into requests AFTER the main-world
  // fetch() call, so we cannot read it from fetch() options. However, X's JS
  // code MUST create a Headers object with the token before handing it off.
  // Patching set/append lets us grab it at that point.
  const _captureBearer = (value) => {
    if (!_bearer && String(value).startsWith('Bearer ')) {
      _bearer = value;
      // Relay immediately for unfollow (no queryId needed for REST unfollow)
      window.postMessage({ __xpurge: 'BEARER_TOKEN', authorization: _bearer }, '*');
      _tryRelay(); // also attempt full credential assembly
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

  // ── Re-send buffered credentials on request (document_start vs document_idle race) ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.__xpurge === 'REQUEST_CREDENTIALS') {
      if (_lastCreds) {
        window.postMessage({ __xpurge: 'API_CREDENTIALS', ..._lastCreds }, '*');
      } else if (_bearer) {
        window.postMessage({ __xpurge: 'BEARER_TOKEN', authorization: _bearer }, '*');
        _tryRelay();
      }
    }
  });

  // ── Patch fetch ──────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) ?? '';
    const resp = await _fetch.apply(this, args);

    if (FOLLOWING_RE.test(url)) {
      // Relay the response payload for enrichment
      resp.clone().json().then(json => {
        window.postMessage({ __xpurge: 'FOLLOWING_PAGE', json }, '*');
      }).catch(() => {});

      // Capture queryId and features from the URL; try bearer from options too
      if (!_lastCreds) {
        try {
          const queryId = url.match(/\/graphql\/([A-Za-z0-9_-]+)\//)?.[1];
          if (queryId) {
            _queryId = queryId;
            const urlObj = new URL(url, location.href);
            _features = urlObj.searchParams.get('features');

            // Extract userId from the URL variables — more reliable than the cookie.
            const rawVars = urlObj.searchParams.get('variables');
            if (rawVars && !_userId) {
              try { _userId = JSON.parse(rawVars).userId ?? null; } catch {}
            }

            // Also try to get bearer from fetch() options (may already be in _bearer
            // from the Headers.prototype.set patch above, but try here as well)
            const init = args[1] ?? {};
            const hdrs = init.headers ?? (typeof args[0] === 'object' ? args[0]?.headers : null);
            const get  = (n) => {
              if (!hdrs) return null;
              if (typeof hdrs.get === 'function') return hdrs.get(n);
              return hdrs[n] ?? hdrs[n.toLowerCase()] ?? null;
            };
            const authFromOpts = get('Authorization');
            if (authFromOpts) _captureBearer(authFromOpts);

            _tryRelay();
          }
        } catch (e) {
          console.warn('[X-Purge bridge] Credential capture error:', e);
        }
      }
    }
    return resp;
  };

  // ── Patch XHR ────────────────────────────────────────────────────────────
  // X uses XHR (not fetch) for GraphQL requests. We extract queryId + userId
  // from the URL here, then _tryRelay() completes once the bearer is also set.
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (FOLLOWING_RE.test(url)) {
      this.__xpFollowing = true;
      if (!_lastCreds) {
        try {
          const queryId = url.match(/\/graphql\/([A-Za-z0-9_-]+)\//)?.[1];
          if (queryId) {
            _queryId = queryId;
            const urlObj = new URL(url, location.href);
            _features = urlObj.searchParams.get('features');
            const rawVars = urlObj.searchParams.get('variables');
            if (rawVars && !_userId) {
              try { _userId = JSON.parse(rawVars).userId ?? null; } catch {}
            }
            _tryRelay(); // completes once bearer is also set (from Headers.prototype.set or setRequestHeader)
          }
        } catch {}
      }
    }
    return _open.apply(this, [method, url, ...rest]);
  };

  const _setReqHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'authorization') _captureBearer(value); // also calls _tryRelay
    return _setReqHdr.apply(this, arguments);
  };

  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xpFollowing) {
      this.addEventListener('load', function () {
        try {
          window.postMessage({ __xpurge: 'FOLLOWING_PAGE', json: JSON.parse(this.responseText) }, '*');
        } catch {}
      });
    }
    return _send.apply(this, args);
  };

})();
