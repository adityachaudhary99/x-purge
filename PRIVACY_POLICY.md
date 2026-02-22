# Privacy Policy — X-Purge

_Last updated: February 2025_

## Summary

X-Purge does **not** collect, transmit, or share any personal data. Everything the extension does stays on your device.

---

## What data the extension accesses

| Data | Purpose | Stored? | Sent externally? |
|------|---------|---------|-----------------|
| X authentication tokens (Bearer token, `ct0` cookie) | Required to call X's own API on your behalf — the same way your browser does | No — held in memory only, cleared on page reload | No |
| Your Following list (fetched from X's GraphQL API) | Displayed in the extension panel for you to review and filter | No | No |
| Filter settings and daily unfollow count | Persisted so your preferences survive page reloads | Yes — `chrome.storage.local` (your device only) | No |
| Global whitelist (usernames you protect) | Persisted so whitelisted accounts are never unfollowed accidentally | Yes — `chrome.storage.local` (your device only) | No |

## What the extension does NOT do

- Does not send any data to any server other than `x.com` / `twitter.com`
- Does not read your DMs, tweets, or any content outside the Following list
- Does not use analytics, telemetry, or crash reporting
- Does not inject ads or affiliate links

## Third-party services

X-Purge makes direct API calls to `x.com` and `twitter.com` using your existing authenticated session. These calls are functionally identical to what your browser makes when you scroll your Following page. X's own privacy policy governs those requests.

## Data retention

All locally stored data (filter settings, whitelist, daily counter) can be cleared at any time by:
- Removing the extension from `chrome://extensions`
- Clearing extension storage via Chrome's developer tools

## Contact

Open an issue at the project's GitHub repository.
