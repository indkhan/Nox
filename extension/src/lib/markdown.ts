import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/** Notion page links become clickable chips; everything else is plain http. */
function enhanceNotionLinks(html: string): string {
  return html.replaceAll(
    /href="(notion:\/\/page\/([0-9a-f-]{32}))"/g,
    (_m, href: string, id: string) =>
      `href="${href}" class="nox-source-chip" data-page-id="${id}"`,
  )
}

/**
 * The only path from model markdown to DOM. Sanitizes with DOMPurify after
 * rendering; script/style/handlers never survive (MVP §7).
 */
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false })
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    ADD_ATTR: ['data-page-id'],
    ALLOWED_URI_REGEXP: /^(?:https?|notion|mailto|tel):/i,
  })
  return enhanceNotionLinks(clean)
}
