import { describe, expect, it } from 'vitest'
import { classifyToolCall, detectRichPage, isSafePropertyType } from '../../src/lib/writes/classify'

describe('classifyToolCall', () => {
  it('treats the known read tools as reads', () => {
    for (const name of ['notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-get-users']) {
      expect(classifyToolCall(name)).toEqual({ mutates: false, kind: 'read' })
    }
  })

  it('marks every creation as a mutating, not-undoable class', () => {
    for (const name of ['notion-create-pages', 'notion-duplicate-page', 'notion-create-database', 'notion-create-folder', 'notion-create-comment']) {
      const c = classifyToolCall(name)
      expect(c.mutates).toBe(true)
      expect(c.kind).toMatch(/create|duplicate/)
    }
  })

  it('distinguishes update-page sub-kinds from the args shape', () => {
    expect(classifyToolCall('notion-update-page', { command: { type: 'replace_content' } }).kind).toBe('content-replace')
    expect(classifyToolCall('notion-update-page', { command: { type: 'update_content' } }).kind).toBe('content-update')
    expect(classifyToolCall('notion-update-page', { command: { type: 'update_properties' } }).kind).toBe('properties')
    // Unknown update shape → assume most destructive.
    expect(classifyToolCall('notion-update-page', {}).kind).toBe('content-replace')
  })

  it('classifies move, schema and view tools', () => {
    expect(classifyToolCall('notion-move-pages').kind).toBe('move')
    expect(classifyToolCall('notion-update-data-source').kind).toBe('schema')
    expect(classifyToolCall('notion-update-view').kind).toBe('view')
    expect(classifyToolCall('notion-create-view').kind).toBe('view')
  })

  it('fails closed for unknown tools', () => {
    expect(classifyToolCall('notion-something-new')).toEqual({ mutates: true, kind: 'unknown' })
  })
})

describe('safe property whitelist', () => {
  it.each(['text', 'number', 'select', 'date', 'checkbox'])('allows %s', (type) => {
    expect(isSafePropertyType(type)).toBe(true)
  })

  it.each(['relation', 'rollup', 'formula', 'created_time', 'people'])('rejects %s', (type) => {
    expect(isSafePropertyType(type)).toBe(false)
  })
})

describe('detectRichPage', () => {
  it.each([
    ['synced_block', true],
    ['a child database lives here', true],
    ['columns:', true],
    ['<empty-block/>', true],
    ['# Simple page\n\nJust text.', false],
    ['- [ ] todo\n- [x] done', false],
  ])('detects %j → %s', (markdown, expected) => {
    expect(detectRichPage(markdown as string)).toBe(expected)
  })
})
