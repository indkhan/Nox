import { parseNotionUrl } from '../shared/notion-page'

/**
 * Content script on notion.so/notion.com tabs. Reads the open page's icon and
 * title from the DOM and reports it to the background worker so the panel can
 * show the real page chip. Best-effort: Notion's DOM is private, so every
 * lookup degrades silently to "no meta".
 */

interface PageMeta {
  url: string
  title?: string
  iconEmoji?: string
  iconUrl?: string
}

const ICON_EMOJI_SELECTORS = [
  '.notion-page-icon-emoji',
  '.notion-topbar span[aria-label*="icon" i]',
  '[data-testid="page-icon"]',
]

const ICON_IMAGE_SELECTORS = [
  '.notion-topbar .notion-page-icon-image img',
  '.notion-page-icon-image img',
  '.notion-record-icon img',
]

function text(el: Element | null): string | undefined {
  const value = el?.textContent?.trim()
  return value ? value : undefined
}

function readIcon(): Pick<PageMeta, 'iconEmoji' | 'iconUrl'> {
  for (const selector of ICON_EMOJI_SELECTORS) {
    const emoji = text(document.querySelector(selector))
    if (emoji) return { iconEmoji: emoji }
  }
  for (const selector of ICON_IMAGE_SELECTORS) {
    const img = document.querySelector<HTMLImageElement>(selector)
    if (img?.src) return { iconUrl: img.src }
  }
  return {}
}

function readTitle(): string | undefined {
  // document.title looks like "<Page> - <Workspace>" or just "<Page>".
  const raw = document.title.trim()
  if (!raw || raw === 'Notion') return undefined
  return raw.replace(/\s+[-–|]\s+Notion\s*$/i, '').trim() || undefined
}

function readMeta(): PageMeta {
  return { url: location.href.split('?')[0], ...readIcon(), title: readTitle() }
}

function report(): void {
  if (!parseNotionUrl(location.href)) return
  void chrome.runtime.sendMessage({ type: 'nox/page-meta', ...readMeta() }).catch(() => {})
}

// SPA navigation: Notion never reloads the document on internal navigation.
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method].bind(history)
  Object.defineProperty(history, method, {
    writable: false,
    configurable: true,
    value: (...args: Parameters<History['pushState']>) => {
      const result = original(...args)
      scheduleReport()
      return result
    },
  })
}
window.addEventListener('popstate', () => scheduleReport())

let timer: ReturnType<typeof setTimeout> | undefined
function scheduleReport(): void {
  clearTimeout(timer)
  // The new page shell renders async — retry until an icon shows up or we give up.
  const iconFound = (): boolean =>
    [...ICON_EMOJI_SELECTORS, ...ICON_IMAGE_SELECTORS].some((s) => document.querySelector(s) !== null)
  let attempts = 0
  const tick = (): void => {
    attempts += 1
    report()
    if (attempts < 20 && !iconFound()) timer = setTimeout(tick, 300)
  }
  timer = setTimeout(tick, 200)
}

report()
scheduleReport()
