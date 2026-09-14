import { parseNotionUrl } from '../shared/notion-page'
import type { CurrentPage } from '../shared/notion-page'
import {
  MAX_ICON_EMOJI_CHARS,
  MAX_ICON_URL_CHARS,
  MAX_TITLE_CHARS,
  isExpectedContentSender,
  isPageMetaMessage,
  isValidCurrentPage,
} from '../shared/messages'
import { ensureTrustedStorageAccess } from '../lib/chrome-storage'
import { ensureOriginStripRule, removeOriginStripRule, type OriginStripStatus } from './dnr'

// Credential-bearing storage is restricted to trusted extension contexts at
// startup, before any credential use (Epoch 13 / L3). Content scripts keep
// working because page metadata travels via runtime messages, never storage.
let storageAccessError: string | null = null

async function ensureStorageAccess(): Promise<void> {
  try {
    await ensureTrustedStorageAccess()
    storageAccessError = null
  } catch (error) {
    storageAccessError = error instanceof Error ? error.message : String(error)
    console.error('[nox] storage access restriction failed', storageAccessError)
  }
}

// ── DNR Origin strip (load-bearing, RESEARCH §2.1) ──────────────────────────
// Installs the single narrow rule (own extension initiator, exact MCP
// endpoint, xmlhttprequest) and verifies installation equality. This is
// endpoint compatibility acceptance preparation, not direct observation of a
// removed header: pre-OAuth callers see installed/unverified, and only the
// owner's later authenticated MCP initialize establishes acceptance (M13).
// Re-runs narrowly on demand via nox/get-dnr-status. Sends no tokens.
let originStripStatus: OriginStripStatus = {
  installed: false,
  verified: false,
  active: false,
}

async function ensureOriginStrip(): Promise<OriginStripStatus> {
  try {
    originStripStatus = await ensureOriginStripRule()
    if (!originStripStatus.installed) {
      console.error(
        '[nox] DNR narrow rule not installed — Notion MCP calls will 403; reload the extension and retry',
        originStripStatus.reason ?? 'not-installed',
      )
    }
  } catch (error) {
    console.error('[nox] DNR rule installation threw', error)
    originStripStatus = { installed: false, verified: false, active: false, reason: 'install-threw' }
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

/**
 * Attaches DOM-derived icon/title when the content script has seen this page
 * in this tab. Page identity comes from the tab URL (navigation state), never
 * the DOM: title/icon are untrusted display labels and never authorize writes
 * (L3). Stale metadata for another page id is ignored.
 */
async function enrich(page: CurrentPage | null, tabId: number | undefined): Promise<CurrentPage | null> {
  if (!page || tabId === undefined) return page
  const meta = (await loadTabMeta())[String(tabId)]
  if (!meta || parseNotionUrl(meta.url)?.pageId !== page.pageId) return page
  // Re-validate stored labels at the receiving boundary (bounded sizes).
  const title = typeof meta.title === 'string' && meta.title.length <= MAX_TITLE_CHARS ? meta.title : undefined
  const iconEmoji =
    typeof meta.iconEmoji === 'string' && meta.iconEmoji.length <= MAX_ICON_EMOJI_CHARS ? meta.iconEmoji : undefined
  let iconUrl: string | undefined
  if (typeof meta.iconUrl === 'string' && meta.iconUrl.length <= MAX_ICON_URL_CHARS) {
    try {
      void new URL(meta.iconUrl)
      iconUrl = meta.iconUrl
    } catch {
      iconUrl = undefined
    }
  }
  const validated: CurrentPage = { pageId: page.pageId, url: page.url }
  if (page.viewId) validated.viewId = page.viewId
  if (page.title ?? title) validated.title = (title ?? page.title) as string
  if (iconEmoji) validated.iconEmoji = iconEmoji
  if (iconUrl) validated.iconUrl = iconUrl
  if (!isValidCurrentPage(validated)) return page
  return validated
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
    (message as { type?: string }).type === 'nox/page-meta'
  ) {
    // Sender-gated, payload-validated, stale-checked (L3): only the owning
    // extension's tab context, exact discriminant, bounded fields, and a
    // message URL whose page matches the sender tab's current navigation.
    // Unknown message types are rejected; title/icon stay untrusted labels.
    const extensionId = chrome.runtime.id
    if (!isExpectedContentSender(sender, extensionId)) return false
    if (!isPageMetaMessage(message)) return false
    const tabId = sender.tab!.id!
    const senderUrl = sender.tab!.url
    const raw = message as { url: string; title?: string; iconEmoji?: string; iconUrl?: string }
    // Stale navigation check: the reported URL must resolve to the same page
    // the tab currently shows; a mismatch means a stale report from a
    // previous navigation and is dropped.
    if (typeof senderUrl === 'string') {
      const reported = parseNotionUrl(raw.url)?.pageId
      const current = parseNotionUrl(senderUrl)?.pageId
      if (reported && current && reported !== current) return false
    }
    void (async () => {
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
      // Always re-verify installation: cheap when healthy, self-healing when
      // not. Reports installed/unverified pre-OAuth; carries no tokens.
      // Storage restriction failures surface here as a compatibility error
      // instead of silently relaxing (L3).
      const status = await ensureOriginStrip()
      sendResponse(storageAccessError ? { ...status, storageError: storageAccessError } : status)
    })()
    return true
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'nox/clear-dnr'
  ) {
    // Authenticated acceptance failed (401/403/429/5xx/redirect/malformed/
    // missing/lookup): remove the rule so the next attempt reinstalls
    // narrowly instead of reusing a suspect installation. No tokens carried.
    void (async () => {
      try {
        await removeOriginStripRule()
      } catch (error) {
        console.error('[nox] DNR rule removal failed', error)
      }
      originStripStatus = { installed: false, verified: false, active: false, reason: 'acceptance-failed' }
      sendResponse({ cleared: true })
    })()
    return true
  }
  return false
})

void (async () => {
  // Restrict credential-bearing storage before any credential use (L3),
  // then ensure the narrow origin-strip rule exists before Notion traffic.
  await ensureStorageAccess()
  await ensureOriginStrip()
  // Warm the session storage on startup.
  await setActiveTab(await getActiveTabId())
})()
