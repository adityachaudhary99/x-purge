# ⚡ X-Purge

**Smart X (Twitter) follower/following manager — no API key, no subscription, runs entirely in your browser.**

X-Purge is a Chrome extension (Manifest V3) that scans your **Following** and **Followers** lists using X's own internal APIs and lets you bulk-manage accounts based on a rich set of filters. It operates directly on `x.com` — no external servers, no data collection, no $200/mo API plan.

---

## Features

### Modes
| Mode | What it does |
|------|-------------|
| **Following** | Scan accounts you follow — unfollow in bulk |
| **Followers** | Scan accounts that follow you — remove followers in bulk |

### Filters
| Category | Filter |
|----------|--------|
| **Relationship** | Not following back · Protect mutuals · Followed more than N months ago |
| **Activity** | Inactive for more than N days (detects never-tweeted accounts too) |
| **Profile Quality** | Default avatar ("egg") · Exclude verified · Follower/following ratio below X · Protect accounts with ≥ N followers · Account age below N months |
| **Keywords** | Bio blacklist (e.g. `crypto, nft, bot`) · Bio whitelist (e.g. `founder, vc`) |
| **Safety** | Daily remove cap · Scan limit · Global whitelist (never touch specific accounts) |

### UX
- **Scan first, act later** — preview every matched account with reason, follower count, account age, and bio before unfollowing anything
- **Per-account controls** — Skip or Unfollow individual accounts from the results list
- **Unfollow All** — batch-unfollow everything in the list with a single click
- **Split view** — Filters and Results panels share the panel height equally; both are always visible after a scan. Each section can also be independently collapsed with the ▾ toggle
- **Safety heat meter** — visual Green → Red indicator that warns when daily limit is set aggressively; an inline warning appears when the limit exceeds 200
- **Daily counter** — resets at midnight; persisted in `chrome.storage.local`

---

## How It Works

X-Purge uses two content scripts running in different execution worlds:

### `page-bridge.js` — MAIN world, `document_start`
Patches the page's native `fetch`, `XMLHttpRequest`, and `Headers` prototypes before X's own JS loads:
- **`Headers.prototype.set/append`** — intercepts X's `Authorization: Bearer …` header the moment X's code creates it
- **`XMLHttpRequest.prototype.open`** — captures the GraphQL `queryId`, `userId`, and `features` from organic Following/Followers request URLs
- Intercepts native Followers XHR responses and relays them to the isolated world as a pre-scan cache (seeds the scan before the user clicks Scan)
- Assembles full API credentials and relays them to the isolated world via `window.postMessage`

### `content-script.js` — ISOLATED world, `document_idle`
**Following mode:**
- Calls `GET /i/api/graphql/{queryId}/Following` directly, paginating 200 accounts at a time — no DOM scrolling required
- Unfollows via `POST /i/api/1.1/friendships/destroy.json`

**Followers mode:**
- Primary: calls `GET /i/api/1.1/followers/list.json` directly — 200 accounts per page, no special anti-bot headers required
- Removes followers via `POST /i/api/graphql/{queryId}/RemoveFollower` (block+unblock fallback if GQL unavailable)
- Fallback: DOM scroll + XHR interception if the REST API is unavailable

### `service-worker.js`
Manages all persistent state (daily counter, whitelist, filter settings) via `chrome.storage.local`. The daily counter auto-resets at midnight.

---

## Known Limitations

### Followers GraphQL endpoint (404 / Cloudflare WAF)
The `GET /i/api/graphql/{queryId}/Followers` endpoint is protected by Cloudflare WAF and requires an `x-client-transaction-id` header — a time-based, single-use token computed client-side by X's JavaScript using a private key baked into their bundle. We cannot generate or reuse this token, so direct GraphQL calls to the Followers endpoint will always 404.

**Current mitigation:** the extension uses the REST v1.1 `followers/list.json` endpoint as primary (which does not require the token) and falls back to scroll-triggered XHR interception if needed. Both paths work correctly in practice.

---

## Installation

> X-Purge is available on the Chrome Web Store, or you can load it as an unpacked extension.

