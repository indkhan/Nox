export interface CurrentPage {
  pageId: string
  viewId?: string
  url: string
  title?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function normalizeId(raw: string): string | null {
  const id = raw.toLowerCase()
  if (UUID_RE.test(id)) return id
  if (/^[0-9a-f]{32}$/.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(
      16,
      20,
    )}-${id.slice(20)}`.toLowerCase()
  }
  return null
}

export function parseNotionUrl(rawUrl: string): CurrentPage | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const host = url.hostname
  const isNotion =
    host === 'www.notion.so' ||
    host === 'notion.so' ||
    host === 'www.notion.com' ||
    host === 'notion.com'
  if (!isNotion || url.protocol !== 'https:') return null

  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments.at(-1)
  if (!last) return null

  const viewId = normalizeId(url.searchParams.get('v') ?? '')

  const dashedMatch = /-?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    last,
  )
  const undashedMatch = /-?([0-9a-f]{32})$/i.exec(last)
  const match = dashedMatch ?? undashedMatch
  if (!match) return null

  const pageId = normalizeId(match[1])
  if (!pageId) return null

  const title = last.slice(0, last.length - match[0].length).replaceAll('-', ' ') || undefined

  return { pageId, ...(viewId ? { viewId } : {}), url: rawUrl, title }
}
