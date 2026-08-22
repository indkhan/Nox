// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { evaluateApproval, ApprovalEngine, BULK_CONFIRM_ROWS } from '../../src/lib/writes/approvals'

const READ_CALL = { name: 'notion-search', mutates: false, kind: 'read' as const, args: {} }
const WRITE_CALL = { name: 'notion-update-page', mutates: true, kind: 'content-replace' as const, args: { data: { page_id: 'p1' } } }
const MOVE_CALL = { name: 'notion-move-pages', mutates: true, kind: 'move' as const, args: {} }

describe('evaluateApproval', () => {
  it('allows reads in every mode', () => {
    expect(evaluateApproval(READ_CALL, { mode: 'ask', contextSet: new Set() }).action).toBe('allow')
  })

  it('ask mode gates every mutation', () => {
    const verdict = evaluateApproval(WRITE_CALL, { mode: 'ask', contextSet: new Set(['p1']) })
    expect(verdict.action).toBe('require-approval')
  })

  it('auto mode allows in-context writes without escalation', () => {
    const verdict = evaluateApproval(WRITE_CALL, { mode: 'auto', contextSet: new Set(['p1']) })
    expect(verdict.action).toBe('allow')
  })

  it('auto still escalates out-of-context targets', () => {
    const verdict = evaluateApproval(WRITE_CALL, { mode: 'auto', contextSet: new Set(['other']) })
    expect(verdict.action).toBe('require-approval')
    expect((verdict as { reasons: string[] }).reasons.join()).toMatch(/context/)
  })

  it('compares normalized page ids when checking turn context', () => {
    const undashed = 'A1B2C3D4E5F64789ABCDEF0123456789'
    const dashed = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
    const verdict = evaluateApproval(
      { ...WRITE_CALL, args: { data: { page_id: undashed } } },
      { mode: 'auto', contextSet: new Set([dashed]) },
    )
    expect(verdict.action).toBe('allow')
  })

  it('always confirms unknown tools', () => {
    const verdict = evaluateApproval(
      { name: 'notion-something-new', mutates: true, kind: 'unknown', args: {} },
      { mode: 'auto', contextSet: new Set() },
    )
    expect(verdict.action).toBe('require-approval')
  })

  it('moves always need confirmation even in auto', () => {
    expect(evaluateApproval(MOVE_CALL, { mode: 'auto', contextSet: new Set(['p1']) }).action).toBe('require-approval')
  })

  it('bulk runs over the threshold escalate', () => {
    const bulk = evaluateApproval(
      { ...WRITE_CALL },
      { mode: 'auto', contextSet: new Set(['p1']), rowCount: BULK_CONFIRM_ROWS + 1 },
    )
    expect(bulk.action).toBe('require-approval')
  })

  it('does not trust model-supplied provenance flags', () => {
    const verdict = evaluateApproval({ ...WRITE_CALL, args: { ...WRITE_CALL.args, injected_request: true } }, { mode: 'auto', contextSet: new Set(['p1']) })
    expect(verdict.action).toBe('allow')
  })

  it('escalates writes when trusted code marks untrusted turn context', () => {
    const verdict = evaluateApproval({ ...WRITE_CALL, args: { ...WRITE_CALL.args, _nox_untrusted_context: true } }, { mode: 'auto', contextSet: new Set(['p1']) })
    expect(verdict.action).toBe('require-approval')
  })

  it('schema/view changes to existing databases escalate', () => {
    const schema = { name: 'notion-update-data-source', mutates: true, kind: 'schema' as const, args: { data_source_id: 'ds_123456789012345678901234567890aa' } }
    expect(evaluateApproval(schema, { mode: 'auto', contextSet: new Set() }).action).toBe('require-approval')
  })
})

describe('ApprovalEngine cards', () => {
  it('resolves on direct approval and notifies listeners', async () => {
    let notified: unknown
    const engine = new ApprovalEngine((a) => void (notified = a))
    const p = engine.request(WRITE_CALL, { action: 'require-approval', reasons: ['ask mode'] })
    await Promise.resolve()
    const card = notified as { id: number }
    expect(card).toBeTruthy()
    engine.answer(card.id, 'approve')
    await expect(p).resolves.toBe(true)
  })

  it('reject resolves false', async () => {
    let notified: unknown
    const engine = new ApprovalEngine((a) => void (notified = a))
    const p = engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })
    await Promise.resolve()
    engine.answer((notified as { id: number }).id, 'reject')
    await expect(p).resolves.toBe(false)
  })

  it('approve-all resolves this card and future ones this turn', async () => {
    let notified: unknown
    const engine = new ApprovalEngine((a) => void (notified = a))
    engine.beginTurn()
    const p1 = engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })
    await Promise.resolve()
    engine.answer((notified as { id: number }).id, 'approve-all')
    await expect(p1).resolves.toBe(true)
    // Next request short-circuits.
    await expect(engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })).resolves.toBe(true)
  })
})
