import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { ToolExecutor } from '../../src/lib/agent/executor'
import { AgentLoop } from '../../src/lib/agent/loop'
import { buildContextPreamble } from '../../src/lib/agent/context'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'

const PAGE = 'b'.repeat(32)

function largePageText(): string {
  // 30,000-char page with an omitted tail the model never sees without continuation.
  return `${'a'.repeat(29_990)}UNSEEN TAIL`
}

function makeGateWithProvider(opts: {
  providerText?: string
  dispatches?: Array<{ name: string; args: Record<string, unknown> }>
} = {}) {
  const dispatches = opts.dispatches ?? []
  const providerText = opts.providerText ?? largePageText()
  const journal = new MutationJournal()
  journal.setThread('thread-f2')
  const access = createTurnAccessState()
  access.begin('ask', [PAGE], [], { allowed: false, pages: [] })
  const gate = new WriteGate({
    callTool: async (name, args) => {
      if (name === 'notion-fetch') {
        return { content: [{ type: 'text', text: providerText }] }
      }
      dispatches.push({ name, args })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    fetchPageMarkdown: async () => providerText,
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
    ownership: {
      isOwner: () => true,
      getOwnerGeneration: () => 'owner-f2',
      getConnectionGeneration: () => 'conn-f2',
    },
    getWorkspaceId: () => 'workspace-f2',
  })
  return { gate, journal, dispatches, providerText }
}

function makeExecutorForGate(gate: WriteGate) {
  const executor = new ToolExecutor({
    callTool: async (name, args, signal, provenance) => {
      const result = (await gate.handle({
        rid: 0,
        tool: name,
        args,
        namespace: null,
        signal,
        provenance,
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      if (result?.isError) throw new Error(result.content?.map((c) => c.text).join('\n'))
      return { content: result.content ?? [] }
    },
    assertToolAllowed: () => undefined,
    onModelTruncation: (pageId, delivered, total) => gate.noteModelTruncation(pageId, delivered, total),
    onModelDelivery: (pageId, offset, end, total) => gate.noteModelDelivery(pageId, offset, end, total),
  })
  executor.beginTurn()
  gate.beginTurn()
  return executor
}

function mentionHarness(pageIds: string[], texts: Map<string, string>) {
  const dispatches: Array<{ name: string; args: Record<string, unknown> }> = []
  const journal = new MutationJournal()
  journal.setThread('thread-f2')
  const access = createTurnAccessState()
  access.begin('ask', pageIds, [], { allowed: false, pages: [] })
  const gate = new WriteGate({
    callTool: async (name, args) => {
      dispatches.push({ name, args })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    fetchPageMarkdown: async (pageId) => texts.get(pageId) ?? '',
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
    ownership: {
      isOwner: () => true,
      getOwnerGeneration: () => 'owner-f2',
      getConnectionGeneration: () => 'conn-f2',
    },
    getWorkspaceId: () => 'workspace-f2',
  })
  const executor = new ToolExecutor({
    callTool: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
    assertToolAllowed: () => undefined,
    onModelTruncation: (pageId, delivered, total) => gate.noteModelTruncation(pageId, delivered, total),
    onModelDelivery: (pageId, offset, end, total) => gate.noteModelDelivery(pageId, offset, end, total),
  })
  executor.beginTurn()
  gate.beginTurn()
  return { gate, journal, dispatches, executor }
}

describe('Epoch F2.1 — R2 truncated dynamic fetch must not authorize replacement', () => {
  it('a 30,000-char page with an omitted tail refuses replacement before approval with zero transport', async () => {
    const { gate, dispatches, providerText } = makeGateWithProvider()
    expect(providerText.length).toBeGreaterThan(24_000)
    expect(providerText.endsWith('UNSEEN TAIL')).toBe(true)
    const executor = makeExecutorForGate(gate)

    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    expect(fetched.success).toBe(true)
    // Model sees a continuation handle but not the tail.
    expect(fetched.contentItems[0].text).toMatch(/<continuation handle="/)
    expect(fetched.contentItems[0].text).not.toContain('UNSEEN TAIL')

    // Without consuming the continuation, request whole-page replacement.
    const pending = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short replacement' } },
      namespace: null,
    })
    // Give the gate a chance to request approval; it must not.
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })
})

describe('Epoch F2.2 — R2 mention truncation must not authorize replacement', () => {
  it('an 8,000-char mention truncation refuses replacement before approval', async () => {
    const big = `${'m'.repeat(8990)}TAIL`
    expect(big.length).toBeGreaterThan(8000)
    const { gate, dispatches, executor } = mentionHarness([PAGE], new Map([[PAGE, big]]))
    await gate.rememberNormalizedRead(PAGE, { content: [{ type: 'text', text: big }] })
    const preamble = buildContextPreamble(
      { mentions: [{ pageId: PAGE, title: 'Big', markdown: big }] },
      (text, budget, pageId) => executor.excerpt(text, budget, 'notion-fetch', pageId),
    )
    expect(preamble).toMatch(/status="partial"/)
    expect(preamble).not.toContain('TAIL')

    const pending = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })

  it('combined mention budget exhaustion refuses the truncated tail page only', async () => {
    const ids = [0, 1, 2, 3].map((i) => `${i.toString().repeat(8)}-${'a'.repeat(24)}`.slice(0, 32))
    const texts = new Map<string, string>()
    for (const id of ids) texts.set(id, 'x'.repeat(7000))
    const { gate, dispatches, executor } = mentionHarness(ids, texts)
    for (const id of ids) {
      await gate.rememberNormalizedRead(id, { content: [{ type: 'text', text: texts.get(id)! }] })
    }
    const preamble = buildContextPreamble(
      { mentions: ids.map((id) => ({ pageId: id, title: `P${id.slice(0, 4)}`, markdown: texts.get(id)! })) },
      (text, budget, pageId) => executor.excerpt(text, budget, 'notion-fetch', pageId),
    )
    // First pages fit; the tail page is cut by the 24k combined budget.
    expect(preamble.match(/status="partial"/g)?.length).toBeGreaterThanOrEqual(1)

    const tail = ids[3]
    const pendingTail = gate.handle({
      rid: 3,
      tool: 'notion-update-page',
      args: { data: { page_id: tail }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const outTail = (await pendingTail) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(outTail.isError).toBe(true)
    expect(outTail.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })
})

describe('Epoch F2.3 — R2 continuation delivery and provider completeness', () => {
  function continuationHarness(providerText: string) {
    const dispatches: Array<{ name: string; args: Record<string, unknown> }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f2')
    const access = createTurnAccessState()
    access.begin('ask', [PAGE], [], { allowed: false, pages: [] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: providerText }] }
        dispatches.push({ name, args })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => providerText,
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: {
        isOwner: () => true,
        getOwnerGeneration: () => 'owner-f2',
        getConnectionGeneration: () => 'conn-f2',
      },
      getWorkspaceId: () => 'workspace-f2',
    })
    const executor = new ToolExecutor({
      callTool: async (name, args, signal, provenance) => {
        const result = (await gate.handle({ rid: 0, tool: name, args, namespace: null, signal, provenance })) as {
          content?: Array<{ type: string; text?: string }>
          isError?: boolean
        }
        if (result?.isError) throw new Error(result.content?.map((c) => c.text).join('\n'))
        return { content: result.content ?? [] }
      },
      assertToolAllowed: () => undefined,
      onModelTruncation: (pageId, delivered, total) => gate.noteModelTruncation(pageId, delivered, total),
      onModelDelivery: (pageId, offset, end, total) => gate.noteModelDelivery(pageId, offset, end, total),
    })
    executor.beginTurn()
    gate.beginTurn()
    return { gate, journal, dispatches, executor, providerText }
  }

  function extractHandle(modelText: string): string {
    const m = /handle="([^"]+)"/.exec(modelText)
    if (!m) throw new Error('expected a continuation handle in model text')
    return m[1]
  }

  it('possession of a handle alone never completes the baseline', async () => {
    const { gate, dispatches, executor } = continuationHarness(largePageText())
    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    expect(extractHandle(fetched.contentItems[0].text)).toBeTruthy()
    // No continuation read yet: still partial before any card.
    const pending = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })

  it('fully delivered continuation restores a complete baseline and dispatches once after approval', async () => {
    const { gate, journal, dispatches, executor } = continuationHarness(largePageText())
    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    const handle = extractHandle(fetched.contentItems[0].text)
    const continued = await executor.execute({ rid: 2, tool: 'nox-read-continuation', args: { handle, offset: 24_000 }, namespace: null })
    expect(continued.success).toBe(true)
    expect(continued.contentItems[0].text).toContain('UNSEEN TAIL')
    expect(continued.contentItems[0].text).toContain('END_OF_RESULT')

    const pending = gate.handle({
      rid: 3,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toContain('ok')
    expect(dispatches).toHaveLength(1)
    expect((await journal.newestFirst())[0].status).toBe('applied')
  })

  it('expired handles leave the baseline partial with zero transport', async () => {
    const { gate, dispatches, executor } = continuationHarness(largePageText())
    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    const handle = extractHandle(fetched.contentItems[0].text)
    // Handles are turn-scoped: a new turn expires them.
    executor.beginTurn()
    const expired = await executor.execute({ rid: 2, tool: 'nox-read-continuation', args: { handle, offset: 24_000 }, namespace: null })
    expect(expired.success).toBe(false)
    expect(expired.contentItems[0].text).toMatch(/CONTINUATION_UNAVAILABLE/)

    const pending = gate.handle({
      rid: 3,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const out = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })

  it('exhausted turn memory offers no handle and refuses replacement', async () => {
    const { gate, dispatches, executor } = continuationHarness('y'.repeat(30_000))
    // Fill the 1M ephemeral budget so the next excerpt cannot store a handle.
    for (let i = 0; i < 34; i++) {
      executor.excerpt('z'.repeat(30_000), 24_000, 'notion-fetch', `filler-${i}`)
    }
    const out = executor.excerpt('w'.repeat(30_000), 24_000, 'notion-fetch', PAGE)
    expect(out).toMatch(/CONTINUATION_UNAVAILABLE/)
    expect(out).not.toMatch(/handle="/)
    await gate.rememberNormalizedRead(PAGE, { content: [{ type: 'text', text: 'w'.repeat(30_000) }] })
    gate.noteModelTruncation(PAGE, 24_000, 30_000)

    const pending = gate.handle({
      rid: 4,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(0)
    const refused = (await pending) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(dispatches).toHaveLength(0)
  })

  it('failed and partial provider fetches establish no complete baseline', async () => {
    const freshDispatches: Array<{ name: string; args: Record<string, unknown> }> = []
    const freshJournal = new MutationJournal()
    freshJournal.setThread('thread-f2')
    const freshAccess = createTurnAccessState()
    freshAccess.begin('ask', [PAGE], [], { allowed: false, pages: [] })
    const fresh = new WriteGate({
      callTool: async (name) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: 'boom' }], isError: true }
        freshDispatches.push({ name, args: {} })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => 'boom',
      getMode: () => freshAccess.mode(),
      getContextSet: () => freshAccess.contextPages(),
      journal: freshJournal,
      ownership: { isOwner: () => true, getOwnerGeneration: () => 'o', getConnectionGeneration: () => 'c' },
      getWorkspaceId: () => 'w',
    })
    await fresh.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    const outFailed = (await fresh.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(outFailed.isError).toBe(true)
    expect(outFailed.content[0].text).toMatch(/BASELINE_REQUIRED/)
    expect(freshDispatches).toHaveLength(0)

    // Partial provider read: remembered as partial, refuses as partial.
    const partialText = JSON.stringify({ content: 'alpha\nbeta', truncated: true, unknown_block_ids: ['22222222-2222-4222-8222-222222222222'] })
    const partialHarness = continuationHarness(partialText)
    await partialHarness.gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    const outPartial = (await partialHarness.gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Short' } },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(outPartial.isError).toBe(true)
    expect(outPartial.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(partialHarness.dispatches).toHaveLength(0)
  })
})

describe('Epoch F2.4 — R3 retained untrusted exposure across turns', () => {
  interface RecordedCall { tool: string; provenance?: string }
  function fakeCodex(script: (tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
    let onTool: ((req: { tool: string; args: Record<string, unknown>; rid: number; namespace: null }) => Promise<unknown>) | null = null
    const client = {
      onToolCall: null as unknown,
      emit: () => undefined,
      researchLimitation: null,
      async startThread() { return 'codex-f2' },
      async resumeThread(id: string) { return id },
      async initialize() { return undefined },
      async interrupt() { return undefined },
      async runTurn() {
        const tool = async (name: string, args: Record<string, unknown> = {}) => onTool!({ tool: name, args, rid: 1, namespace: null })
        await script(tool)
        return { interrupted: false, finalText: 'done' }
      },
    }
    Object.defineProperty(client, 'onToolCall', {
      get: () => onTool,
      set: (v) => { onTool = v },
      configurable: true,
    })
    return client
  }

  function loopWithRecorder(script: (tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
    const calls: RecordedCall[] = []
    const executor = new ToolExecutor({
      callTool: async (name, _args, _signal, provenance) => {
        calls.push({ tool: name, provenance })
        return { content: [{ type: 'text', text: 'synthetic workspace text' }] }
      },
      assertToolAllowed: () => undefined,
    })
    const codex = fakeCodex(script)
    const loop = new AgentLoop({
      bridge: { disconnect: () => undefined } as unknown as never,
      codex: codex as unknown as never,
      executor,
      getDynamicTools: async () => [],
      developerInstructions: 'Nox',
    })
    return { loop, calls, codex }
  }

  it('turn-two mutation keeps untrusted provenance after a turn-one workspace read', async () => {
    let script: (tool: (name: string) => Promise<unknown>) => Promise<void> = async (tool) => {
      await tool('notion-fetch')
    }
    const { loop, calls } = loopWithRecorder((tool) => script(tool))
    await loop.sendUserMessage('read it', { mentions: [{ pageId: PAGE, title: 'P', markdown: '# hello' }] })
    expect(calls).toHaveLength(1)
    expect(calls[0].provenance).toBe('untrusted-context')
    expect(loop.hasUntrustedConversation()).toBe(true)

    // Turn two has no new mentions but the same Codex conversation resumes:
    // the same loop instance must still forward untrusted-context.
    script = async (tool) => {
      await tool('notion-update-page')
    }
    await loop.sendUserMessage('edit it')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ tool: 'notion-update-page', provenance: 'untrusted-context' })
  })

  it('a granted in-context Auto edit on turn two still requires confirmation after exposure', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-f2')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const dispatches: Array<{ name: string }> = []
    const gate = new WriteGate({
      callTool: async (name) => {
        dispatches.push({ name })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# Simple',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: { isOwner: () => true, getOwnerGeneration: () => 'o', getConnectionGeneration: () => 'c' },
      getWorkspaceId: () => 'w',
    })
    // Turn-one exposure is real workspace content in the same conversation.
    // Turn two reuses the grant but forwards retained untrusted provenance.
    const out = gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      namespace: null,
      provenance: 'untrusted-context',
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    await out
    expect(dispatches).toHaveLength(1)
  })

  it('restore of an exposed conversation stays untrusted; fresh chats stay clean', async () => {
    const { loop } = loopWithRecorder(async (tool) => { await tool('notion-fetch') })
    await loop.sendUserMessage('read', { mentions: [{ pageId: PAGE, title: 'P', markdown: '# hi' }] })
    expect(loop.hasUntrustedConversation()).toBe(true)
    const threadId = loop.currentThreadId ?? 'codex-f2'

    // Simulated reload: a new AgentLoop restores the same Codex thread.
    const { loop: reloaded, calls: reloadedCalls } = loopWithRecorder(async (tool) => { await tool('notion-update-page') })
    reloaded.restoreThread(threadId)
    expect(reloaded.hasUntrustedConversation()).toBe(true)
    await reloaded.sendUserMessage('edit after reload')
    expect(reloadedCalls[0].provenance).toBe('untrusted-context')

    // Fresh chats reset: ordinary Auto use is preserved.
    const { loop: fresh, calls: freshCalls } = loopWithRecorder(async (tool) => { await tool('notion-search') })
    fresh.newThread()
    await fresh.sendUserMessage('clean question')
    expect(freshCalls[0].provenance).toBe('user-only')
    expect(fresh.hasUntrustedConversation()).toBe(true) // the search itself taints afterwards
    const { loop: clean } = loopWithRecorder(async () => undefined)
    clean.newThread()
    expect(clean.hasUntrustedConversation()).toBe(false)
  })
})
