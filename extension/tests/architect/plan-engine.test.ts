import { describe, expect, it, vi } from 'vitest'
import { PlanEngine } from '../../src/lib/architect/plan-engine'
import { validateWorkspacePlan } from '../../src/lib/architect/plan'
import { isInspectedEvidence, recordRetrievals } from '../../src/lib/agent/retrievals'
import { validateEffect, type ValidatedEffect } from '../../src/lib/writes/effects'
import type { PlanScope } from '../../src/lib/architect/plan-engine'

const THREAD = 'thread-plan-review'
const DB = '11111111-2222-3333-4444-555555555555'
const DB_OTHER = '22222222-3333-4444-5555-666666666666'

const plan = {
  goal: 'Track habits',
  recommendation: 'Reuse Daily Log',
  evidence: [{ id: DB, title: 'Daily Log', kind: 'database' as const, reason: 'Already stores dated records' }],
  operations: [{ tool: 'notion-update-data-source', targetId: DB, args: { data_source_id: DB }, summary: 'Add Completed checkbox' }],
  consequences: ['One database schema changes'],
}

const scopeFor = (threadId: string) => ({ threadId, isInspected: isInspectedEvidence })

function scope(threadId: string, turnId = 'turn-1', connectionGeneration = 'conn-1'): PlanScope {
  return { workspaceId: 'ws-1', connectionGeneration, threadId, turnId }
}

function effectFor(tool: string, args: Record<string, unknown>): ValidatedEffect {
  return validateEffect(tool, args)
}

