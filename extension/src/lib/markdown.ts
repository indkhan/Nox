import { normalizeId } from '../shared/notion-page'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/**
 * Model-supplied images must never auto-load. Render Markdown image tokens as
 * ordinary clickable links so the source stays readable without issuing a
 * passive resource request. Code blocks never reach this renderer.
 */
marked.use({
  renderer: {
    image({ href, text }: { href: string; title?: string | null; text: string }) {
      const label = (text || '').trim() || href || 'Image'
      const safeLabel = label.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      if (!href) return safeLabel
      let encoded: string | null = null
      try {
        encoded = encodeURI(href)
      } catch {
        return safeLabel
      }
      const safeHref = encoded.replaceAll('"', '%22')
      return `<a href="${safeHref}">${safeLabel}</a>`
    },
  },
})

/** Notion page links become clickable chips; everything else is plain http. */
function enhanceNotionLinks(html: string): string {
  return html.replaceAll(/href="notion:\/\/page\/([^"<>]*)"/gi, (_match, rawId: string) => {
    const id = normalizeId(rawId)
    return id ? `href="https://www.notion.so/${id.replaceAll('-', '')}" class="nox-source-chip" data-page-id="${id}"` : ''
  })
}

/**
 * The only path from model markdown to DOM. Markdown image tokens become
 * clickable links above; raw HTML resource tags are removed by the sanitizer
 * (never transformed with a regex). Script/style/handlers never survive.
 */
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false })
  const clean = DOMPurify.sanitize(enhanceNotionLinks(raw), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'img', 'picture', 'source', 'audio', 'video', 'track', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'image', 'use', 'foreignObject', 'animate', 'animateTransform', 'animateMotion', 'set', 'feImage'],
    FORBID_ATTR: ['src', 'srcset', 'poster', 'ping', 'background', 'style', 'xlink:href', 'lowsrc', 'dynsrc', 'action', 'formaction'],
    ADD_ATTR: ['data-page-id'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
  })
  return clean.replaceAll(/<a\b([^>]*)>/g, '<a$1 target="_blank" rel="noopener noreferrer">')
}
