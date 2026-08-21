import { parseNotionUrl } from '../shared/notion-page'
import type { CurrentPage } from '../shared/notion-page'

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
  return false
})

void (async () => {
  // Warm the session storage on startup.
  await setActiveTab(await getActiveTabId())
})()