1. **Clone or download** this repository:
   ```bash
   git clone https://github.com/adityachaudhary99/x-purge.git
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the `x-purge` folder

5. Pin the extension from the puzzle-piece menu if you'd like quick access

---

## Usage

1. Navigate to **`x.com/following`** or **`x.com/{username}/followers`** — the panel appears automatically

2. **Configure filters** in the Filters section (all filters are off by default)

3. Click **Scan** — the extension fetches your following list via the API and shows every account that matches your filters, with reason, stats, and bio preview

4. Review the list:
   - Click **Skip** to exclude an account from the current results
   - Click **Unfollow** to unfollow a single account immediately
   - Click **Unfollow All** to process the entire list

5. Toggle the **Filters ▾** header to adjust filters and re-scan without leaving the page

> **Tip:** The bio whitelist takes priority over all other filters — accounts whose bio contains a whitelisted keyword are always protected, even if they match other criteria.

---

## Safety

- **Daily cap** defaults to 50 unfollows/day, adjustable up to 2000 or **All** (no cap). The heat meter turns orange above 100 and red above 200; a warning appears at any setting above 200 noting X may rate-limit or restrict the account
- **Batch pause**: a silent 1–3 second pause fires every 10 unfollows to reduce rate-limit risk
- **Global whitelist**: accounts added to the whitelist are never unfollowed regardless of any filter
- **No DOM automation for unfollows**: direct REST API calls (`destroy.json`) are used instead of simulating button clicks, making the flow faster and less detectable

---

## File Structure

```
x-purge/
├── manifest.json        # MV3 manifest — permissions, content script declarations
├── page-bridge.js       # MAIN world bridge — patches fetch/XHR/Headers, captures auth
├── content-script.js    # ISOLATED world — scan engine, filter logic, UI controller
├── overlay.css          # Styles for the injected side-panel
├── service-worker.js    # Background worker — daily counter, whitelist, filter persistence
├── popup.html           # Extension popup — status + quick navigation
├── popup.js             # Popup logic
└── icons/               # Extension icons (16, 48, 128px)
```

---

## Contributing

Contributions are welcome. Please open an issue before starting work on a significant change so we can discuss approach.

**Areas where help is appreciated:**
- Firefox / Manifest V2 compatibility
- Support for accounts blocked/muted (as a filter input)
- i18n / localization
- More robust `followed_date` capture (currently relies on account age as a proxy)

**To contribute:**
1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes with a clear message
4. Open a pull request

---

## Permissions

| Permission | Why it's needed |
|-----------|-----------------|
| `storage` | Persist daily counter, whitelist, and filter settings |
| `tabs` | Detect active tab URL to show/hide the popup button |
| `windows` | Focus the X browser window when opening from the popup |
| `host_permissions: x.com, twitter.com` | Content scripts and direct API calls to X's endpoints |

X-Purge does **not** collect, transmit, or store any of your data externally. Everything stays in your browser.

---

## Chrome Web Store

### Build the submission package

```bash
bash build.sh        # → creates x-purge-<version>.zip
# Windows:
.\build.ps1
```

### Store listing checklist

| Item | Notes |
|------|-------|
| **Package** | Run `bash build.sh` — upload the resulting `.zip` |
| **Short description** | ≤132 chars — already set in `manifest.json` |
| **Detailed description** | Copy/adapt from this README |
| **Category** | `Productivity` |
| **Screenshots** | 1280×800 or 640×400 PNG — capture the panel on `x.com/following` |
| **Store icon** | 128×128 PNG — `icons/icon128.png` |
| **Privacy policy URL** | Host `PRIVACY_POLICY.md` publicly (e.g. GitHub Pages or a raw GitHub URL) and paste the URL in the "Privacy practices" tab |
| **Permissions justification** | See table below |

### Permissions justification (for CWS review form)

| Permission | Justification |
|-----------|---------------|
| `storage` | Persists user filter settings, daily unfollow counter, and global whitelist locally on the user's device |
| `tabs` | Reads the active tab URL to detect whether the user is on `x.com/following`, and navigates to that page from the popup |
| `windows` | Focuses the X browser window when the user clicks "Open Following Page" from the popup |
| `host_permissions: x.com, twitter.com` | Injects the content scripts and makes direct API calls to X's own endpoints using the user's existing authenticated session — equivalent to normal browser requests |

### Single-purpose declaration

> X-Purge has a single purpose: helping users manage their X (Twitter) following list by applying filters and performing unfollows. It does not collect data, display ads, or perform any action outside of `x.com` and `twitter.com`.

---

## License

[MIT](LICENSE)
