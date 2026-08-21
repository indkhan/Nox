// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/lib/markdown'

describe('renderMarkdown', () => {
  it('renders headings, lists and bold', () => {
    const html = renderMarkdown('# Title\n\n- **a**\n- b')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>a</strong>')
    expect(html).toContain('<li>')
  })

  it('renders gfm line breaks', () => {
    const html = renderMarkdown('one\ntwo')
    expect(html).toMatch(/<br/)
  })

  it('strips script tags and inline handlers', () => {
    const html = renderMarkdown('hello <script>alert(1)</script><img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
  })

  it('removes style tags and iframes', () => {
    const html = renderMarkdown('<style>body{}</style><iframe src="https://x"></iframe>ok')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<iframe')
  })

  it('blocks javascript: urls but keeps https', () => {
    const evil = renderMarkdown('[x](javascript:alert(1)) [y](https://example.com)')
    expect(evil).not.toContain('javascript:')
    expect(evil).toContain('https://example.com')
  })

  it('keeps notion: page links and chips them for the UI', () => {
    const id = 'a'.repeat(32)
    const html = renderMarkdown(`[Second Brain](notion://page/${id})`)
    expect(html).toContain(`data-page-id="${id}"`)
    expect(html).toContain('nox-source-chip')
  })

  it('renders fenced code blocks escaped', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).toContain('<code')
    expect(html).not.toContain('<script>')
  })
})
