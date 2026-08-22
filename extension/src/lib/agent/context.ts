import type { CurrentPage } from '../../shared/notion-page'

export const TRUNCATION_MARKER = '\n…[truncated by Nox]'

/** Tool results are cut to a budget before they go back to the model (MVP §6.2). */
export function truncateResult(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return text.slice(0, Math.max(0, budgetChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
}

export interface ContextInput {
  currentPage: (CurrentPage & { markdown?: string }) | null
  mentions?: Array<{ title?: string; pageId: string }>
  extraNotes?: string[]
}

/**
 * The per-turn context preamble. Pure so it is trivially testable; fetching
 * lives in the loop.
 */
export function buildContextPreamble(input: ContextInput): string {
  const blocks: string[] = []
  const { currentPage, mentions = [], extraNotes = [] } = input

  blocks.push('<context>')
  if (currentPage) {
    blocks.push(
      [
        `<current_page id="${currentPage.pageId}"${currentPage.viewId ? ` view="${currentPage.viewId}"` : ''}>`,
        `title: ${currentPage.title ?? 'Untitled'}`,
        currentPage.markdown ? `content:\n${currentPage.markdown}` : '(content not fetched)',
        '</current_page>',
      ].join('\n'),
    )
  }
  for (const m of mentions) {
    blocks.push(`<mentioned_page id="${m.pageId}">${m.title ?? 'Untitled'}</mentioned_page>`)
  }
  for (const note of extraNotes) blocks.push(`<note>${note}</note>`)
  blocks.push('</context>')
  return blocks.join('\n')
}
