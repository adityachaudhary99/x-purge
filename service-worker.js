// X-Purge Service Worker (MV3)
// Manages persistent state: daily counters, whitelist, settings.

const STORAGE_KEYS = {
  DAILY_COUNT: 'dailyCount',
  DAILY_DATE: 'dailyDate',
  WHITELIST: 'whitelist',
  FILTERS: 'filters',
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

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});
