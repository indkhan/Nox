import { describe, expect, it, vi } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { UncertainDispatchError } from '../../src/lib/mcp/scheduler'
import { McpUnauthenticatedError } from '../../src/lib/mcp/client'
import { MutationJournal, type JournalEntry, type JournalStore } from '../../src/lib/writes/journal'
import { GuardViolation, hashMarkdown } from '../../src/lib/writes/guard'
import { requestRuntimeUndo, undoEntry, undoNewest } from '../../src/lib/writes/undo'
import { buildInverse } from '../../src/lib/writes/inverse'
import { normalizeId } from '../../src/shared/notion-page'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'
import type { ValidatedEffect } from '../../src/lib/writes/effects'
import type { PlanScope } from '../../src/lib/architect/plan-engine'
import type { Mode } from '../../src/lib/writes/approvals'

const PAGE = 'a'.repeat(32)
const completePage = (markdown: string) => JSON.stringify({ id: PAGE, content: markdown, truncated: false })
const rememberComplete = (gate: WriteGate, markdown: string) => gate.rememberNormalizedRead(PAGE, { structuredContent: { id: PAGE, content: markdown, truncated: false } })

function makeGate(over: {
  mode?: Mode
  markdown?: () => string | Promise<string>
  callTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeDispatch?: () => void | Promise<void>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
  contextSet?: Set<string>
  grant?: { allowed: boolean; pages: string[] }
  authorizeStructuralChange?: (effect: ValidatedEffect, scope: PlanScope) => { allowed: boolean; reason?: string; reservationId?: string }
  checkPlanReservation?: (reservationId: string, scope: PlanScope) => boolean
  consumePlanReservation?: (reservationId: string, resultText?: string) => void
  journal?: MutationJournal
  workspaceId?: string | null
  assertToolAllowed?: (tool: string) => void
} = {}) {
  let answer: 'approve' | 'reject' | null = null
  let simulatedMarkdown = '# Simple\noriginal text'
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const journal = over.journal ?? new MutationJournal()
  const access = createTurnAccessState()
  access.begin(over.mode ?? 'ask', [...(over.contextSet ?? new Set([PAGE]))], [], over.grant ?? { allowed: true, pages: [PAGE] })
  const gate = new WriteGate({
    callTool:
      over.callTool ??
      (async (name, args) => {
        calls.push({ name, args })
        const command = args.command as { type?: string; content?: string } | undefined
        if (command?.type === 'replace_content' && typeof command.content === 'string') simulatedMarkdown = command.content
        return { content: [{ type: 'text', text: `ran ${name}` }] }
      }),
    fetchPageMarkdown: async () => {
      const text = await over.markdown?.() ?? simulatedMarkdown
      return text.trimStart().startsWith('{') || text.includes('…[truncated by Nox]') ? text : completePage(text)
    },
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (count) => access.recordUnplannedEffects(count),
    authorizeStructuralChange: over.authorizeStructuralChange ?? (() => ({ allowed: true })),
    checkPlanReservation: over.checkPlanReservation,
    consumePlanReservation: over.consumePlanReservation,
    // Existing suites exercise owner-panel behavior; viewer refusal is
    // pinned by tests/writes/ownership.test.ts and the default-deny test.
    ownership: {
      isOwner: () => true,
      getOwnerGeneration: () => 'test-owner-gen',
      getConnectionGeneration: () => 'test-conn-gen',
    },
    getWorkspaceId: () => (over.workspaceId === undefined ? 'workspace-1' : over.workspaceId),
    assertToolAllowed: over.assertToolAllowed,
  })
  journal.setThread('thread-test')
  return { gate, journal, calls, setAnswer: (a: 'approve' | 'reject') => void (answer = a), getAnswer: () => answer }
}

function propertiesArgs() {
  return { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } }
}

function autoProperties(rid: number, signal?: AbortSignal) {
  return {
    rid,
    tool: 'notion-update-page',
    args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: { Done: true } } },
    namespace: null,
    signal,
  } as const
}

function hookJournal(hooks: { onAppend?: (entry: JournalEntry, count: number) => void; failAppendAfter?: number } = {}): { journal: MutationJournal; appended: () => JournalEntry[] } {
  const backing: JournalEntry[] = []
  let count = 0
  const store: JournalStore = {
    async append(entry) {
      count++
      hooks.onAppend?.(entry, count)
      if (hooks.failAppendAfter != null && count > hooks.failAppendAfter) throw new Error('disk full')
      const index = backing.findIndex((e) => e.id === entry.id)
      if (index >= 0) backing[index] = entry
      else backing.push(entry)
    },
    async list() {
      return [...backing]
    },
  }
  const journal = new MutationJournal(store)
  journal.setThread('thread-test')
  return { journal, appended: () => [...backing] }
}

