This Product Requirements Document (PRD) is designed to guide **Claude** (or any LLM/developer) in building a high-performance, safety-first browser extension for X (formerly Twitter).

---

# PRD: "X-Purge" – Smart X Unfollowing Extension

## 1. Product Overview
**X-Purge** is a browser extension that allows users to clean their "Following" list using advanced filters. Unlike basic scripts, it prioritizes **account safety** by mimicking human behavior and provides granular filtering to ensure users only remove the "noise" while keeping valuable connections.

## 2. Target Audience
*   **Creators/Founders:** Who need to fix their Follower-to-Following ratio for better "authority" signals.
*   **Niche Switchers:** Users who have changed interests and want to unfollow old, irrelevant accounts.
*   **Power Users:** Who want to remove bots, inactive accounts, and "egg" profiles without paying $200+/month for API tools.

---

## 3. Filtering Inputs (The Core Engine)
To build a "Smart" tool, the extension must ingest and process these specific inputs:

### A. Relationship Filters
*   **Not Following Back:** The primary filter; targets users who don't reciprocate the follow.
*   **Mutual Protection:** A toggle to "Never unfollow mutuals," even if they meet other purge criteria.
*   **Follow Date:** Unfollow based on how long you’ve followed them (e.g., "Followed more than 6 months ago").

### B. Activity Filters
*   **Inactivity Threshold:** Last post date (e.g., "Hasn't posted in >30, >90, or >180 days").
*   **Tweet Frequency:** Average tweets per month (removes "silent" accounts or "hyper-active" spammers).

### C. Profile Quality Filters (Bot/Spam Detection)
*   **Default Avatar ("Egg"):** Accounts with no custom profile picture.
*   **Verified Status:** Option to exclude Blue/Gold/Grey checkmark accounts.
*   **Follower/Following Ratio:** Unfollow accounts with a ratio below `X` (identifies low-quality/follow-for-follow accounts).
*   **Minimum Follower Count:** Protect "Big" accounts even if they don't follow back.
*   **Account Age:** Unfollow accounts created less than `X` months ago (often bot-heavy).

### D. Content & Keyword Filters
*   **Bio Keywords (Blacklist):** Unfollow if bio contains: "crypto", "dm for collab", "bot", "automated".
*   **Bio Keywords (Whitelist):** NEVER unfollow if bio contains: "Founder", "VC", "Engineer".
*   **Language Filter:** Unfollow accounts not posting in the user's primary language.

---

## 4. Safety & Anti-Detection (Critical)
X’s anti-spam algorithms are hyper-sensitive to "Follow Churn." The extension **must** include:

*   **Human-Mimicry Delay:** Randomized delays between unfollow actions (e.g., 5.4s, 12.1s, 7.8s) rather than a fixed interval.
*   **Daily Hard Caps:** Default limit of **50–100 unfollows per day** (user-adjustable, but with "High Risk" warnings for >150).
*   **Batching & Breaks:** Perform 10 unfollows, then pause for 15 minutes.
*   **DOM Manipulation vs. API:** Since the official API is expensive ($200/mo), the extension should work by simulating clicks on the `/following` page but at a "glacial" pace to avoid triggering "Automated Behavior" flags.

---

## 5. Technical Requirements for Claude
*   **Tech Stack:** JavaScript (ES6+), Chrome Extension Manifest V3.
*   **Data Persistence:** Use `chrome.storage.local` to maintain a **Whitelist** (Global "Never Unfollow" list).
*   **Page Interaction:** Use `IntersectionObserver` to auto-scroll the following list to "load" more users without refreshing the page.
*   **Headless Check:** Ensure the extension doesn't trigger `navigator.webdriver` flags.

---

## 6. User Interface (UI) Requirements
*   **Dashboard Overlay:** A clean side-panel that appears only on `x.com/following`.
*   **The "Dry Run" Mode:** A "Scan Only" button that shows a list of accounts that *would* be unfollowed based on filters, without actually performing the action.
*   **Progress Widget:** A floating status bar showing: `[Unfollowed: 12/100] | [Current Action: Waiting 8s...] | [Next Target: @username]`.
*   **Safety "Heat" Meter:** A visual indicator (Green to Red) showing how "aggressive" the current filter/speed settings are.

---

## 7. Success Metrics
1.  **Zero Bans:** 100% of beta users maintain account standing.
2.  **Accuracy:** <1% accidental unfollows of "Whitelisted" or "High-Value" accounts.
3.  **Speed:** Ability to process a 5,000-person following list (scanning) in under 10 minutes.

---

### Prompt for Claude to start coding:
> "Claude, I want you to architect a Chrome Extension (Manifest V3) called 'X-Purge'. Focus on the logic for the **Inactivity Filter** and the **Human-Mimicry Delay**. How would you structure the `content_script` to scan the `/following` page DOM, extract 'Last Post Date' (which requires a hover or a background fetch), and execute a click with a randomized delay?"