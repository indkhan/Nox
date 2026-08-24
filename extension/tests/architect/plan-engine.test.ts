import { describe, expect, it, vi } from 'vitest'
import { PlanEngine } from '../../src/lib/architect/plan-engine'
import { validateWorkspacePlan } from '../../src/lib/architect/plan'

const plan = {
  goal: 'Track habits',
  recommendation: 'Reuse Daily Log',
  evidence: [{ id: 'db-1', title: 'Daily Log', kind: 'database' as const, reason: 'Already stores dated records' }],
  operations: [{ tool: 'notion-update-data-source', targetId: 'db-1', summary: 'Add Completed checkbox' }],
  consequences: ['One database schema changes'],
}

describe('validateWorkspacePlan', () => {
  it('accepts a compact plan and rejects empty operations', () => {
    expect(validateWorkspacePlan(plan).operations).toHaveLength(1)
    expect(() => validateWorkspacePlan({ ...plan, operations: [] })).toThrow(/operation/i)
    expect(() => validateWorkspacePlan({ ...plan, evidence: [] })).toThrow(/evidence/i)
  })
})

describe('PlanEngine', () => {
  it('blocks structural operations until matching plan is approved', async () => {
    const notify = vi.fn((pending) => pending.resolve('approved'))
    const engine = new PlanEngine(notify)
    engine.beginTurn('turn-1')
    expect(engine.authorize('notion-update-data-source', { data_source_id: 'db-1' }).allowed).toBe(false)
    await expect(engine.request(plan)).resolves.toBe('approved')
    expect(engine.authorize('notion-update-data-source', { data_source_id: 'db-1' }).allowed).toBe(true)
    expect(engine.authorize('notion-update-data-source', { data_source_id: 'db-2' }).allowed).toBe(false)
  })

  it('expires approval on a new turn', async () => {
    const engine = new PlanEngine((pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan)
    engine.beginTurn('turn-2')
    expect(engine.authorize('notion-update-data-source', { data_source_id: 'db-1' }).allowed).toBe(false)
  })

  it('rejects pending plans on cancellation', async () => {
    let notified = false
    const engine = new PlanEngine(() => { notified = true })
    engine.beginTurn('turn-1')
    const pending = engine.request(plan)
    expect(notified).toBe(true)
    engine.rejectPending()
    await expect(pending).resolves.toBe('rejected')
  })
})