describe('WriteGate', () => {
  it('counts individually approved writes toward the unplanned budget', async () => {
    const { gate, calls } = makeGate({ mode: 'ask' })
    for (let i = 0; i < 6; i++) {
      const pending = gate.handle(autoProperties(i))
      await vi.waitFor(() => expect(gate.approvals.pendingCount).toBe(1))
      gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
      const result = await pending as { content: Array<{ text: string }> }
      if (i === 5) expect(result.content[0].text).toMatch(/PLAN_REQUIRED/)
    }
    expect(calls).toHaveLength(5)
  })

  it('keeps an unresolved page write blocking that page in a new chat', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    const pending = await journal.beginIntent({
      tool: 'notion-update-page', args: propertiesArgs(), kind: 'properties', targetPageId: PAGE,
      scope: { threadId: 'thread-test', turnId: 'old-turn', workspaceId: 'workspace-1', connectionGeneration: 'old', ownerGeneration: 'old' },
    })
    await journal.settleIntent(pending.id, { status: 'unknown' })
    journal.setThread('new-chat')
    expect(await journal.unresolvedInScope('new-chat', new Set(), 'workspace-1', [PAGE])).toHaveLength(1)
    const result = await gate.handle(autoProperties(50)) as { content: Array<{ text: string }> }
    expect(result.content[0].text).toMatch(/CONFLICT_UNRESOLVED/)
    expect(calls).toHaveLength(0)
  })
  it('refuses an undo after switching Notion workspaces', async () => {
    const { gate, journal, calls } = makeGate({ workspaceId: 'workspace-2' })
    const args = propertiesArgs()
    const entry = await journal.record({
      tool: 'notion-update-page', args, kind: 'properties', targetPageId: PAGE,
      scope: { threadId: 'thread-test', turnId: 'old', workspaceId: 'workspace-1', connectionGeneration: 'old', ownerGeneration: 'old' },
      verification: 'verified',
      preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Simple\noriginal text', baselineComplete: true },
      inverse: { tool: 'notion-update-page', args },
    })
    await expect(gate.handleUndo('notion-update-page', args, { journalId: entry.id })).rejects.toThrow(/WORKSPACE_CHANGED/)
    expect(calls).toHaveLength(0)
  })
  it('refuses an applied but unverified undo even with a stored inverse', async () => {
    const { gate, journal, calls } = makeGate()
    const args = propertiesArgs()
    const entry = await journal.record({
      tool: 'notion-update-page', args, kind: 'properties', targetPageId: PAGE,
      scope: { threadId: 'thread-test', turnId: 'old', workspaceId: 'workspace-1', connectionGeneration: 'old', ownerGeneration: 'old' },
      verification: 'unverified', inverse: { tool: 'notion-update-page', args },
    })
    await expect(gate.handleUndo('notion-update-page', args, { journalId: entry.id })).rejects.toThrow(/NOT_UNDOABLE/)
    expect(calls).toHaveLength(0)
  })
  it('refuses an inverse without a verifiable postcondition before dispatch', async () => {
    const { gate, journal, calls } = makeGate()
    const args = propertiesArgs()
    const entry = await journal.record({
      tool: 'notion-update-page', args, kind: 'properties', targetPageId: PAGE,
      scope: { threadId: 'thread-test', turnId: 'old', workspaceId: 'workspace-1', connectionGeneration: 'old', ownerGeneration: 'old' },
      verification: 'verified', inverse: { tool: 'notion-update-page', args },
    })
    await expect(gate.handleUndo('notion-update-page', args, { journalId: entry.id })).rejects.toThrow(/NOT_UNDOABLE/)
    expect((await journal.getEntry(entry.id))?.status).toBe('applied')
    expect(calls).toHaveLength(0)
  })
  it('refuses legacy undo entries without a recorded workspace', async () => {
    const { gate, journal, calls } = makeGate()
    const args = propertiesArgs()
    const entry = await journal.record({ tool: 'notion-update-page', args, kind: 'properties', targetPageId: PAGE,
      verification: 'verified', preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Simple\noriginal text', baselineComplete: true },
      inverse: { tool: 'notion-update-page', args } })
    await expect(gate.handleUndo('notion-update-page', args, { journalId: entry.id })).rejects.toThrow(/WORKSPACE_CHANGED/)
    expect(calls).toHaveLength(0)
  })
  it('refuses mutations without ownership wiring (deny by default)', async () => {
    let dispatched = false
    const gate = new WriteGate({
      callTool: async () => {
        dispatched = true
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# page',
      getMode: () => 'auto',
      getContextSet: () => new Set([PAGE]),
    })
    const out = await gate.handle({
      rid: 1,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      namespace: null,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER/)
    expect(dispatched).toBe(false)
  })

  it('blocks structural writes without plan authorization', async () => {
    const { gate, calls } = makeGate({
      mode: 'auto',
      authorizeStructuralChange: () => ({ allowed: false, reason: 'PLAN_REQUIRED: propose a plan first' }),
    })
    const result = await gate.handle({ rid: 1, tool: 'notion-create-database', args: { parent: { page_id: PAGE } }, namespace: null }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/PLAN_REQUIRED/)
    expect(calls).toHaveLength(0)
  })

  it('plan-authorized operations skip redundant ordinary consent', async () => {
    const seen: string[] = []
    const { gate, calls } = makeGate({
      mode: 'auto',
      authorizeStructuralChange: () => ({ allowed: true, reservationId: 'res-1' }),
      checkPlanReservation: (id) => {
        seen.push(`check:${id}`)
        return true
      },
      consumePlanReservation: (id) => void seen.push(`consume:${id}`),
    })
    const out = (await gate.handle({
      rid: 2,
      tool: 'notion-create-database',
      args: { parent: { page_id: PAGE } },
      namespace: null,
      provenance: 'untrusted-context',
    })) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-create-database')
    expect(calls).toHaveLength(1)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(seen).toEqual(['check:res-1', 'consume:res-1'])
  })

  it('stale reservations refuse without dispatch', async () => {
    const { gate, calls } = makeGate({
      mode: 'auto',
      authorizeStructuralChange: () => ({ allowed: true, reservationId: 'res-stale' }),
      checkPlanReservation: () => false,
    })
    const out = (await gate.handle({
      rid: 3,
      tool: 'notion-create-database',
      args: { parent: { page_id: PAGE } },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PLAN_MISMATCH/)
    expect(calls).toHaveLength(0)
  })

  it('passes reads straight through without journaling', async () => {
    const { gate, journal } = makeGate()
    const out = (await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })) as {
      content: Array<{ text: string }>
    }
    expect(out.content[0].text).toContain('ran notion-fetch')
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('blocks a write until approved and journals the inverse', async () => {
    const { gate, journal } = makeGate({ mode: 'ask' })
    // Epoch 07: replacement needs a complete model-observed baseline first.
    await rememberComplete(gate, '# Simple\noriginal text')
    const pending = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# New' } },
      namespace: null,
      callId: 'call-write-1',
    })
    // Wait for the card then approve.
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    const card = [...(await journal.newestFirst())]
    void card
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')

    const entries = await journal.undoable()
    expect(entries).toHaveLength(1)
    expect(entries[0].inverse!.tool).toBe('notion-update-page')
    expect(entries[0].callId).toBe('call-write-1')
    expect(JSON.stringify(entries[0].inverse!.args)).toContain('# Simple')
  })

  it('rejected writes return model-readable refusals and never execute', async () => {
    let executed = false
    const { gate } = makeGate({
      mode: 'ask',
      callTool: async () => {
        executed = true
        throw new Error('should not run')
      },
    })
    const pending = gate.handle({ rid: 3, tool: 'notion-move-pages', args: { page_ids: [PAGE] }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'reject')
    const out = (await pending) as { isError?: boolean; content: Array<{ text: string }> }
    expect(executed).toBe(false)
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/REJECTED_BY_USER/)
  })

  it('auto mode runs in-context non-escalated writes immediately', async () => {
    const { gate } = makeGate({ mode: 'auto', contextSet: new Set([PAGE]) })
    const out = (await gate.handle(autoProperties(4))) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')
  })

  it('write guard aborts when the page changed after our snapshot', async () => {
    let version = 0
    const { gate } = makeGate({
      mode: 'ask',
      markdown: () => `# v${version++}`,
    })
    // Baseline observes v0; the guard snapshot then reads v0 while the
    // re-read sees v1 → violation with zero dispatches.
    await rememberComplete(gate, '# v0')
    // First handle() snapshots v0; assertUnchanged reads v1 → violation.
    const pending = gate.handle({
      rid: 5,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'x' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'approve')
    const out = (await pending) as { isError?: boolean; content: Array<{ text: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('PAGE_CHANGED_SINCE_READ')
  })

  it('records a tool-declared failed write as failed, never as applied', async () => {
    const { gate, journal } = makeGate({ mode: 'auto', callTool: async () => ({
      content: [{ type: 'text', text: 'write failed' }], isError: true,
    }) })
    // A baseline is required to reach dispatch; the provider rejection then
    // settles known failure.
    await rememberComplete(gate, '# Simple\noriginal text')
    const pending = gate.handle({ rid: 20, tool: 'notion-update-page', args: { page_id: PAGE }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const result = await pending as { isError?: boolean }
    expect(result.isError).toBe(true)
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('failed')
    expect(entries[0].outcomeDetail).toMatch(/write failed/)
  })

  it('aborts when the page changed since the agent originally read it', async () => {
    let markdown = '# Original'
    let writes = 0
    const { gate } = makeGate({
      mode: 'auto',
      contextSet: new Set([PAGE]),
      markdown: () => markdown,
      callTool: async (name) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: completePage(markdown) }] }
        writes++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    markdown = '# Human edit'
    const pending = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Agent edit' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { isError?: boolean; content: Array<{ text: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('PAGE_CHANGED_SINCE_READ')
    expect(writes).toBe(0)
  })

  it('marks rich-page content replacements not-undoable with a reason', async () => {
    const { gate, journal } = makeGate({ mode: 'ask', markdown: () => '# Page\nsynced_block here' })
    await rememberComplete(gate, '# Page\nsynced_block here')
    const pending = gate.handle({
      rid: 6,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'x' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'approve')
    await pending
    const entries = await journal.newestFirst()
    expect(entries[0].inverse).toBeUndefined()
    expect(entries[0].notUndoableReason).toMatch(/structural|round-trip/i)
  })

  it('ignores and strips model-supplied provenance flags', async () => {
    let received: Record<string, unknown> | null = null
    const { gate } = makeGate({
      mode: 'auto',
      callTool: async (_name, args) => {
        received = args
        return { content: [] }
      },
    })
    const pending = gate.handle({
      rid: 7,
      tool: 'notion-create-pages',
      args: { injected_request: true },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(received).toEqual({})
  })

  it('returns a storage error with zero dispatches when intent cannot persist', async () => {
    let dispatched = false
    const journal = new MutationJournal({
      append: async () => { throw new Error('disk full') },
      list: async () => [],
    })
    const gate = new WriteGate({
      callTool: async () => {
        dispatched = true
        return { content: [{ type: 'text', text: 'written' }] }
      },
      fetchPageMarkdown: async () => '# page',
      getMode: () => 'auto',
      getContextSet: () => new Set([PAGE]),
      journal,
      ownership: {
        isOwner: () => true,
        getOwnerGeneration: () => 'test-owner-gen',
        getConnectionGeneration: () => 'test-conn-gen',
      },
      getWorkspaceId: () => 'workspace-1',
      getSmallEditGrant: () => ({ allowed: true, pages: [PAGE] }),
      recordUnplannedEffects: () => true,
    })
    journal.setThread('thread-test')
    const out = await gate.handle(autoProperties(9)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/JOURNAL_STORAGE_ERROR/)
    expect(dispatched).toBe(false)
  })

  it('journals undo as its own linked intent, not a user mutation', async () => {
    const { gate, journal } = makeGate({ mode: 'ask' })
    await gate.handleUndo('notion-update-page', {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: {} },
    })
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'applied', kind: 'undo', undoOf: undefined })
    expect(entries[0].inverse).toBeUndefined()
  })

  it('refuses undo after the page changed again', async () => {
    let markdown = '# Original'
    const { gate, journal } = makeGate({
      mode: 'auto',
      markdown: () => markdown,
      callTool: async () => { markdown = '# Nox edit'; return { content: [] } },
    })
    await rememberComplete(gate, '# Original')
    const pending = gate.handle({ rid: 21, tool: 'notion-update-page', args: {
      data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Nox edit' },
    }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    const entry = (await journal.undoable())[0]
    markdown = '# Later human edit'
    await expect(gate.handleUndo(entry.inverse!.tool, entry.inverse!.args)).rejects.toThrow(/changed after Nox/i)
    // The refused undo settles its intent as failed and releases the
    // original, which stays safely undoable.
    expect(await journal.undoable()).toHaveLength(1)
  })

  it('settles uncertain dispatch failures as unknown, never as applied', async () => {
    const uncertain = new UncertainDispatchError('mcp http 503: committed before failing')
    let dispatches = 0
    const { gate, journal } = makeGate({
      mode: 'auto',
      callTool: async () => {
        dispatches++
        throw uncertain
      },
    })
    await expect(gate.handle(autoProperties(30))).rejects.toBe(uncertain)
    expect(dispatches).toBe(1)
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unknown')
    expect(entries[0].outcomeDetail).toMatch(/503/)
  })

  it('settles pre-dispatch failures as failed without uncertainty', async () => {
    const missingToken = new McpUnauthenticatedError()
    let dispatches = 0
    const { gate, journal } = makeGate({
      mode: 'auto',
      callTool: async () => {
        dispatches++
        throw missingToken
      },
    })
    // Pre-dispatch failures must surface as-is: no uncertainty wrapper from
    // the gate and no internal retry — but the known failure is recorded.
    await expect(gate.handle(autoProperties(31))).rejects.toBe(missingToken)
    expect(dispatches).toBe(1)
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('failed')
  })

  it('makes zero dispatches when cancelled before admission', async () => {
    let dispatches = 0
    const { gate } = makeGate({
      mode: 'auto',
      callTool: async (_name, _args, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        dispatches++
        return { content: [] }
      },
    })
    const controller = new AbortController()
    controller.abort()
    const out = await gate.handle({
      rid: 32,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      namespace: null,
      signal: controller.signal,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/abort/i)
    expect(dispatches).toBe(0)
  })
})

describe('WriteGate durable intent (Epoch 04)', () => {
  it('waits for an async page update before recording success', async () => {
    const called: string[] = []
    const signal = new AbortController().signal
    const add = vi.spyOn(signal, 'addEventListener')
    const remove = vi.spyOn(signal, 'removeEventListener')
    const { gate, journal } = makeGate({ mode: 'auto', callTool: async (name) => {
      called.push(name)
      return { content: [{ type: 'text', text: JSON.stringify(name === 'notion-update-page'
        ? { object: 'async_task', id: 'task-1', status: 'queued', poll_after_seconds: 0 }
        : { object: 'async_task', id: 'task-1', status: 'succeeded', result: { page_id: PAGE } }) }] }
    } })
    await gate.handle(autoProperties(39, signal))
    expect(called).toEqual(['notion-update-page', 'notion-get-async-task'])
    expect((await journal.newestForThread('thread-test'))[0]?.status).toBe('applied')
    expect(remove.mock.calls.filter(([name]) => name === 'abort')).toHaveLength(add.mock.calls.filter(([name]) => name === 'abort').length)
  })
  it('recognizes an async task carried in structured MCP content', async () => {
    const { gate, journal } = makeGate({ mode: 'auto', callTool: async (name) => name === 'notion-update-page'
      ? { content: [], structuredContent: { object: 'async_task', id: 'task-structured', status: 'queued', poll_after_seconds: 0 } }
      : { content: [{ type: 'text', text: JSON.stringify({ object: 'async_task', id: 'task-structured', status: 'succeeded' }) }] },
    })
    await gate.handle(autoProperties(39))
    expect((await journal.newestForThread('thread-test'))[0]?.remoteTaskId).toBe('task-structured')
  })

  it('rechecks content after scheduler admission delay, before provider dispatch', async () => {
    let markdown = '# Original'
    let admit!: () => void
    const admission = new Promise<void>((resolve) => { admit = resolve })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let writes = 0
    const { gate, journal } = makeGate({
      mode: 'ask',
      markdown: () => markdown,
      callTool: async (_name, _args, _signal, beforeDispatch) => {
        entered()
        await admission
        await beforeDispatch?.()
        writes++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    await rememberComplete(gate, markdown)
    const pending = gate.handle({
      rid: 501,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Agent edit' } },
      namespace: null,
    })
    await vi.waitFor(() => expect(gate.approvals.pendingCount).toBe(1))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await waiting
    markdown = '# Human edit'
    admit()
    const result = await pending as { isError?: boolean; content: Array<{ text?: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/PAGE_CHANGED_SINCE_READ/)
    expect(writes).toBe(0)
    expect((await journal.newestFirst())[0].status).toBe('failed')
  })

  it('restores a string-command content edit with the documented inverse arguments', async () => {
    let markdown = '# Before'
    const sent: Record<string, unknown>[] = []
    const { gate, journal } = makeGate({
      mode: 'ask',
      markdown: () => markdown,
      callTool: async (_name, args) => {
        sent.push(args)
        if (typeof args.new_str === 'string') markdown = args.new_str
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    await rememberComplete(gate, markdown)
    const pending = gate.handle({
      rid: 502,
      tool: 'notion-update-page',
      args: { page_id: PAGE, command: 'replace_content', new_str: '# After' },
      namespace: null,
    })
    await vi.waitFor(() => expect(gate.approvals.pendingCount).toBe(1))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    const original = (await journal.newestFirst())[0]
    expect(original).toMatchObject({ status: 'applied', verification: 'verified' })
    expect(original.inverse?.args).toMatchObject({ page_id: normalizeId(PAGE), command: 'replace_content', new_str: '# Before' })
    expect(sent[0]).toEqual({ page_id: PAGE, command: 'replace_content', new_str: '# After' })
    expect(await requestRuntimeUndo(gate, original.id)).toBe(true)
    expect(sent[1]).toEqual({ page_id: normalizeId(PAGE), command: 'replace_content', new_str: '# Before' })
    expect(markdown).toBe('# Before')
  })
  it('persists a submitted task and resumes observation without resubmitting the write', async () => {
    const journal = new MutationJournal()
    const abort = new AbortController()
    let writes = 0
    const first = makeGate({ mode: 'auto', journal, callTool: async (name) => {
      if (name === 'notion-update-page') {
        writes++
        return { content: [{ type: 'text', text: JSON.stringify({ object: 'async_task', id: 'task-1', status: 'queued', poll_after_seconds: 60 }) }] }
      }
      throw new Error('poll should be cancelled')
    } })
    const pending = first.gate.handle(autoProperties(39, abort.signal))
    await vi.waitFor(async () => expect((await journal.newestForThread('thread-test'))[0]).toMatchObject({ status: 'submitted', remoteTaskId: 'task-1' }))
    abort.abort()
    await pending.catch(() => undefined)
    expect((await journal.newestForThread('thread-test'))[0]?.status).toBe('submitted')
    const second = makeGate({ mode: 'auto', journal, callTool: async (name) => {
      expect(name).toBe('notion-get-async-task')
      return { content: [{ type: 'text', text: JSON.stringify({ object: 'async_task', id: 'task-1', status: 'succeeded' }) }] }
    } })
    await second.gate.resumeSubmittedTasks()
    expect((await journal.newestForThread('thread-test'))[0]).toMatchObject({ status: 'applied', verification: 'unverified' })
    expect(writes).toBe(1)
  })
  const SCOPE = {
    threadId: 'thread-test',
    turnId: 'turn-1',
    workspaceId: 'workspace-1',
    connectionGeneration: 'test-conn-gen',
    ownerGeneration: 'test-owner-gen',
  }

  it('refuses mutations without a persisted thread scope', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    journal.scopeThread(null)
    const out = await gate.handle(autoProperties(40)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NO_PERSISTED_THREAD/)
    expect(calls).toHaveLength(0)
    expect(await journal.newestForThread('thread-test')).toHaveLength(0)
  })

  it('refuses mutations without an established workspace scope', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', workspaceId: null })
    const out = await gate.handle(autoProperties(41)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NO_WORKSPACE_SCOPE/)
    expect(calls).toHaveLength(0)
  })

  it('settles cancelled-before-dispatch as failed without dispatching', async () => {
    const controller = new AbortController()
    const { journal } = hookJournal({ onAppend: (entry) => { if (entry.status === 'pending') controller.abort() } })
    const { gate, calls } = makeGate({ mode: 'auto', journal })
    const out = await gate.handle(autoProperties(42, controller.signal)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/TURN_CANCELLED/)
    expect(calls).toHaveLength(0)
    const entries = await journal.newestForThread('thread-test')
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('failed')
    expect(entries[0].outcomeDetail).toMatch(/cancelled before dispatch/i)
  })

  it('warns visibly while retaining pending when the success record fails', async () => {
    const { journal } = hookJournal({ failAppendAfter: 1 })
    const { gate, calls } = makeGate({
      mode: 'auto',
      journal,
      callTool: async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: 'applied-ok' }] }
      },
    })
    const error = await gate.handle(autoProperties(43)).then(
      () => null,
      (e) => e as Error,
    )
    expect(error?.message).toMatch(/APPLIED_WITH_RECOVERY_WARNING/)
    expect(error?.message).toMatch(/applied-ok/)
    expect(calls).toHaveLength(1)
    const entries = await journal.newestForThread('thread-test')
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('pending')
  })

  it('blocks conflicting work while an operation is unresolved', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    await journal.beginIntent({ tool: 'notion-update-page', args: {}, kind: 'content-update', scope: SCOPE })
    const out = await gate.handle(autoProperties(44)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/CONFLICT_UNRESOLVED/)
    expect(calls).toHaveLength(0)
  })

  it('reviewed operations unblock new work without rewriting history', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    const intent = await journal.beginIntent({ tool: 'notion-update-page', args: {}, kind: 'content-update', scope: SCOPE })
    expect(await journal.markReviewed(intent.id, 'inspected in Notion')).toBe(true)
    const out = await gate.handle(autoProperties(45)) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')
    expect(calls).toHaveLength(1)
    expect((await journal.getEntry(intent.id))?.status).toBe('pending')
  })

  it('retains the admission scope when the thread switches mid-flight', async () => {
    let release!: (v: { content: Array<{ type: string; text?: string }> }) => void
    const gate1 = new Promise<{ content: Array<{ type: string; text?: string }> }>((resolve) => { release = resolve })
    const { gate, journal, calls } = makeGate({
      mode: 'auto',
      callTool: async (name, args) => {
        calls.push({ name, args })
        return gate1
      },
    })
    const pending = gate.handle(autoProperties(46))
    while (calls.length < 1) await new Promise((r) => setTimeout(r, 0))
    journal.scopeThread('thread-other')
    release({ content: [{ type: 'text', text: 'ok' }] })
    await pending
    const entries = await journal.newestForThread('thread-test')
    expect(entries).toHaveLength(1)
    expect(entries[0].scope).toMatchObject({ threadId: 'thread-test', workspaceId: 'workspace-1' })
  })

  it('links undo intents and marks the original undone only when applied', async () => {
    const { gate, journal } = makeGate({ mode: 'auto' })
    const args = { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Simple\noriginal text' } }
    const original = await journal.record({
      tool: 'notion-update-page',
      args,
      kind: 'content-replace',
      scope: SCOPE,
      verification: 'verified',
      preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Simple\noriginal text', baselineComplete: true },
      inverse: { tool: 'notion-update-page', args },
    })
    await expect(requestRuntimeUndo(gate, original.id)).resolves.toBe(true)
    expect((await journal.getEntry(original.id))?.status).toBe('undone')
    const undoIntents = (await journal.newestForThread('thread-test')).filter((e) => e.undoOf === original.id)
    expect(undoIntents).toHaveLength(1)
    expect(undoIntents[0]).toMatchObject({ status: 'applied', kind: 'undo' })
  })

  it('does not mark an undo complete when the restored content is absent', async () => {
    const { gate, journal } = makeGate({
      markdown: () => '# New',
      callTool: async () => ({ content: [{ type: 'text', text: 'accepted' }] }),
    })
    const original = await journal.record({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# New' } },
      kind: 'content-replace',
      scope: SCOPE,
      verification: 'verified',
      preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Old', baselineComplete: true },
      inverse: {
        tool: 'notion-update-page',
        args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Old' }, __nox_expected_hash: await hashMarkdown('# New') },
      },
    })
    await expect(requestRuntimeUndo(gate, original.id)).rejects.toThrow(/verif|restor|match/i)
    expect((await journal.getEntry(original.id))?.status).toBe('applied')
  })

  it('keeps crashed undo reservations locked instead of clickable', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    const original = await journal.record({
      tool: 'notion-update-page',
      args: propertiesArgs(),
      kind: 'properties',
      verification: 'verified',
      inverse: { tool: 'notion-update-page', args: propertiesArgs() },
    })
    const reserved = await journal.beginUndoReservation(original.id, {
      tool: 'notion-update-page',
      args: propertiesArgs(),
      kind: 'undo',
      scope: SCOPE,
    })
    expect(reserved).not.toBeNull()
    await expect(requestRuntimeUndo(gate, original.id)).resolves.toBe(false)
    expect(calls).toHaveLength(0)
    expect((await journal.getEntry(original.id))?.reservedByUndoOpId).toBe(reserved!.undo.id)
  })

  it('refuses undo through disallowed capabilities without dispatching', async () => {
    const { gate, journal, calls } = makeGate({
      mode: 'auto',
      assertToolAllowed: (tool) => { throw new Error(`TOOL_UNAVAILABLE: "${tool}" is not available`) },
    })
    const args = { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Simple\noriginal text' } }
    const original = await journal.record({
      tool: 'notion-update-page',
      args,
      kind: 'content-replace',
      scope: SCOPE,
      verification: 'verified',
      preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Simple\noriginal text', baselineComplete: true },
      inverse: { tool: 'notion-update-page', args },
    })
    await expect(requestRuntimeUndo(gate, original.id)).rejects.toThrow(/TOOL_UNAVAILABLE/)
    expect(calls).toHaveLength(0)
    expect(await journal.newestForThread('thread-test')).toHaveLength(1)
  })

  it('cancelled undo releases the reservation and keeps the original undoable', async () => {
    const controller = new AbortController()
    const { journal } = hookJournal({ onAppend: (entry) => { if (entry.kind === 'undo') controller.abort() } })
    const { gate, calls } = makeGate({ mode: 'auto', journal })
    const args = { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Simple\noriginal text' } }
    const original = await journal.record({
      tool: 'notion-update-page',
      args,
      kind: 'content-replace',
      scope: SCOPE,
      verification: 'verified',
      preImage: { kind: 'content-replace', pageId: PAGE, markdown: '# Simple\noriginal text', baselineComplete: true },
      inverse: { tool: 'notion-update-page', args },
    })
    await expect(gate.handleUndo(original.inverse!.tool, original.inverse!.args, {
      journalId: original.id,
      signal: controller.signal,
    })).rejects.toThrow(/TURN_CANCELLED/)
    expect(calls).toHaveLength(0)
    expect((await journal.getEntry(original.id))?.reservedByUndoOpId).toBeUndefined()
    expect(await journal.undoable()).toHaveLength(1)
    const undoIntents = (await journal.newestForThread('thread-test')).filter((e) => e.undoOf === original.id)
    expect(undoIntents).toHaveLength(1)
    expect(undoIntents[0].status).toBe('failed')
  })

  it('blocks undo while an operation is unresolved', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    const original = await journal.record({
      tool: 'notion-update-page',
      args: propertiesArgs(),
      kind: 'properties',
      verification: 'verified',
      inverse: { tool: 'notion-update-page', args: propertiesArgs() },
    })
    await journal.beginIntent({ tool: 'notion-update-page', args: {}, kind: 'content-update', scope: SCOPE })
    await expect(requestRuntimeUndo(gate, original.id)).rejects.toThrow(/CONFLICT_UNRESOLVED/)
    expect(calls).toHaveLength(0)
  })

  it('reads back matching replacement content as evidence, not proof', async () => {
    const { gate, journal } = makeGate({ mode: 'auto', markdown: () => '# Exact' })
    const intent = await journal.beginIntent({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Exact' } },
      kind: 'content-replace',
      scope: SCOPE,
      targetPageId: PAGE,
    })
    await journal.settleIntent(intent.id, { status: 'unknown', outcomeDetail: 'lost reply' })
    const evidence = await gate.readbackForReview(intent.id)
    expect(evidence).toMatchObject({ supported: true, match: true, targetPageId: PAGE })
    expect(evidence.detail).toMatch(/does not prove/)
  })

  it('checks a documented replacement from another thread in the same workspace', async () => {
    const { gate, journal } = makeGate({ mode: 'auto', markdown: () => '# Exact' })
    const intent = await journal.beginIntent({
      tool: 'notion-update-page',
      args: { page_id: PAGE, command: 'replace_content', new_str: '# Exact' },
      kind: 'content-replace',
      scope: { ...SCOPE, threadId: 'another-thread' },
      targetPageId: PAGE,
    })
    await journal.settleIntent(intent.id, { status: 'unknown' })
    expect(await gate.readbackForReview(intent.id)).toMatchObject({ supported: true, match: true })
  })

  it('does not read back a record from another workspace', async () => {
    const { gate, journal } = makeGate({ mode: 'auto' })
    const intent = await journal.beginIntent({
      tool: 'notion-update-page', args: { page_id: PAGE, command: 'replace_content', new_str: '# Exact' },
      kind: 'content-replace', scope: { ...SCOPE, workspaceId: 'another-workspace' }, targetPageId: PAGE,
    })
    await journal.settleIntent(intent.id, { status: 'unknown' })
    await expect(gate.readbackForReview(intent.id)).rejects.toThrow(/NOT_UNDOABLE/)
  })

  it('reports readback mismatch and unsupported shapes honestly', async () => {
    const { gate, journal } = makeGate({ mode: 'auto' })
    const mismatch = await journal.beginIntent({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Exact' } },
      kind: 'content-replace',
      scope: SCOPE,
      targetPageId: PAGE,
    })
    await journal.settleIntent(mismatch.id, { status: 'unknown' })
    expect(await gate.readbackForReview(mismatch.id)).toMatchObject({ supported: true, match: false })
    const props = await journal.beginIntent({
      tool: 'notion-update-page', args: propertiesArgs(), kind: 'properties', scope: SCOPE, targetPageId: PAGE,
    })
    await journal.settleIntent(props.id, { status: 'unknown' })
    expect((await gate.readbackForReview(props.id)).supported).toBe(false)
    await expect(gate.readbackForReview('missing')).rejects.toThrow(/NOT_UNDOABLE/)
  })
})

describe('WriteGate effect validation (Epoch 05)', () => {
  it('rejects model-supplied internal fields before approval or transport', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'ask' })
    const out = await gate.handle({
      rid: 50,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} }, __nox_expected_hash: 'forged' },
      namespace: null,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/INVALID_ARGUMENTS/)
    expect(out.content[0].text).toMatch(/__nox_expected_hash/)
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('rejects unknown tool shapes as unsupported without a card or dispatch', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'ask' })
    const out = await gate.handle({
      rid: 51, tool: 'notion-frobnicate', args: { id: PAGE }, namespace: null,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/UNSUPPORTED_EFFECT/)
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('refuses the raw upload ticket route without a card, dispatch, or journal row', async () => {
    // Epoch 08: ticket creation is only ever an internal step of the
    // supported upload workflow — a model calling it directly (or guessing
    // its name while it is unadvertised) must fail closed.
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    for (const tool of ['notion-create-file-upload', 'nox-upload-local-file']) {
      const out = await gate.handle({
        rid: 51, tool, args: { attachment_id: 'a1' }, namespace: null,
      }) as { isError?: boolean; content: Array<{ text?: string }> }
      expect(out.isError).toBe(true)
      expect(out.content[0].text).toMatch(/UNSUPPORTED_EFFECT/)
    }
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('rejects targetless moves before approval', async () => {
    const { gate, calls } = makeGate({ mode: 'ask' })
    const out = await gate.handle({
      rid: 52, tool: 'notion-move-pages', args: {}, namespace: null,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/INVALID_ARGUMENTS/)
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
  })

  it('refuses oversize payloads without truncating and executing', async () => {
    const { gate, calls } = makeGate({ mode: 'auto' })
    const out = await gate.handle({
      rid: 53,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'x'.repeat(600 * 1024) } },
      namespace: null,
    }) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PAYLOAD_TOO_LARGE/)
    expect(calls).toHaveLength(0)
  })

  it('journals the canonical frozen args that were actually dispatched', async () => {
    const { gate, journal } = makeGate({ mode: 'auto' })
    await gate.handle({
      rid: 54,
      tool: 'notion-update-page',
      args: { command: { properties: { Done: true }, type: 'update_properties' }, data: { page_id: PAGE } },
      namespace: null,
    })
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0].args)).toEqual(['command', 'data'])
    expect(entries[0].targetPageId).toBe(normalizeId(PAGE) ?? PAGE)
  })

  it('strips internal undo hashes before undo bytes reach transport', async () => {
    let received: Record<string, unknown> | null = null
    const { gate } = makeGate({
      mode: 'auto',
      callTool: async (_name, args) => {
        received = args
        return { content: [] }
      },
    })
    await gate.handleUndo('notion-update-page', {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: {} },
      __nox_expected_hash: 'trusted-internal-hash',
    })
    expect(received).not.toHaveProperty('__nox_expected_hash')
    expect(received).toMatchObject({ data: { page_id: PAGE } })
  })

  it('dispatches the frozen consent payload even when the request object changes afterwards', async () => {
    const { gate, calls } = makeGate({ mode: 'ask' })
    const args: Record<string, unknown> = {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: { keep: 1 } },
    }
    const pending = gate.handle({ rid: 60, tool: 'notion-update-page', args, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    // Mutate the original request object while the card is still open.
    ;(args.command as Record<string, unknown>).properties = { swapped: 2 }
    args.extra = 'late-target'
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'approve')
    await pending
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: { keep: 1 } },
    })
  })
})

