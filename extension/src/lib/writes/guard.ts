import { normalizePageText, type NormalizedPageFetch } from '../notion/page-content'

export interface PageSnapshot {
  pageId: string
  hash: string
  markdown: string
  capturedAt: number
  /** Normalized fetch record behind this snapshot (completeness metadata). */
  record: NormalizedPageFetch
}

/**
 * The overwrite race (RESEARCH §2.7): Notion MCP has no conditional writes, so
 * the only defence against clobbering concurrent edits is re-fetch + compare
 * immediately before writing. Snapshots are normalized provider content, never
 * raw concatenated envelopes: partial, unavailable, and unrecognized payloads
 * throw instead of becoming a baseline.
 *
 * Residual race: an external edit landing between the final read and the
 * provider write cannot be atomically excluded without provider
 * conditional-write support.
 */
export async function capturePageSnapshot(
  fetchPageMarkdown: (pageId: string) => Promise<string>,
  pageId: string,
): Promise<PageSnapshot> {
  const raw = await fetchPageMarkdown(pageId)
  const record = normalizePageText(pageId, raw)
  return { pageId: record.pageId, hash: await hashMarkdown(record.markdown), markdown: record.markdown, capturedAt: Date.now(), record }
}

export class GuardViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardViolation'
  }
}

/** Throws GuardViolation when the live content no longer matches the snapshot. */
export async function assertUnchanged(
  fetchPageMarkdown: (pageId: string) => Promise<string>,
  snapshot: PageSnapshot,
): Promise<void> {
  const fresh = await capturePageSnapshot(fetchPageMarkdown, snapshot.pageId)
  if (fresh.hash !== snapshot.hash) {
    throw new GuardViolation(
      'PAGE_CHANGED_SINCE_READ: this page was edited in Notion after Nox read it. ' +
        'Re-read the page and try again — refusing to overwrite the newer edits.',
    )
  }
}

export async function hashMarkdown(markdown: string): Promise<string> {
  // Normalize line endings so CRLF/LTF differences don't false-positive.
  return createHash(markdown.replace(/\r\n/g, '\n'))
}

/** WebCrypto-backed hex digest; works in extension pages and tests. */
export async function createHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
