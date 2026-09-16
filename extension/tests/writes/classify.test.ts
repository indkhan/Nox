import { describe, expect, it } from 'vitest'
import { classifyToolCall, detectRichPage, isSafePropertyType, requiresWorkspacePlan } from '../../src/lib/writes/classify'
import { canonicalizeArgs, EffectValidationError, validateEffect } from '../../src/lib/writes/effects'

describe('classifyToolCall', () => {
  it('treats the known read tools as reads', () => {
    for (const name of ['notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-get-users', 'notion-check-mcp-next-steps']) {
      expect(classifyToolCall(name)).toMatchObject({ mutates: false, kind: 'read', impact: 'low', requiresWorkspacePlan: false })
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
    expect(classifyToolCall('notion-something-new')).toMatchObject({ mutates: true, kind: 'unknown', impact: 'structural', requiresWorkspacePlan: true })
  })

  it('requires plans only for structural workspace changes', () => {
    expect(classifyToolCall('notion-create-database')).toMatchObject({ impact: 'structural', requiresWorkspacePlan: true })
    expect(classifyToolCall('notion-update-data-source')).toMatchObject({ impact: 'structural', requiresWorkspacePlan: true })
    expect(classifyToolCall('notion-create-view')).toMatchObject({ impact: 'structural', requiresWorkspacePlan: true })
    expect(classifyToolCall('notion-move-pages')).toMatchObject({ impact: 'structural', requiresWorkspacePlan: true })
    expect(classifyToolCall('notion-update-page', { command: { type: 'update_properties' } })).toMatchObject({ impact: 'low', requiresWorkspacePlan: false })
  })

  it('escalates bulk page creation without penalizing a small explicit create', () => {
    expect(requiresWorkspacePlan(classifyToolCall('notion-create-pages'), 'notion-create-pages', { pages: [{}, {}] })).toBe(false)
    expect(requiresWorkspacePlan(classifyToolCall('notion-create-pages'), 'notion-create-pages', { pages: Array.from({ length: 6 }, () => ({})) })).toBe(true)
  })

  it('lets a single cosmetic view rename use ordinary action approval', () => {
    const rename = { view_id: 'view-1', name: 'History' }
    expect(requiresWorkspacePlan(classifyToolCall('notion-update-view', rename), 'notion-update-view', rename)).toBe(false)
    const reshaped = { view_id: 'view-1', name: 'History', sorts: [{ property: 'Name' }] }
    expect(requiresWorkspacePlan(classifyToolCall('notion-update-view', reshaped), 'notion-update-view', reshaped)).toBe(true)
    expect(requiresWorkspacePlan(classifyToolCall('notion-create-view'), 'notion-create-view', { database_id: 'db-1', name: 'New' })).toBe(true)
    expect(requiresWorkspacePlan(classifyToolCall('notion-update-data-source'), 'notion-update-data-source', {})).toBe(true)
  })

  it('keeps unverified meeting-note queries out of the read surface', () => {
    expect(classifyToolCall('notion-query-meeting-notes')).toMatchObject({ mutates: true, kind: 'unknown' })
  })
})

describe('validateEffect', () => {
  const PAGE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('parses update-page targets once with a canonical frozen copy', () => {
    const args = { data: { page_id: PAGE }, command: { type: 'update_properties', properties: { a: 1 } } }
    const effect = validateEffect('notion-update-page', args)
    expect(effect.targets).toEqual([PAGE])
    expect(effect.count).toBe(1)
    expect(effect.kind).toBe('properties')
    expect(effect.args).toEqual(args)
    expect(effect.args).not.toBe(args)
  })

  it('collects move targets and destinations without scanning every id-like string', () => {
    const effect = validateEffect('notion-move-pages', {
      page_ids: [PAGE, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'],
      destination: { page_id: 'cccccccc-dddd-eeee-ffff-000000000000' },
      note: 'not-an-id-field',
    })
    expect(effect.targets).toHaveLength(2)
    expect(effect.parents).toEqual(['cccccccc-dddd-eeee-ffff-000000000000'])
    expect(effect.count).toBe(2)
    expect(effect.args.note).toBe('not-an-id-field')
  })

  it('rejects targetless moves as invalid arguments', () => {
    expect(() => validateEffect('notion-move-pages', {})).toThrowError(EffectValidationError)
    try {
      validateEffect('notion-move-pages', {})
      expect.unreachable()
    } catch (e) {
      expect((e as EffectValidationError).code).toBe('INVALID_ARGUMENTS')
    }
  })

  it('rejects unknown tools as unsupported effects', () => {
    try {
      validateEffect('notion-frobnicate', { id: PAGE })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EffectValidationError)
      expect((e as EffectValidationError).code).toBe('UNSUPPORTED_EFFECT')
      expect((e as Error).message).toMatch(/UNSUPPORTED_EFFECT/)
    }
  })

  it('rejects model-supplied internal fields', () => {
    try {
      validateEffect('notion-update-page', { data: { page_id: PAGE }, __nox_expected_hash: 'abc' })
      expect.unreachable()
    } catch (e) {
      expect((e as EffectValidationError).code).toBe('INVALID_ARGUMENTS')
      expect((e as Error).message).toMatch(/__nox_expected_hash/)
    }
  })

  it('requires schema and view target identity', () => {
    expect(validateEffect('notion-update-data-source', { data_source_id: 'ds-1' }).targets).toEqual(['ds-1'])
    expect(() => validateEffect('notion-update-data-source', {})).toThrowError(EffectValidationError)
    expect(validateEffect('notion-update-view', { view_id: 'view-1' }).targets).toEqual(['view-1'])
    expect(() => validateEffect('notion-create-view', {})).toThrowError(EffectValidationError)
  })

  it('counts created objects without inventing affected targets', () => {
    const effect = validateEffect('notion-create-pages', {
      pages: [{ parent: { page_id: PAGE } }, { parent: { page_id: PAGE } }],
    })
    expect(effect.targets).toEqual([])
    expect(effect.parents).toEqual([PAGE, PAGE])
    expect(effect.count).toBe(2)
  })
})

describe('canonicalizeArgs', () => {
  it('sorts keys deterministically and copies instead of aliasing', () => {
    const args = { z: 1, a: { y: [3, 2], x: 's' } }
    const canonical = canonicalizeArgs(args)
    expect(Object.keys(canonical)).toEqual(['a', 'z'])
    expect(canonical).toEqual(args)
    expect(canonical).not.toBe(args)
    expect(canonical.a).not.toBe(args.a)
  })

  it('rejects cycles and non-JSON values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalizeArgs(cyclic)).toThrowError(EffectValidationError)
    expect(() => canonicalizeArgs({ fn: () => undefined })).toThrowError(EffectValidationError)
  })

  it('rejects excessive nesting and oversize lists', () => {
    let deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 25; i++) {
      const next: Record<string, unknown> = {}
      cursor.nested = next
      cursor = next
    }
    expect(() => canonicalizeArgs(deep)).toThrowError(EffectValidationError)
    expect(() => canonicalizeArgs({ pages: Array.from({ length: 101 }, (_, i) => i) })).toThrowError(EffectValidationError)
  })

  it('rejects payloads over the per-operation byte budget', () => {
    expect(() => canonicalizeArgs({ content: 'x'.repeat(600 * 1024) })).toThrowError(EffectValidationError)
    try {
      canonicalizeArgs({ content: 'x'.repeat(600 * 1024) })
      expect.unreachable()
    } catch (e) {
      expect((e as EffectValidationError).code).toBe('PAYLOAD_TOO_LARGE')
    }
  })

  it('accepts ordinary operations comfortably inside the budget', () => {
    const canonical = canonicalizeArgs({ data: { page_id: 'p1' }, command: { type: 'replace_content', content: '# Hello\n\nBody text.' } })
    expect(canonical).toMatchObject({ data: { page_id: 'p1' } })
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