describe('WriteGate Auto grant and material plans (Epoch 06)', () => {
  it('auto without the grant requests ordinary consent instead of silent edits', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', grant: { allowed: false, pages: [] } })
    const pending = gate.handle(autoProperties(70))
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })

  it('granted small edits on listed pages skip redundant cards', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', grant: { allowed: true, pages: [PAGE] } })
    const out = (await gate.handle(autoProperties(71))) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')
    expect(calls).toHaveLength(1)
    expect(gate.approvals.pendingCount).toBe(0)
    expect((await gate.journal.newestForThread('thread-test'))[0]?.verification).toBe('unverified')
    expect(out.content.map((part) => part.text).join(' ')).toMatch(/readback.*not verified/i)
  })

  it('grant stays silent only inside its listed pages', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', grant: { allowed: true, pages: ['other-page'] } })
    const pending = gate.handle(autoProperties(72))
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })

  it('grant never covers replacements, moves, or untrusted content', async () => {
    const granted: { mode: Mode; grant: { allowed: boolean; pages: string[] } } = { mode: 'auto', grant: { allowed: true, pages: [PAGE] } }
    for (const req of [
      { rid: 73, tool: 'notion-update-page', args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'x' } }, namespace: null },
      { rid: 74, tool: 'notion-move-pages', args: { page_ids: [PAGE] }, namespace: null },
    ]) {
      const { gate } = makeGate(granted)
      // Replacement needs an observed baseline before its card; moves do not.
      if (req.rid === 73) await rememberComplete(gate, '# Simple\noriginal text')
      const pending = gate.handle(req)
      await new Promise((r) => setTimeout(r, 10))
      expect(gate.approvals.pendingCount).toBe(1)
      gate.approvals.answer(gate.approvals.pendingIds[0], 'reject')
      await pending
    }
    const { gate: untrustedGate } = makeGate(granted)
    const pending = untrustedGate.handle({ ...autoProperties(75), provenance: 'untrusted-context' })
    await new Promise((r) => setTimeout(r, 10))
    expect(untrustedGate.approvals.pendingCount).toBe(1)
    untrustedGate.approvals.rejectAllPending()
    await pending
  })

  it('refuses the sixth unplanned effect with a plan-required error', async () => {
    const { gate, calls } = makeGate({ mode: 'auto', grant: { allowed: true, pages: [PAGE] } })
    for (let rid = 80; rid < 85; rid++) {
      await gate.handle(autoProperties(rid))
    }
    expect(calls).toHaveLength(5)
    const out = (await gate.handle(autoProperties(85))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PLAN_REQUIRED/)
    expect(calls).toHaveLength(5)
  })

  it('reads, search, and recent-page listing bypass plan and action consent', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto', grant: { allowed: false, pages: [] } })
    const out = (await gate.handle({ rid: 86, tool: 'notion-search', args: { query: 'x' }, namespace: null })) as {
      content: Array<{ text: string }>
    }
    expect(out.content[0].text).toContain('ran notion-search')
    const recent = (await gate.handle({ rid: 87, tool: 'notion-list-recent-pages', args: {}, namespace: null })) as {
      content: Array<{ text: string }>
    }
    expect(recent.content[0].text).toContain('ran notion-list-recent-pages')
    expect(calls).toHaveLength(2)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('routes a single cosmetic view rename through ordinary approval', async () => {
    let planChecks = 0
    const { gate, calls } = makeGate({
      mode: 'ask',
      authorizeStructuralChange: () => {
        planChecks++
        return { allowed: true }
      },
    })
    const pending = gate.handle({ rid: 87, tool: 'notion-update-view', args: { view_id: 'view-1', name: 'History' }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(planChecks).toBe(0)
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })

  it('routes broader view changes through plan authorization', async () => {
    let planChecks = 0
    const { gate, calls } = makeGate({
      mode: 'ask',
      authorizeStructuralChange: () => {
        planChecks++
        return { allowed: true }
      },
    })
    const pending = gate.handle({
      rid: 88,
      tool: 'notion-update-view',
      args: { view_id: 'view-1', name: 'History', sorts: [{ property: 'Name' }] },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(planChecks).toBe(1)
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })

  it('routes a single-page move through ordinary approval', async () => {
    let planChecks = 0
    const { gate, calls } = makeGate({
      mode: 'ask',
      authorizeStructuralChange: () => {
        planChecks++
        return { allowed: true }
      },
    })
    const pending = gate.handle({ rid: 89, tool: 'notion-move-pages', args: { page_ids: [PAGE] }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(planChecks).toBe(0)
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })

  it('routes broad moves through plan authorization', async () => {
    let planChecks = 0
    const { gate, calls } = makeGate({
      mode: 'ask',
      authorizeStructuralChange: () => {
        planChecks++
        return { allowed: true }
      },
    })
    const pending = gate.handle({ rid: 90, tool: 'notion-move-pages', args: { page_ids: [PAGE, 'other-page'] }, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(planChecks).toBe(1)
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await pending
    expect(calls).toHaveLength(1)
  })
})

describe('MutationJournal undo ordering', () => {
  it('lists newest first and separates undoable from not-undoable', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 't1', args: {}, kind: 'move', verification: 'verified', inverse: { tool: 'notion-move-pages', args: {} } })
    await journal.record({ tool: 't2', args: {}, kind: 'create-page', notUndoableReason: 'no delete tool' })
    await journal.record({ tool: 't3', args: {}, kind: 'move', verification: 'verified', inverse: { tool: 'notion-move-pages', args: {} } })

    const newestFirst = await journal.newestFirst()
    expect(newestFirst.map((e) => e.tool)).toEqual(['t3', 't2', 't1'])
    expect((await journal.undoable()).map((e) => e.tool)).toEqual(['t3', 't1'])
  })

  it('keeps the journal entry when undo fails', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 'write', args: {}, kind: 'content-update', verification: 'verified', inverse: { tool: 'undo', args: {} } })
    await expect(undoNewest(journal, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect((await journal.newestFirst())[0].status).toBe('applied')
    expect(await journal.undoable()).toHaveLength(1)
  })

  it('marks a successful undo without deleting its audit record', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 'write', args: {}, kind: 'content-update', verification: 'verified', inverse: { tool: 'undo', args: {} } })
    await expect(undoNewest(journal, async () => undefined)).resolves.toBe(true)
    expect((await journal.newestFirst())[0].status).toBe('undone')
    expect(await journal.undoable()).toHaveLength(0)
  })

  it('undoes a selected journal entry instead of only the newest', async () => {
    const journal = new MutationJournal()
    const older = await journal.record({ tool: 'first', args: {}, kind: 'move', verification: 'verified', inverse: { tool: 'undo-first', args: {} } })
    await journal.record({ tool: 'second', args: {}, kind: 'move', verification: 'verified', inverse: { tool: 'undo-second', args: {} } })
    const calls: string[] = []
    await expect(undoEntry(journal, older.id, async (tool) => { calls.push(tool) })).resolves.toBe(true)
    expect(calls).toEqual(['undo-first'])
  })

  it('executes at most one undo while another undo is in flight', async () => {
    const journal = new MutationJournal()
    const entry = await journal.record({ tool: 'write', args: {}, kind: 'content-update', verification: 'verified', inverse: { tool: 'undo', args: {} } })
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = undoEntry(journal, entry.id, async () => { calls++; await blocked })
    const second = undoEntry(journal, entry.id, async () => { calls++ })
    release()
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(calls).toBe(1)
  })

  it('does not advertise unsupported inverse plans', () => {
    expect(buildInverse({ kind: 'move' }).kind).toBe('not-undoable')
    expect(buildInverse({ kind: 'properties' }).kind).toBe('not-undoable')
    expect(buildInverse({ kind: 'view' }).kind).toBe('not-undoable')
  })

  it('requires a verified complete baseline for content inverses', () => {
    // Regex absence alone (no rich markers) is not a positive baseline.
    expect(buildInverse({ kind: 'content-replace', markdown: 'plain text', pageId: PAGE })).toMatchObject({
      kind: 'not-undoable',
    })
    expect(
      buildInverse({ kind: 'content-replace', markdown: 'plain text', pageId: PAGE }).reason,
    ).toMatch(/baseline/)
    expect(
      buildInverse({ kind: 'content-update', markdown: 'plain text', pageId: PAGE, baselineComplete: true }),
    ).toMatchObject({ kind: 'execute-tool', tool: 'notion-update-page' })
    // A complete baseline on a rich page still refuses the whole-page inverse.
    expect(
      buildInverse({ kind: 'content-replace', markdown: 'synced_block here', pageId: PAGE, baselineComplete: true }).kind,
    ).toBe('not-undoable')
  })

  it('exposes GuardViolation as a typed error', () => {
    expect(new GuardViolation('changed')).toBeInstanceOf(Error)
  })
})

