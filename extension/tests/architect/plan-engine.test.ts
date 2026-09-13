import { describe, expect, it, vi } from 'vitest'
import { PlanEngine } from '../../src/lib/architect/plan-engine'
import { validateWorkspacePlan } from '../../src/lib/architect/plan'
import { isInspectedEvidence, recordRetrievals } from '../../src/lib/agent/retrievals'

const THREAD = 'thread-plan-review'
const DB = '11111111-2222-3333-4444-555555555555'
const DB_OTHER = '22222222-3333-4444-5555-666666666666'

const plan = {
  goal: 'Track habits',
  recommendation: 'Reuse Daily Log',
  evidence: [{ id: DB, title: 'Daily Log', kind: 'database' as const, reason: 'Already stores dated records' }],
  operations: [{ tool: 'notion-update-data-source', targetId: DB, summary: 'Add Completed checkbox' }],
  consequences: ['One database schema changes'],
}

const scopeFor = (threadId: string) => ({ threadId, isInspected: isInspectedEvidence })

function inspectedEngine(threadId: string, notify?: (pending: { resolve: (d: 'approved' | 'rejected') => void }) => void) {
  recordRetrievals(threadId, [DB])
  return new PlanEngine(
    notify as (pending: import('../../src/lib/architect/plan-engine').PendingWorkspacePlan) => void,
    undefined,
    { getThreadId: () => threadId },
  )
}

describe('validateWorkspacePlan', () => {
  it('accepts a compact plan and rejects empty operations', () => {
    recordRetrievals(THREAD, [DB])
    expect(validateWorkspacePlan(plan, scopeFor(THREAD)).operations).toHaveLength(1)
    expect(() => validateWorkspacePlan({ ...plan, operations: [] }, scopeFor(THREAD))).toThrow(/operation/i)
    expect(() => validateWorkspacePlan({ ...plan, evidence: [] }, scopeFor(THREAD))).toThrow(/evidence/i)
  })

  it('rejects non-canonical operation tool names', () => {
    expect(() => validateWorkspacePlan({
      ...plan,
      operations: [{ tool: 'create database', summary: 'Create tracker' }],
    }, scopeFor(THREAD))).toThrow(/tool/i)
  })

  it('rejects null evidence entries without crashing', () => {
    expect(() => validateWorkspacePlan({ ...plan, evidence: [null] }, scopeFor(THREAD))).toThrow(/evidence/i)
  })

  it('rejects numeric targets with a model-readable error', () => {
    expect(() => validateWorkspacePlan({
      ...plan,
      operations: [{ tool: 'notion-update-data-source', targetId: 123 as unknown as string, summary: 'Change' }],
    }, scopeFor(THREAD))).toThrow(/target/i)
  })

  it('rejects duplicate operations and oversize lists', () => {
    const duplicate = { tool: 'notion-update-data-source', targetId: DB, summary: 'Same change twice' }
    expect(() => validateWorkspacePlan({ ...plan, operations: [duplicate, duplicate] }, scopeFor(THREAD))).toThrow(/duplicate/i)
    expect(() => validateWorkspacePlan({
      ...plan,
      operations: Array.from({ length: 11 }, (_, i) => ({ tool: 'notion-update-data-source', targetId: DB, summary: `Change ${i}` })),
    }, scopeFor(THREAD))).toThrow(/operation/i)
  })

  it('rejects fabricated evidence that was never retrieved', () => {
    expect(() => validateWorkspacePlan(plan, scopeFor('thread-never-fetched'))).toThrow(/evidence|inspect/i)
  })

  it('rejects invalid consequences instead of filtering them quietly', () => {
    expect(() => validateWorkspacePlan({ ...plan, consequences: ['ok', 42] }, scopeFor(THREAD))).toThrow(/consequence/i)
  })
})

describe('PlanEngine', () => {
  it('blocks structural operations until matching plan is approved', async () => {
    const engine = inspectedEngine('thread-engine-1', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    expect(engine.authorize('notion-update-data-source', { data_source_id: DB }).allowed).toBe(false)
    await expect(engine.request(plan)).resolves.toBe('approved')
    expect(engine.authorize('notion-update-data-source', { data_source_id: DB }).allowed).toBe(true)
    expect(engine.authorize('notion-update-data-source', { data_source_id: DB_OTHER }).allowed).toBe(false)
  })

  it('expires approval on a new turn', async () => {
    const engine = inspectedEngine('thread-engine-2', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan)
    engine.beginTurn('turn-2')
    expect(engine.authorize('notion-update-data-source', { data_source_id: DB }).allowed).toBe(false)
  })

  it('authorizes create-view when the approved target is its database', async () => {
    const engine = inspectedEngine('thread-engine-3', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{ tool: 'notion-create-view', targetId: DB, summary: 'Add calendar view' }],
    })
    expect(engine.authorize('notion-create-view', {
      database_id: DB,
      data_source_id: DB_OTHER,
      name: 'Calendar',
    }).allowed).toBe(true)
  })

  it('authorizes update-view when the approved target is the view', async () => {
    const engine = inspectedEngine('thread-engine-4', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{ tool: 'notion-update-view', targetId: DB, summary: 'Rename view' }],
    })
    expect(engine.authorize('notion-update-view', { view_id: DB, name: 'History' }).allowed).toBe(true)
  })

  it('rejects pending plans on cancellation', async () => {
    let notified = false
    const engine = inspectedEngine('thread-engine-5', () => { notified = true })
    engine.beginTurn('turn-1')
    const pending = engine.request(plan)
    expect(notified).toBe(true)
    engine.rejectPending()
    await expect(pending).resolves.toBe('rejected')
  })

  it('dismisses the card when a pending plan expires', async () => {
    const dismiss = vi.fn()
    const engine = new PlanEngine(vi.fn(), dismiss, { getThreadId: () => 'thread-engine-6' })
    recordRetrievals('thread-engine-6', [DB])
    engine.beginTurn('turn-1')
    const pending = engine.request(plan)
    engine.beginTurn('turn-2')
    await expect(pending).resolves.toBe('rejected')
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('approves a valid plan without showing a card in Auto mode', async () => {
    const notify = vi.fn()
    const engine = inspectedEngine('thread-engine-7', notify)
    engine.beginTurn('turn-1')
    await expect(engine.request(plan, true)).resolves.toBe('approved')
    expect(notify).not.toHaveBeenCalled()
    expect(engine.authorize('notion-update-data-source', { data_source_id: DB }).allowed).toBe(true)
  })

  it('rejects a plan whose evidence was never inspected without a card', async () => {
    const notify = vi.fn()
    const engine = new PlanEngine(notify, undefined, { getThreadId: () => 'thread-uninspected' })
    engine.beginTurn('turn-1')
    expect(() => engine.request(plan)).toThrow(/evidence|inspect/i)
    expect(notify).not.toHaveBeenCalled()
  })
})
