// Thin router. No agent logic — MV3 service workers die at 30s idle and 5min hard,
// so anything long-running lives in the side panel document (RESEARCH §4).

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

// mcp.notion.com rejects authenticated requests carrying a chrome-extension:// Origin
// with `403 Invalid Origin`. Origin is a forbidden header, so fetch() can't drop it —
// declarativeNetRequest is the only way. Keyed on our own id as the initiator.
const ORIGIN_RULE = {
  id: 1,
  priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
  condition: {
    initiatorDomains: [chrome.runtime.id],
    requestDomains: ['mcp.notion.com'],
    resourceTypes: ['xmlhttprequest'],
  },
};

async function installOriginRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ORIGIN_RULE.id],
      addRules: [ORIGIN_RULE],
    });
  } catch (e) {
    console.error('[nox] failed to install origin rule:', e);
  }
}

chrome.runtime.onInstalled.addListener(installOriginRule);
chrome.runtime.onStartup.addListener(installOriginRule);
installOriginRule();

// The panel stays enabled globally rather than per-tab. Per-tab enabling risks unloading the
// document on tab switch, which would kill in-flight turns. Spike 0.4 tests whether that holds.

// ── Which Notion page is open ──────────────────────────────────────────────
// Read from the tab URL, not a content script. A content script only exists in tabs that
// were loaded after the extension was, so already-open Notion tabs report nothing until
// they're refreshed — which is exactly the bug this replaces. chrome.tabs gives us url and
// title directly, with no injection and no refresh.

const NOTION_HOST = /(^|\.)notion\.(so|com)$/i;

export function pageIdFromUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!NOTION_HOST.test(u.hostname)) return null;
  const dashed = u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (dashed) return dashed[0].replace(/-/g, '').toLowerCase();
  const flat = [...u.pathname.matchAll(/[0-9a-f]{32}/gi)];
  return flat.length ? flat[flat.length - 1][0].toLowerCase() : null;
}

async function refreshCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const pageId = tab?.url ? pageIdFromUrl(tab.url) : null;
    await chrome.storage.session.set({
      currentPage: pageId
        ? { pageId, url: tab.url, title: (tab.title ?? '').replace(/\s*\|\s*Notion\s*$/, ''), tabId: tab.id, at: Date.now() }
        : null,
    });
  } catch (e) {
    console.warn('[nox] refreshCurrentPage:', e);
  }
}

chrome.tabs.onActivated.addListener(refreshCurrentPage);
chrome.tabs.onUpdated.addListener((_id, info) => {
  // Notion is a SPA: url changes without a full load.
  if (info.url || info.status === 'complete' || info.title) refreshCurrentPage();
});
chrome.windows.onFocusChanged.addListener(refreshCurrentPage);
refreshCurrentPage();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'nox:getPage') {
    refreshCurrentPage()
      .then(() => chrome.storage.session.get('currentPage'))
      .then(({ currentPage }) => sendResponse(currentPage ?? null));
    return true; // async
  }
  return false;
});