describe('WriteGate read baselines (Epoch 07)', () => {
  const PLAIN = 'alpha\nbeta\ngamma'
  const PARTIAL_TEXT = JSON.stringify({
    id: PAGE,
    title: 'Plain A',
    content: 'alpha\nbeta',
    truncated: true,
    unknown_block_ids: ['22222222-2222-4222-8222-222222222222'],
  })
  const IDENTITY_TEXT = JSON.stringify({
    title: 'Acme',
    self: { workspace: { id: 'w1', name: 'Acme' }, current_tool_access: { search: { status: 'available' } } },
  })

  function replaceReq(rid: number, content = '# Agent edit') {
    return {
      rid,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content } },
      namespace: null,
    } as const
  }

  it('refuses replacement without an observed baseline', async () => {
    const { gate, journal, calls } = makeGate({ mode: 'auto' })
    const out = (await gate.handle(replaceReq(1))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/BASELINE_REQUIRED/)
    expect(out.content[0].text).toMatch(/fetch it with notion-fetch/)
    expect(calls).toHaveLength(0)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(await journal.newestFirst()).toHaveLength(0)
  })

  it('a tool-error read establishes no baseline and no evidence', async () => {
    let dispatches = 0
    const { gate, calls } = makeGate({
      mode: 'auto',
      callTool: async (name) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: 'boom' }], isError: true }
        dispatches++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    const read = (await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })) as {
      isError?: boolean
    }
    expect(read.isError).toBe(true)
    const out = (await gate.handle(replaceReq(2))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/BASELINE_REQUIRED/)
    expect(dispatches).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('rejects unrecognized fetch wrappers instead of snapshotting them', async () => {
    const { gate, calls } = makeGate({ mode: 'auto' })
    // A wrapper the model never saw as page content establishes nothing.
    await gate.rememberPageRead(PAGE, IDENTITY_TEXT)
    const missing = (await gate.handle(replaceReq(3))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toMatch(/BASELINE_REQUIRED/)
    // A valid baseline followed by a degraded guard read refuses precisely.
    const degraded = makeGate({ mode: 'ask', markdown: () => IDENTITY_TEXT })
    await rememberComplete(degraded.gate, PLAIN)
    const approved = degraded.gate.handle(replaceReq(4))
    await new Promise((r) => setTimeout(r, 10))
    expect(degraded.gate.approvals.pendingCount).toBe(1)
    degraded.gate.approvals.answer(degraded.gate.approvals.pendingIds[0], 'approve')
    const out = (await approved) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/WRAPPER_MISMATCH/)
    expect(degraded.calls).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('keeps partial reads for analysis but refuses them as replacement', async () => {
    let dispatches = 0
    const { gate } = makeGate({
      mode: 'auto',
      callTool: async (name) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: PARTIAL_TEXT }] }
        dispatches++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    const read = (await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })) as {
      isError?: boolean
      content: Array<{ text?: string }>
    }
    // Analysis still sees the partial content …
    expect(read.isError).toBeFalsy()
    expect(read.content[0].text).toContain('alpha')
    // … but replacement demands the omitted scope first.
    const out = (await gate.handle(replaceReq(2))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(out.content[0].text).toMatch(/omitted block/)
    expect(dispatches).toBe(0)
  })

  it('requires a re-fetch after resume: guard reads alone never bless a stale proposal', async () => {
    const shared = new MutationJournal()
    const first = makeGate({ mode: 'auto', journal: shared })
    await first.gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    // A restarted panel keeps the journal but loses baselines: two matching
    // guard reads must not authorize the old proposal.
    const second = makeGate({ mode: 'auto', journal: shared })
    const out = (await second.gate.handle(replaceReq(2))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/BASELINE_REQUIRED/)
    expect(second.calls).toHaveLength(0)
  })

  it('retires baselines on scope change', async () => {
    const { gate, journal } = makeGate({ mode: 'auto' })
    await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    journal.scopeThread('thread-other')
    const out = (await gate.handle(replaceReq(2))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/BASELINE_REQUIRED/)
  })

  it('refuses when the page changes between guard and dispatch', async () => {
    let reads = 0
    let dispatches = 0
    const { gate, journal } = makeGate({
      mode: 'auto',
      markdown: () => (reads++ < 2 ? '# Stable' : '# Human edit'),
      callTool: async () => {
        dispatches++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    await rememberComplete(gate, '# Stable')
    const pending = gate.handle({
      rid: 1,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_content', content: 'new' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PAGE_CHANGED_SINCE_READ/)
    expect(out.content[0].text).toMatch(/older state/)
    expect(dispatches).toBe(0)
    const entries = await journal.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('failed')
  })

  it('serializes two concurrent same-page writes to one success', async () => {
    let current = '# v0'
    let dispatches = 0
    const { gate } = makeGate({
      mode: 'auto',
      markdown: () => current,
      callTool: async (name, args) => {
        dispatches++
        const command = args.command as { type?: string; content?: string } | undefined
        if (name === 'notion-update-page' && typeof command?.content === 'string') current = command.content
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    await rememberComplete(gate, '# v0')
    const update = (rid: number, content: string) => ({
      rid,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_content', content } },
      namespace: null,
    }) as const
    const firstPending = gate.handle(update(1, '# v1'))
    const secondPending = gate.handle(update(2, '# v2'))
    for (let i = 0; i < 200 && gate.approvals.pendingCount < 2; i++) await new Promise((r) => setTimeout(r, 0))
    for (const id of gate.approvals.pendingIds) gate.approvals.answer(id, 'approve')
    const [first, second] = await Promise.all([firstPending, secondPending])
    expect((first as { content: Array<{ text?: string }> }).content[0].text).toContain('written')
    expect((second as { isError?: boolean; content: Array<{ text?: string }> }).isError).toBe(true)
    expect((second as { content: Array<{ text?: string }> }).content[0].text).toMatch(/PAGE_CHANGED_SINCE_READ/)
    expect(dispatches).toBe(1)
    expect(current).toBe('# v1')
  })

  it('succeeds through slow but stable guard reads', async () => {
    const { gate, journal } = makeGate({
      mode: 'auto',
      markdown: async () => {
        await new Promise((r) => setTimeout(r, 15))
        return '# Stable page'
      },
    })
    await rememberComplete(gate, '# Stable page')
    const pending = gate.handle({
      rid: 1,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_content', content: 'new' } },
      namespace: null,
    })
    for (let i = 0; i < 200 && gate.approvals.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')
    expect((await journal.newestFirst())[0].status).toBe('applied')
  })

  it('runs a supported plain edit end to end and undoes it exactly once', async () => {
    let current = PLAIN
    const dispatches: string[] = []
    const { gate, journal } = makeGate({
      mode: 'ask',
      markdown: () => current,
      callTool: async (name, args) => {
        dispatches.push(name)
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: completePage(current) }] }
        const command = args.command as { type?: string; content?: string } | undefined
        if (name === 'notion-update-page' && command?.type === 'replace_content' && typeof command.content === 'string') {
          current = command.content
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    // A properly fetched small edit succeeds …
    await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    const pending = gate.handle(replaceReq(2, '# Nox edit'))
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toBe('ok')
    expect(current).toBe('# Nox edit')
    const entry = (await journal.undoable())[0]
    expect(entry.verification).toBe('verified')
    expect(entry.inverse?.tool).toBe('notion-update-page')
    // … a safe supported undo works once …
    await expect(requestRuntimeUndo(gate, entry.id)).resolves.toBe(true)
    expect(current).toBe(PLAIN)
    // … and never twice.
    await expect(requestRuntimeUndo(gate, entry.id)).resolves.toBe(false)
    expect(dispatches.filter((name) => name === 'notion-update-page')).toHaveLength(2)
  })

  it('leaves rich replacements visibly not-undoable with their target', async () => {
    const { gate, journal } = makeGate({ mode: 'ask', markdown: () => '# Page\nsynced_block here' })
    await rememberComplete(gate, '# Page\nsynced_block here')
    const pending = gate.handle(replaceReq(5, 'x'))
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'approve')
    await pending
    const entries = await journal.newestFirst()
    expect(entries[0].inverse).toBeUndefined()
    expect(entries[0].notUndoableReason).toMatch(/round-trip/i)
    expect(entries[0].targetPageId).toBe(normalizeId(PAGE) ?? PAGE)
    expect(await journal.undoable()).toHaveLength(0)
  })

  it('reports unverifiable (never mismatched) readback for partial current state', async () => {
    const { gate, journal } = makeGate({ mode: 'auto', markdown: () => PARTIAL_TEXT })
    const intent = await journal.beginIntent({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Exact' } },
      kind: 'content-replace',
      scope: {
        threadId: 'thread-test',
        turnId: 'turn-1',
        workspaceId: 'workspace-1',
        connectionGeneration: 'test-conn-gen',
        ownerGeneration: 'test-owner-gen',
      },
      targetPageId: PAGE,
    })
    await journal.settleIntent(intent.id, { status: 'unknown', outcomeDetail: 'lost reply' })
    const evidence = await gate.readbackForReview(intent.id)
    expect(evidence.supported).toBe(false)
    expect(evidence.targetPageId).toBe(PAGE)
    expect(evidence.detail).toMatch(/inspect it in Notion/)
  })
})


