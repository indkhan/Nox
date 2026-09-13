// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { evaluateApproval, ApprovalEngine, BULK_CONFIRM_ROWS } from '../../src/lib/writes/approvals'

const READ_CALL = { name: 'notion-search', mutates: false, kind: 'read' as const, args: {}, targets: [] as string[], parents: [] as string[], affectedCount: 0 }
const WRITE_CALL = { name: 'notion-update-page', mutates: true, kind: 'content-replace' as const, args: { data: { page_id: 'p1' } }, targets: ['p1'], parents: [] as string[], affectedCount: 1 }
const MOVE_CALL = { name: 'notion-move-pages', mutates: true, kind: 'move' as const, args: {}, targets: ['p1'], parents: [] as string[], affectedCount: 1 }

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
      { ...WRITE_CALL, args: { data: { page_id: undashed } }, targets: [undashed] },
      { mode: 'auto', contextSet: new Set([dashed]) },
    )
    expect(verdict.action).toBe('allow')
  })

  it('always confirms unknown tools', () => {
    const verdict = evaluateApproval(
      { name: 'notion-something-new', mutates: true, kind: 'unknown', args: {}, targets: [], parents: [] as string[], affectedCount: 0 },
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
    const verdict = evaluateApproval({ ...WRITE_CALL, provenance: 'untrusted-context' }, { mode: 'auto', contextSet: new Set(['p1']) })
    expect(verdict.action).toBe('require-approval')
  })

  it('schema/view changes to existing databases escalate', () => {
    const schema = { name: 'notion-update-data-source', mutates: true, kind: 'schema' as const, args: { data_source_id: 'ds_123456789012345678901234567890aa' }, targets: ['ds_123456789012345678901234567890aa'], parents: [] as string[], affectedCount: 1 }
    expect(evaluateApproval(schema, { mode: 'auto', contextSet: new Set() }).action).toBe('require-approval')
  })
})

describe('ApprovalEngine cards', () => {
  it('resolves approval with the frozen args and notifies listeners', async () => {
    let notified: unknown
    const engine = new ApprovalEngine((a) => void (notified = a))
    const frozen = { data: { page_id: 'p1' } }
    const p = engine.request({ ...WRITE_CALL, args: frozen }, { action: 'require-approval', reasons: ['ask mode'] })
    await Promise.resolve()
    const card = notified as { id: number }
    expect(card).toBeTruthy()
    expect(engine.answer(card.id, 'approve')).toBe(true)
    await expect(p).resolves.toMatchObject({ approved: true, frozenArgs: frozen })
  })

  it('reject resolves unapproved without frozen authority', async () => {
    let notified: unknown
    const engine = new ApprovalEngine((a) => void (notified = a))
    const p = engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })
    await Promise.resolve()
    expect(engine.answer((notified as { id: number }).id, 'reject')).toBe(true)
    await expect(p).resolves.toMatchObject({ approved: false })
  })

  it('rejects stale and double decisions', async () => {
    const engine = new ApprovalEngine()
    const p = engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })
    await Promise.resolve()
    const id = [...engine.pendingIds][0]
    expect(engine.answer(id, 'approve')).toBe(true)
    expect(engine.answer(id, 'approve')).toBe(false)
    expect(engine.answer(999999, 'reject')).toBe(false)
    await expect(p).resolves.toMatchObject({ approved: true })
  })

  it('exposes display data without mutable authority', async () => {
    let notified: unknown = null
    const engine = new ApprovalEngine((approval) => { notified = approval })
    const pending = engine.request(
      { name: 'notion-update-page', mutates: true, kind: 'content-update', args: { page_id: 'abc123' }, targets: ['abc123'], parents: [] as string[], affectedCount: 1 },
      { action: 'require-approval', reasons: ['ask mode'] },
    )
    await Promise.resolve()
    expect(notified).not.toBeNull()
    expect(notified).toMatchObject({ targetUrl: 'https://www.notion.so/abc123' })
    expect((notified as { reversibility: string }).reversibility).toMatch(/undo/i)
    expect(notified).not.toHaveProperty('resolve')
    expect(notified).not.toHaveProperty('frozenArgs')
    engine.rejectAllPending()
    await pending
  })

  it('shows the complete payload past the old 2,000-character cutoff', async () => {
    let notified: unknown = null
    const engine = new ApprovalEngine((approval) => { notified = approval })
    const content = `${'A'.repeat(1900)}-TAIL-FLAG`
    const pending = engine.request(
      {
        name: 'notion-update-page', mutates: true, kind: 'content-replace',
        args: { data: { page_id: 'p1' }, command: { type: 'replace_content', content, extra: 'late-target' } },
        targets: ['p1'],
        parents: [] as string[],
        affectedCount: 1,
      },
      { action: 'require-approval', reasons: ['ask mode'] },
    )
    await Promise.resolve()
    const payload = (notified as { payloadJson: string }).payloadJson
    expect(payload.length).toBeGreaterThan(2000)
    expect(payload).toContain('-TAIL-FLAG')
    expect(payload).toContain('late-target')
    engine.rejectAllPending()
    await pending
  })

  it('cancelling clears pending cards without approving', async () => {
    const engine = new ApprovalEngine()
    const cancelled = engine.request(WRITE_CALL, { action: 'require-approval', reasons: [] })
    await Promise.resolve()
    expect(engine.pendingCount).toBe(1)
    engine.rejectAllPending()
    await expect(cancelled).resolves.toMatchObject({ approved: false })
    expect(engine.pendingCount).toBe(0)
  })
})
