import { parseNotionUrl } from '../shared/notion-page'
import type { CurrentPage } from '../shared/notion-page'
import { ensureOriginStripRule } from './dnr'

// ── DNR Origin strip (load-bearing, RESEARCH §2.1) ──────────────────────────
// Installs the first rule variant that verifiably strips our own Origin
// (self-probing canary — see dnr.ts). Re-runs on demand via nox/get-dnr-status.
let originStripStatus: { active: boolean; variant?: string; probe?: string } = {
  active: false,
}

async function ensureOriginStrip(): Promise<typeof originStripStatus> {
  try {
    originStripStatus = await ensureOriginStripRule()
    if (!originStripStatus.active) {
      console.error('[nox] DNR origin-strip could not be verified — Notion MCP calls will 403', originStripStatus)
    }
  } catch (error) {
    console.error('[nox] DNR rule installation threw', error)
    originStripStatus = { active: false }
  }
  return originStripStatus
}

const STORAGE_KEY = 'nox.currentPage'
const META_KEY = 'nox.pageMeta'

/** Per-tab page metadata reported by the Notion content script. */
interface TabPageMeta {
  url: string
  title?: string
  iconEmoji?: string
  iconUrl?: string
  ts?: number
}

async function loadTabMeta(): Promise<Record<string, TabPageMeta>> {
  const result = await chrome.storage.session.get(META_KEY)
  return (result[META_KEY] as Record<string, TabPageMeta> | undefined) ?? {}
}

/** Attaches DOM-derived icon/title when the content script has seen this page in this tab. */
async function enrich(page: CurrentPage | null, tabId: number | undefined): Promise<CurrentPage | null> {
  if (!page || tabId === undefined) return page
  const meta = (await loadTabMeta())[String(tabId)]
  if (!meta || parseNotionUrl(meta.url)?.pageId !== page.pageId) return page
  return {
    ...page,
    ...(meta.iconEmoji ? { iconEmoji: meta.iconEmoji } : {}),
    ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
    ...(meta.title ? { title: meta.title } : {}),
  }
}

async function setActiveTab(tabId: number | undefined): Promise<void> {
  if (tabId !== undefined) {
    // Touch the tab's recency stamp so the @ picker can rank by last visit.
    const meta = await loadTabMeta()
    if (meta[String(tabId)]) {
      meta[String(tabId)].ts = Date.now()
      await chrome.storage.session.set({ [META_KEY]: meta })
    }
  }
  let page: CurrentPage | null = null
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.url) page = await enrich(parseNotionUrl(tab.url), tabId)
    } catch {
      page = null
    }
  }
  await chrome.storage.session.set({ [STORAGE_KEY]: page })
  void chrome.runtime.sendMessage({ type: 'nox/current-page-changed', page }).catch(() => {})
}

/** Recently seen Notion pages across tabs — the @ picker's no-query list. */
async function getRecentPages(): Promise<CurrentPage[]> {
  const [meta, tabs] = await Promise.all([
    loadTabMeta(),
    chrome.tabs.query({ url: ['https://*.notion.so/*', 'https://*.notion.com/*', 'https://*.notion.site/*'] }).catch(() => []),
  ])
  const byPageId = new Map<string, CurrentPage & { ts: number }>()
  const add = (page: CurrentPage | null, ts: number): void => {
    if (!page) return
    const existing = byPageId.get(page.pageId)
    if (!existing || existing.ts < ts) byPageId.set(page.pageId, { ...page, ts })
  }
  // Open Notion tabs first (title from the URL slug), then richer DOM metadata.
  for (const tab of tabs) {
    if (!tab.url || tab.id === undefined) continue
    add(parseNotionUrl(tab.url), 0)
  }
  for (const m of Object.values(meta)) {
    const page = parseNotionUrl(m.url)
    if (page) add({ ...page, title: m.title ?? page.title, iconEmoji: m.iconEmoji, iconUrl: m.iconUrl }, m.ts ?? 0)
  }
  return [...byPageId.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8)
    .map(({ ts: _ts, ...page }) => page)
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

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const meta = await loadTabMeta()
    if (String(tabId) in meta) {
      delete meta[String(tabId)]
      await chrome.storage.session.set({ [META_KEY]: meta })
    }
  })()
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'nox/page-meta' &&
    sender.tab?.id !== undefined
  ) {
    const tabId = sender.tab.id
    void (async () => {
      const raw = message as { url?: string; title?: string; iconEmoji?: string; iconUrl?: string }
      if (typeof raw.url !== 'string') return
      const meta: TabPageMeta = { url: raw.url }
      if (raw.title) meta.title = raw.title
      if (raw.iconEmoji) meta.iconEmoji = raw.iconEmoji
      if (raw.iconUrl) meta.iconUrl = raw.iconUrl
      const all = await loadTabMeta()
      all[String(tabId)] = meta
      await chrome.storage.session.set({ [META_KEY]: all })
      // The page may already be stored without meta — refresh the active page.
      await setActiveTab(await getActiveTabId())
    })()
    return false
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'nox/get-recent-pages'
  ) {
    void (async () => {
      sendResponse({ pages: await getRecentPages() } satisfies { pages: CurrentPage[] })
    })()
    return true
  }
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
      // Always re-verify live: cheap when healthy, self-healing when not.
      const status = await ensureOriginStrip()
      sendResponse(status)
    })()
    return true
  }
  return false
})

void (async () => {
  // The origin-strip rule must exist before the panel can talk to Notion.
  await ensureOriginStrip()
  // Warm the session storage on startup.
  await setActiveTab(await getActiveTabId())
})()
