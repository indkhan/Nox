import { describe, expect, it } from 'vitest'
import { parseNotionUrl } from '../src/shared/notion-page'

const dashed = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
const undashed = 'a1b2c3d4e5f64789abcdef0123456789'

describe('parseNotionUrl', () => {
  it('parses a titled page with dashed id', () => {
    const page = parseNotionUrl(`https://www.notion.so/My-Page-${dashed}`)
    expect(page?.pageId).toBe(dashed)
    expect(page?.title).toBe('My Page')
  })

  it('parses a titled page with undashed id', () => {
    const page = parseNotionUrl(`https://www.notion.so/My-Page-${undashed}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('parses a bare undashed id', () => {
    const page = parseNotionUrl(`https://www.notion.so/${undashed}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('parses a bare dashed id', () => {
    const page = parseNotionUrl(`https://www.notion.so/${dashed}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('parses a workspace-scoped page', () => {
    const page = parseNotionUrl(`https://www.notion.so/acme/Deep-Page-${undashed}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('extracts a view id from ?v=', () => {
    const view = '11112222-3333-4777-8999-aaaabbbbcccc'
    const page = parseNotionUrl(
      `https://www.notion.so/My-DB-${undashed}?v=${view}`,
    )
    expect(page?.pageId).toBe(dashed)
    expect(page?.viewId).toBe(view)
  })

  it('accepts notion.com', () => {
    const page = parseNotionUrl(`https://www.notion.com/Page-${undashed}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('accepts app.notion.com with a /p/ prefix (current logged-in URLs)', () => {
    const page = parseNotionUrl(`https://app.notion.com/p/Page-Title-${undashed}`)
    expect(page?.pageId).toBe(dashed)
    expect(page?.title).toBe('Page Title')
  })

  it('accepts workspace subdomains of notion.so and notion.site', () => {
    expect(parseNotionUrl(`https://acme.notion.so/Page-${undashed}`)?.pageId).toBe(dashed)
    expect(parseNotionUrl(`https://acme.notion.site/Page-${undashed}`)?.pageId).toBe(dashed)
  })

  it('rejects lookalike hosts', () => {
    expect(parseNotionUrl(`https://notion.so.evil.com/${undashed}`)).toBeNull()
    expect(parseNotionUrl(`https://notionsite.com/${undashed}`)).toBeNull()
  })

  it('normalizes uppercase ids', () => {
    const page = parseNotionUrl(`https://www.notion.so/${undashed.toUpperCase()}`)
    expect(page?.pageId).toBe(dashed)
  })

  it('rejects non-notion hosts', () => {
    expect(parseNotionUrl(`https://evil.example.com/${undashed}`)).toBeNull()
  })

  it('rejects http', () => {
    expect(parseNotionUrl(`http://www.notion.so/${undashed}`)).toBeNull()
  })

  it('rejects urls without an id', () => {
    expect(parseNotionUrl('https://www.notion.so/')).toBeNull()
    expect(parseNotionUrl('https://www.notion.so/some-short-word')).toBeNull()
  })

  it('rejects malformed urls', () => {
    expect(parseNotionUrl('not a url')).toBeNull()
  })
})
