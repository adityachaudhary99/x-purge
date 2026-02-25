// X-Purge Service Worker (MV3)
// Manages persistent state: daily counters, whitelist, settings, scan cache.

const STORAGE_KEYS = {
  DAILY_COUNT:           'dailyCount',
  DAILY_DATE:            'dailyDate',
  WHITELIST:             'whitelist',
  FILTERS:               'filters',
  SCAN_CACHE_FOLLOWING:  'scanCache_following',
  SCAN_CACHE_FOLLOWERS:  'scanCache_followers',
};

// ============================================================
// Daily counter — resets at midnight automatically
// ============================================================
async function getDailyCount() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.DAILY_COUNT, STORAGE_KEYS.DAILY_DATE]);
  const today = new Date().toDateString();
  if (data[STORAGE_KEYS.DAILY_DATE] !== today) {
    await chrome.storage.local.set({ [STORAGE_KEYS.DAILY_COUNT]: 0, [STORAGE_KEYS.DAILY_DATE]: today });
    return 0;
  }
  return data[STORAGE_KEYS.DAILY_COUNT] || 0;
}

async function incrementDailyCount() {
  const count = await getDailyCount();
  const newCount = count + 1;
  await chrome.storage.local.set({
    [STORAGE_KEYS.DAILY_COUNT]: newCount,
    [STORAGE_KEYS.DAILY_DATE]: new Date().toDateString(),
  });
  return newCount;
}

// ============================================================
// Whitelist management
// ============================================================
async function getWhitelist() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.WHITELIST);
  return data[STORAGE_KEYS.WHITELIST] || [];
}

async function addToWhitelist(username) {
  const list = await getWhitelist();
  if (!list.includes(username.toLowerCase())) {
    list.push(username.toLowerCase());
    await chrome.storage.local.set({ [STORAGE_KEYS.WHITELIST]: list });
  }
  return list;
}

async function removeFromWhitelist(username) {
  const list = await getWhitelist();
  const filtered = list.filter(u => u !== username.toLowerCase());
  await chrome.storage.local.set({ [STORAGE_KEYS.WHITELIST]: filtered });
  return filtered;
}

// ============================================================
// Scan cache — stores the full account list from last scan
// per mode (following / followers) so re-filtering doesn't
// require a new API scan.
// ============================================================
function _cacheKey(mode) {
  return mode === 'followers' ? STORAGE_KEYS.SCAN_CACHE_FOLLOWERS : STORAGE_KEYS.SCAN_CACHE_FOLLOWING;
}

async function getScanCache(mode) {
  const key = _cacheKey(mode);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function setScanCache(mode, accounts, scannedAt) {
  const key = _cacheKey(mode);
  await chrome.storage.local.set({ [key]: { accounts, scannedAt } });
}

async function clearScanCache(mode) {
  await chrome.storage.local.remove(_cacheKey(mode));
}

// ============================================================
// Message handler from content script
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_DAILY_COUNT':
      getDailyCount().then(sendResponse);
      return true;

    case 'INCREMENT_DAILY_COUNT':
      incrementDailyCount().then(sendResponse);
      return true;

    case 'GET_WHITELIST':
      getWhitelist().then(sendResponse);
      return true;

    case 'ADD_TO_WHITELIST':
      addToWhitelist(msg.username).then(sendResponse);
      return true;

    case 'REMOVE_FROM_WHITELIST':
      removeFromWhitelist(msg.username).then(sendResponse);
      return true;

    case 'GET_FILTERS':
      chrome.storage.local.get(STORAGE_KEYS.FILTERS).then(data => {
        sendResponse(data[STORAGE_KEYS.FILTERS] || null);
      });
      return true;

    case 'SAVE_FILTERS':
      chrome.storage.local.set({ [STORAGE_KEYS.FILTERS]: msg.filters }).then(() => {
        sendResponse({ ok: true });
      });
      return true;

    case 'GET_SCAN_CACHE':
      getScanCache(msg.mode).then(sendResponse);
      return true;

    case 'SET_SCAN_CACHE':
      setScanCache(msg.mode, msg.accounts, msg.scannedAt).then(() => sendResponse({ ok: true }));
      return true;

    case 'CLEAR_SCAN_CACHE':
      clearScanCache(msg.mode).then(() => sendResponse({ ok: true }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});
