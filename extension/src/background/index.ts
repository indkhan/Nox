import { parseNotionUrl } from '../shared/notion-page'
import type { CurrentPage } from '../shared/notion-page'
import { buildOriginStripRule, originStripRuleIsActive } from './dnr'

// ── DNR Origin strip (load-bearing, RESEARCH §2.1) ──────────────────────────
async function ensureOriginStripRule(): Promise<boolean> {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules()
    if (!originStripRuleIsActive(existing)) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [buildOriginStripRule(chrome.runtime.id)],
      })
    }
    const after = await chrome.declarativeNetRequest.getDynamicRules()
    const active = originStripRuleIsActive(after)
    if (!active) console.error('[nox] DNR origin-strip rule failed to install — Notion MCP calls will 403')
    return active
  } catch (error) {
    console.error('[nox] DNR rule installation threw', error)
    return false
  }
}

const STORAGE_KEY = 'nox.currentPage'

async function setActiveTab(tabId: number | undefined): Promise<void> {
  let page: CurrentPage | null = null
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.url) page = parseNotionUrl(tab.url)
    } catch {
      page = null
    }
  }
  await chrome.storage.session.set({ [STORAGE_KEY]: page })
  void chrome.runtime.sendMessage({ type: 'nox/current-page-changed', page }).catch(() => {})
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel behavior failed', error))

chrome.tabs.onActivated.addListener(({ tabId }) => void setActiveTab(tabId))

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return
  void (async () => {
    if ((await getActiveTabId()) === tabId) await setActiveTab(tabId)
  })()
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  void (async () => setActiveTab(await getActiveTabId()))()
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'nox/get-current-page'
  ) {
    void (async () => {
      const result = await chrome.storage.session.get(STORAGE_KEY)
      const page = (result[STORAGE_KEY] as CurrentPage | null | undefined) ?? null
      sendResponse({ page } satisfies { page: CurrentPage | null })
    })()
    return true
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'nox/get-dnr-status'
  ) {
    void (async () => {
      let dnrActive = false
      try {
        dnrActive = originStripRuleIsActive(await chrome.declarativeNetRequest.getDynamicRules())
        if (!dnrActive) dnrActive = await ensureOriginStripRule()
      } catch (error) {
        console.error('[nox] dnr status check failed', error)
      }
      sendResponse({ active: dnrActive } satisfies { active: boolean })
    })()
    return true
  }
  return false
})

void (async () => {
  // The origin-strip rule must exist before the panel can talk to Notion.
  await ensureOriginStripRule()
  // Warm the session storage on startup.
  await setActiveTab(await getActiveTabId())
})()
