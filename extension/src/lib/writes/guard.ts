export interface PageSnapshot {
  pageId: string
  hash: string
  markdown: string
  capturedAt: number
}

/**
 * The overwrite race (RESEARCH §2.7): Notion MCP has no conditional writes, so
 * the only defence against clobbering concurrent edits is re-fetch + compare
 * immediately before writing.
 */
export async function capturePageSnapshot(
  fetchPageMarkdown: (pageId: string) => Promise<string>,
  pageId: string,
): Promise<PageSnapshot> {
  const markdown = await fetchPageMarkdown(pageId)
  return { pageId, hash: await hashMarkdown(markdown), markdown, capturedAt: Date.now() }
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
  const fresh = await fetchPageMarkdown(snapshot.pageId)
  const freshHash = await hashMarkdown(fresh)
  if (freshHash !== snapshot.hash) {
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
