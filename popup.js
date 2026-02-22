// X-Purge Popup

async function init() {
  // Load daily count + limit from storage
  chrome.storage.local.get(['dailyCount', 'dailyDate', 'filters'], (data) => {
    const today = new Date().toDateString();
    const count = data.dailyDate === today ? (data.dailyCount || 0) : 0;
    const limit = data.filters?.dailyLimit ?? 50;

    document.getElementById('daily-count').textContent = count;
    document.getElementById('daily-limit').textContent = limit;

    const countEl = document.getElementById('daily-count');
    if (count >= limit) countEl.classList.add('red');
    else if (count > limit * 0.7) countEl.classList.add('red');
    else countEl.classList.add('green');
  });

  // Check if active tab is x.com/following
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isFollowing = /x\.com\/.*\/following|x\.com\/following|twitter\.com\/.*\/following/.test(url);

  const dot       = document.getElementById('status-dot');
  const statusTxt = document.getElementById('status-text');
  const btnOpen   = document.getElementById('btn-open');
  const btnToggle = document.getElementById('btn-toggle');

  if (isFollowing) {
    dot.className = 'status-dot dot-on';
    statusTxt.textContent = 'On following page';
    btnOpen.style.display = 'none';
    btnToggle.style.display = 'block';
  } else {
    dot.className = 'status-dot dot-off';
    statusTxt.textContent = 'Not on following page';
    btnOpen.style.display = 'block';
    btnToggle.style.display = 'none';
  }

  // Open x.com/following (use the logged-in profile URL if possible)
  btnOpen.addEventListener('click', async () => {
    const xTab = (await chrome.tabs.query({})).find(t => /x\.com|twitter\.com/.test(t.url || ''));
    if (xTab) {
      await chrome.tabs.update(xTab.id, { active: true, url: 'https://x.com/following' });
      await chrome.windows.update(xTab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: 'https://x.com/following' });
    }
    window.close();
  });

  // Toggle the panel on the active tab
  btnToggle.addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
    } catch {
      // Content script not ready yet — do nothing
    }
    window.close();
  });
}

init();
