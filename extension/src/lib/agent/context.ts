import type { CurrentPage, MentionRef } from '../../shared/notion-page'
import type { LocalAttachment } from '../../shared/attachments'
import { wrapUntrusted } from './untrusted'

export const TRUNCATION_MARKER = '\n…[truncated by Nox]'

/** Tool results are cut to a budget before they go back to the model (MVP §6.2). */
export function truncateResult(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return text.slice(0, Math.max(0, budgetChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
}

export interface ContextInput {
  currentPage?: CurrentPage
  mentions?: Array<MentionRef & { markdown?: string }>
  attachments?: LocalAttachment[]
  extraNotes?: string[]
}

/**
 * The per-turn context preamble. Only pages the user explicitly @-mentioned
 * enter context. Pure so it is trivially testable; fetching lives in the loop.
 */
export function buildContextPreamble(input: ContextInput): string {
  const blocks: string[] = []
  const { currentPage, mentions = [], attachments = [], extraNotes = [] } = input

  const content: string[] = []
  if (currentPage) {
    const view = currentPage.viewId ? ` view_id="${escapeXml(currentPage.viewId)}"` : ''
    content.push([
      '<current_notion_location>',
      `<page id="${escapeXml(currentPage.pageId)}"${view} url="${escapeXml(currentPage.url)}">${escapeXml(currentPage.title ?? 'Untitled')}</page>`,
      '</current_notion_location>',
    ].join('\n'))
  }
  for (const m of mentions.filter((mention) => mention.pageId !== currentPage?.pageId)) {
    content.push(
      [
        `<mentioned_page id="${m.pageId}">`,
        `title: ${m.title ?? 'Untitled'}`,
        m.markdown ? `content:\n${m.markdown}` : '(content not fetched)',
        '</mentioned_page>',
      ].join('\n'),
    )
  }
  for (const attachment of attachments) {
    content.push(`<local_attachment id="${escapeXml(attachment.id)}" name="${escapeXml(attachment.name)}" mime="${escapeXml(attachment.mimeType)}" size="${attachment.size}"/>`)
  }
  for (const note of extraNotes) content.push(`<note>${note}</note>`)
  blocks.push('<context>')
  if (content.length) blocks.push(wrapUntrusted(content.join('\n')))
  blocks.push('</context>')
  return blocks.join('\n')
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
