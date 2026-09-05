import { normalizeId, type CurrentPage, type MentionRef } from '../../shared/notion-page'
import type { LocalAttachment } from '../../shared/attachments'
import { wrapUntrusted } from './untrusted'

export const TRUNCATION_MARKER = '\n…[truncated by Nox]'

/** Tool results are cut to a budget before they go back to the model (MVP §6.2). */
export function truncateResult(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return text.slice(0, Math.max(0, budgetChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
}

export interface PageContext extends MentionRef { markdown?: string; error?: string }

export interface ContextInput {
  currentPage?: CurrentPage
  mentions?: PageContext[]
  attachments?: LocalAttachment[]
}

/**
 * The per-turn context preamble. Only pages the user explicitly @-mentioned
 * enter context. Pure so it is trivially testable; fetching lives in the loop.
 */
export function buildContextPreamble(input: ContextInput, excerpt: (text: string, budget: number) => string = truncateResult): string {
  const blocks: string[] = []
  const { currentPage, mentions = [], attachments = [] } = input

  const content: string[] = []
  const key = (id: string) => normalizeId(id) ?? id
  const pages = new Map<string, PageContext>()
  if (currentPage) pages.set(key(currentPage.pageId), currentPage)
  for (const mention of mentions) {
    const id = key(mention.pageId)
    const previous = pages.get(id)
    pages.set(id, { ...previous, ...mention, markdown: mention.markdown ?? previous?.markdown })
  }
  let remaining = 24_000
  for (const [id, page] of pages) {
    const active = currentPage && key(currentPage.pageId) === id
    const text = page.markdown
    const budget = Math.min(8000, remaining)
    const status = page.error ? 'unavailable' : text === undefined ? 'reference-only' : text.length > budget ? 'partial' : 'fetched'
    const view = active && currentPage.viewId ? ` view_id="${escapeXml(currentPage.viewId)}"` : ''
    const tag = active ? 'page' : 'mentioned_page'
    const location = active ? '<current_notion_location>\n' : ''
    content.push(`${location}<${tag} id="${escapeXml(id)}"${view}>\n` +
      `title: ${escapeXml(page.title ?? 'Untitled')}\n` +
      `<retrieval status="${status}" total_chars="${text?.length ?? 0}" supplied_chars="${Math.min(text?.length ?? 0, budget)}"/>\n` +
      (page.error ? `Fetch unavailable: ${escapeXml(page.error)}` : text === undefined ? 'Reference only: fetch this page before making claims about its contents.' : `content:\n${excerpt(text, budget)}`) +
      `\n</${tag}>${active ? '\n</current_notion_location>' : ''}`)
    remaining -= Math.min(text?.length ?? 0, budget)
  }
  for (const attachment of attachments) {
    content.push(`<local_attachment id="${escapeXml(attachment.id)}" name="${escapeXml(attachment.name)}" mime="${escapeXml(attachment.mimeType)}" size="${attachment.size}"/>`)
  }
  if (attachments.length) content.push('Local attachments are upload inputs only. Their file contents have not been read; PDF/image analysis is unavailable.')
  blocks.push('<context>')
  if (content.length) blocks.push(wrapUntrusted(content.join('\n')))
  blocks.push('</context>')
  return blocks.join('\n')
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