function inspectedEngine(threadId: string, notify?: (pending: { resolve: (d: 'approved' | 'rejected') => void }) => void) {
  recordRetrievals(threadId, [DB])
  return new PlanEngine(
    notify as (pending: import('../../src/lib/architect/plan-engine').PendingWorkspacePlan) => void,
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
    recordRetrievals(THREAD, [DB])
    expect(() => validateWorkspacePlan({
      ...plan,
      operations: [{ tool: 'notion-update-data-source', targetId: 123 as unknown as string, args: { data_source_id: DB }, summary: 'Change' }],
    }, scopeFor(THREAD))).toThrow(/target/i)
  })

  it('rejects duplicate operations and oversize lists', () => {
    recordRetrievals(THREAD, [DB])
    const duplicate = { tool: 'notion-update-data-source', targetId: DB, args: { data_source_id: DB }, summary: 'Same change twice' }
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
  it('blocks structural operations until the exact operation is approved', async () => {
    const engine = inspectedEngine('thread-engine-1', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    expect(engine.authorize(effect, scope('thread-engine-1')).allowed).toBe(false)
    await expect(engine.request(plan, scope('thread-engine-1'))).resolves.toBe('approved')
    const grant = engine.authorize(effect, scope('thread-engine-1'))
    expect(grant.allowed).toBe(true)
    expect(grant.reservationId).toBeTruthy()
    expect(grant.operationLabel).toBe('op-1')
    expect(engine.authorize(effectFor('notion-update-data-source', { data_source_id: DB_OTHER }), scope('thread-engine-1')).allowed).toBe(false)
  })

  it('refuses the same tool and target with changed schema content', async () => {
    const page = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const engine = inspectedEngine('thread-engine-content', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{
        tool: 'notion-update-page',
        targetId: page,
        args: { data: { page_id: page }, command: { type: 'update_properties', properties: { a: 1 } } },
        summary: 'Set A',
      }],
    }, scope('thread-engine-content'))
    const changed = effectFor('notion-update-page', {
      data: { page_id: page },
      command: { type: 'update_properties', properties: { a: 2 } },
    })
    expect(engine.authorize(changed, scope('thread-engine-content')).allowed).toBe(false)
  })

  it('refuses a changed parent destination', async () => {
    const parentA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const parentB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const engine = inspectedEngine('thread-engine-parent', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{ tool: 'notion-create-database', args: { parent: { page_id: parentA } }, summary: 'Create here' }],
    }, scope('thread-engine-parent'))
    const moved = effectFor('notion-create-database', { parent: { page_id: parentB } })
    expect(engine.authorize(moved, scope('thread-engine-parent')).allowed).toBe(false)
  })

  it('consumes each approved operation at dispatch, even once', async () => {
    const engine = inspectedEngine('thread-engine-consume', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan, scope('thread-engine-consume'))
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    const first = engine.authorize(effect, scope('thread-engine-consume'))
    expect(first.allowed).toBe(true)
    expect(engine.consume(first.reservationId!)).toBe(true)
    expect(engine.authorize(effect, scope('thread-engine-consume')).allowed).toBe(false)
  })

  it('rejects simultaneous duplicate reservations for one slot', async () => {
    const engine = inspectedEngine('thread-engine-race', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan, scope('thread-engine-race'))
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    const first = engine.authorize(effect, scope('thread-engine-race'))
    const second = engine.authorize(effect, scope('thread-engine-race'))
    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(false)
  })

  it('expires authorization on connection, workspace, thread, and turn changes', async () => {
    const engine = inspectedEngine('thread-engine-stale', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan, scope('thread-engine-stale'))
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    expect(engine.authorize(effect, scope('thread-engine-stale', 'turn-1', 'conn-2')).allowed).toBe(false)
    expect(engine.authorize(effect, { ...scope('thread-engine-stale'), workspaceId: 'ws-2' }).allowed).toBe(false)
    expect(engine.authorize(effect, scope('thread-other')).allowed).toBe(false)
    expect(engine.authorize(effect, scope('thread-engine-stale', 'turn-2')).allowed).toBe(false)
  })

  it('expires approval on a new turn', async () => {
    const engine = inspectedEngine('thread-engine-2', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request(plan, scope('thread-engine-2'))
    engine.beginTurn('turn-2')
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    expect(engine.authorize(effect, scope('thread-engine-2')).allowed).toBe(false)
  })

  it('requires an explicit card approval in Auto mode too', async () => {
    const notify = vi.fn()
    const engine = inspectedEngine('thread-engine-auto', notify)
    engine.beginTurn('turn-1')
    const pending = engine.request(plan, scope('thread-engine-auto'))
    expect(notify).toHaveBeenCalledOnce()
    engine.rejectPending()
    await expect(pending).resolves.toBe('rejected')
  })

  it('authorizes create-view when the approved target is its database', async () => {
    const engine = inspectedEngine('thread-engine-3', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{ tool: 'notion-create-view', targetId: DB, args: { database_id: DB, name: 'Calendar' }, summary: 'Add calendar view' }],
    }, scope('thread-engine-3'))
    const effect = effectFor('notion-create-view', { database_id: DB, name: 'Calendar' })
    const grant = engine.authorize(effect, scope('thread-engine-3'))
    expect(grant.allowed).toBe(true)
    expect(engine.consume(grant.reservationId!, '{"ok":true}')).toBe(true)
  })

  it('authorizes update-view when the approved target is the view', async () => {
    const engine = inspectedEngine('thread-engine-4', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [{ tool: 'notion-update-view', targetId: DB, args: { view_id: DB, name: 'History' }, summary: 'Rename view' }],
    }, scope('thread-engine-4'))
    const effect = effectFor('notion-update-view', { view_id: DB, name: 'History' })
    expect(engine.authorize(effect, scope('thread-engine-4')).allowed).toBe(true)
  })

  it('rejects pending plans on cancellation', async () => {
    let notified = false
    const engine = inspectedEngine('thread-engine-5', () => { notified = true })
    engine.beginTurn('turn-1')
    const pending = engine.request(plan, scope('thread-engine-5'))
    expect(notified).toBe(true)
    engine.rejectPending()
    await expect(pending).resolves.toBe('rejected')
  })

  it('dismisses the card when a pending plan expires', async () => {
    const dismiss = vi.fn()
    const engine = new PlanEngine(vi.fn(), dismiss)
    recordRetrievals('thread-engine-6', [DB])
    engine.beginTurn('turn-1')
    const pending = engine.request(plan, scope('thread-engine-6'))
    engine.beginTurn('turn-2')
    await expect(pending).resolves.toBe('rejected')
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('approves a valid plan only through an explicit card decision', async () => {
    const notify = vi.fn((pending: { resolve: (d: 'approved' | 'rejected') => void }) => pending.resolve('approved'))
    const engine = inspectedEngine('thread-engine-7', notify)
    engine.beginTurn('turn-1')
    await expect(engine.request(plan, scope('thread-engine-7'))).resolves.toBe('approved')
    expect(notify).toHaveBeenCalledOnce()
    const effect = effectFor('notion-update-data-source', { data_source_id: DB })
    expect(engine.authorize(effect, scope('thread-engine-7')).allowed).toBe(true)
  })

  it('rejects a plan whose evidence was never inspected without a card', async () => {
    const notify = vi.fn()
    const engine = new PlanEngine(notify)
    engine.beginTurn('turn-1')
    expect(() => engine.request(plan, scope('thread-uninspected'))).toThrow(/evidence|inspect/i)
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects forward references to later operations', async () => {
    const engine = inspectedEngine('thread-engine-fwd', () => undefined)
    engine.beginTurn('turn-1')
    expect(() => engine.request({
      ...plan,
      operations: [
        { opId: 'first', tool: 'notion-update-page', targetId: { ref: 'second' }, args: { data: { page_id: DB }, command: { type: 'update_properties', properties: {} } }, summary: 'Forward' },
        { opId: 'second', tool: 'notion-create-pages', args: { pages: [] }, summary: 'Create' },
      ],
    }, scope('thread-engine-fwd'))).toThrow(/ref/i)
  })

  it('rejects self references and references to non-creations', async () => {
    const engine = inspectedEngine('thread-engine-self', () => undefined)
    engine.beginTurn('turn-1')
    expect(() => engine.request({
      ...plan,
      operations: [
        { opId: 'only', tool: 'notion-update-page', targetId: { ref: 'only' }, args: { data: { page_id: DB }, command: { type: 'update_properties', properties: {} } }, summary: 'Self' },
      ],
    }, scope('thread-engine-self'))).toThrow(/ref/i)
    expect(() => engine.request({
      ...plan,
      operations: [
        { opId: 'upd', tool: 'notion-update-data-source', targetId: DB, args: { data_source_id: DB }, summary: 'Schema' },
        { opId: 'use', tool: 'notion-update-page', targetId: { ref: 'upd' }, args: { data: { page_id: DB }, command: { type: 'update_properties', properties: {} } }, summary: 'Use schema op' },
      ],
    }, scope('thread-engine-self'))).toThrow(/ref|creation/i)
  })

  it('requires a second concrete plan while creation result shapes stay unverified', async () => {
    const created = '33333333-4444-5555-6666-777777777777'
    const useArgs = { data: { page_id: { ref: 'mk' } }, command: { type: 'update_properties', properties: {} } }
    const engine = inspectedEngine('thread-engine-unverified', (pending) => pending.resolve('approved'))
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [
        { opId: 'mk', tool: 'notion-create-pages', args: { pages: [] }, summary: 'Create' },
        { opId: 'use', tool: 'notion-update-page', targetId: { ref: 'mk' }, args: useArgs, summary: 'Edit it' },
      ],
    }, scope('thread-engine-unverified'))
    const mkEffect = effectFor('notion-create-pages', { pages: [] })
    const mkGrant = engine.authorize(mkEffect, scope('thread-engine-unverified'))
    expect(mkGrant.allowed).toBe(true)
    expect(engine.consume(mkGrant.reservationId!, '{"ok":true}')).toBe(true)
    const useEffect = effectFor('notion-update-page', { data: { page_id: created }, command: { type: 'update_properties', properties: {} } })
    expect(engine.authorize(useEffect, scope('thread-engine-unverified')).allowed).toBe(false)
  })

  it('resolves verified creation slots for exact dependent matches', async () => {
    const created = '33333333-4444-5555-6666-777777777777'
    const createdArgs = { pages: [{ parent: { page_id: DB } }] }
    const useArgs = { data: { page_id: { ref: 'mk' } }, command: { type: 'update_properties', properties: {} } }
    const adapters = {
      'notion-create-pages': (resultText: string) => {
        const parsed = JSON.parse(resultText) as { created_id?: unknown }
        return typeof parsed.created_id === 'string' ? [parsed.created_id] : []
      },
    }
    const engine = new PlanEngine(
      (pending) => pending.resolve('approved'),
      undefined,
      adapters,
    )
    recordRetrievals('thread-engine-verified', [DB])
    engine.beginTurn('turn-1')
    await engine.request({
      ...plan,
      operations: [
        { opId: 'mk', tool: 'notion-create-pages', args: createdArgs, summary: 'Create one' },
        { opId: 'use', tool: 'notion-update-page', targetId: { ref: 'mk' }, args: useArgs, summary: 'Edit it' },
      ],
    }, scope('thread-engine-verified'))
    const mkGrant = engine.authorize(effectFor('notion-create-pages', createdArgs), scope('thread-engine-verified'))
    expect(mkGrant.allowed).toBe(true)
    expect(engine.consume(mkGrant.reservationId!, JSON.stringify({ created_id: created }))).toBe(true)
    const concreteUse = { data: { page_id: created }, command: { type: 'update_properties', properties: {} } }
    const useGrant = engine.authorize(effectFor('notion-update-page', concreteUse), scope('thread-engine-verified'))
    expect(useGrant.allowed).toBe(true)
    expect(useGrant.operationLabel).toBe('use')
  })

  it('refuses dependents on missing or extra creation results', async () => {
    const created = '33333333-4444-5555-6666-777777777777'
    const createdArgs = { pages: [{ parent: { page_id: DB } }] }
    const useArgs = { data: { page_id: { ref: 'mk' } }, command: { type: 'update_properties', properties: {} } }
    const ops = [
      { opId: 'mk', tool: 'notion-create-pages', args: createdArgs, summary: 'Create one' },
      { opId: 'use', tool: 'notion-update-page', targetId: { ref: 'mk' }, args: useArgs, summary: 'Edit it' },
    ]
    const build = (threadId: string, adapter: (resultText: string) => string[]) => {
      const engine = new PlanEngine(
        (pending) => pending.resolve('approved'),
        undefined,
        { 'notion-create-pages': adapter },
      )
      recordRetrievals(threadId, [DB])
      return engine
    }
    const parseIds = (resultText: string) => {
      const parsed = JSON.parse(resultText) as { ids?: unknown }
      return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : []
    }

    const missing = build('thread-engine-missing', parseIds)
    missing.beginTurn('turn-1')
    await missing.request({ ...plan, operations: ops }, scope('thread-engine-missing'))
    const missingGrant = missing.authorize(effectFor('notion-create-pages', createdArgs), scope('thread-engine-missing'))
    expect(missingGrant.allowed).toBe(true)
    expect(missing.consume(missingGrant.reservationId!, '{"ids":[]}')).toBe(true)
    const concreteUse = { data: { page_id: created }, command: { type: 'update_properties', properties: {} } }
    expect(missing.authorize(effectFor('notion-update-page', concreteUse), scope('thread-engine-missing')).allowed).toBe(false)

    const extra = build('thread-engine-extra', parseIds)
    extra.beginTurn('turn-1')
    await extra.request({ ...plan, operations: ops }, scope('thread-engine-extra'))
    const extraGrant = extra.authorize(effectFor('notion-create-pages', createdArgs), scope('thread-engine-extra'))
    expect(extraGrant.allowed).toBe(true)
    expect(extra.consume(extraGrant.reservationId!, `{"ids":["${created}","${DB}"]}`)).toBe(true)
    expect(extra.authorize(effectFor('notion-update-page', concreteUse), scope('thread-engine-extra')).allowed).toBe(false)
  })

  it('refuses a silently reproposed plan after rejection until a new turn', async () => {
    const engine = inspectedEngine('thread-engine-repeat', (pending) => pending.resolve('rejected'))
    engine.beginTurn('turn-1')
    await expect(engine.request(plan, scope('thread-engine-repeat'))).resolves.toBe('rejected')
    expect(() => engine.request(plan, scope('thread-engine-repeat'))).toThrow(/reject/i)
    engine.beginTurn('turn-2')
    const retry = engine.request(plan, scope('thread-engine-repeat'))
    engine.rejectPending()
    await expect(retry).resolves.toBe('rejected')
  })
})
