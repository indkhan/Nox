import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal, memoryJournalStore } from '../../src/lib/writes/journal'
import { requestRuntimeUndo } from '../../src/lib/writes/undo'
import { ToolExecutor } from '../../src/lib/agent/executor'
import { AgentLoop } from '../../src/lib/agent/loop'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'
import { TokenStore } from '../../src/lib/oauth/tokens'
import { memoryStore } from '../../src/lib/storage'
import { McpClient, MCP_RESPONSE_BUDGET_BYTES } from '../../src/lib/mcp/client'
import { resetRequestIds } from '../../src/lib/mcp/jsonrpc'
import type { TokenResponse } from '../../src/lib/oauth/discovery'

// Epoch F5 — integrated and live acceptance (deterministic part).
// Re-proves R1–R7 together over production assembly (real WriteGate +
// MutationJournal + ToolExecutor + AgentLoop + TokenStore + McpClient).
// Transports are faked at the boundary; no production gate logic is mocked.
// Live C01–C17 remain BLOCKED without an authorized scratch scope — this
// suite is the deterministic closure, never a live PASS claim.

const PAGE = 'e'.repeat(32)

function propertiesReq(rid: number) {
  return {
    rid,
    tool: 'notion-update-page',
    args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
    namespace: null,
  } as const
}

function replaceReq(rid: number, content = '# Agent edit') {
  return {
    rid,
    tool: 'notion-update-page',
    args: { data: { page_id: PAGE }, command: { type: 'replace_content', content } },
    namespace: null,
  } as const
}

function tokenResponse(over: Partial<TokenResponse> = {}): TokenResponse {
  return { access_token: 'at-f5', refresh_token: 'rt-f5', expires_in: 3600, ...over }
}

describe('Epoch F5 — R1 dispatch revalidation (integrated)', () => {
  it('revoked owner during intent persistence settles failed with zero transport', async () => {
    let owner = true
    const calls: Array<{ name: string }> = []
    const backing: Array<{ id: string }> = []
    void backing
    const journal = new MutationJournal()
    journal.setThread('thread-f5-r1')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name) => {
        calls.push({ name })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# Simple\noriginal text',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: {
        isOwner: () => owner,
        getOwnerGeneration: () => 'owner-f5',
        getConnectionGeneration: () => 'conn-f5',
      },
      getWorkspaceId: () => 'workspace-f5',
    })
    const origBegin = journal.beginIntent.bind(journal)
    journal.beginIntent = (async (input: Parameters<typeof origBegin>[0]) => {
      const entry = await origBegin(input)
      owner = false
      return entry
    }) as typeof origBegin
    const out = (await gate.handle(propertiesReq(1))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER|LEASE_EXPIRED/)
    expect(calls).toHaveLength(0)
    const rows = await journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })
})

describe('Epoch F5 — R4 queued work stops behind ambiguity (integrated)', () => {
  it('second mutation stops with exactly one transport until review', async () => {
    let release!: (v: { content: Array<{ type: string; text?: string }> }) => void
    let rejectRelease!: (e: unknown) => void
    const gate1 = new Promise<{ content: Array<{ type: string; text?: string }> }>((res, rej) => {
      release = res
      rejectRelease = rej
    })
    void release
    let first = true
    const calls: Array<{ name: string }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f5-r4')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name) => {
        calls.push({ name })
        if (first) {
          first = false
          return gate1
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# Simple\noriginal text',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: {
        isOwner: () => true,
        getOwnerGeneration: () => 'owner-f5',
        getConnectionGeneration: () => 'conn-f5',
      },
      getWorkspaceId: () => 'workspace-f5',
    })
    const p1 = gate.handle(propertiesReq(11))
    for (let i = 0; i < 500 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
    const p2 = gate.handle(propertiesReq(12))
    await new Promise((r) => setTimeout(r, 0))
    rejectRelease(new Error('connection reset after dispatch'))
    const [r1, r2] = await Promise.allSettled([p1, p2])
    expect(r1.status).toBe('rejected')
    expect(calls).toHaveLength(1)
    expect(r2.status).toBe('fulfilled')
    const v2 = (r2 as PromiseFulfilledResult<unknown>).value as { isError?: boolean; content: Array<{ text?: string }> }
    expect(v2.isError).toBe(true)
    expect(v2.content[0].text).toMatch(/CONFLICT_UNRESOLVED/)
    const rows = await journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('unknown')
  })
})

describe('Epoch F5 — R6 restored undo without a new turn (integrated)', () => {
  it('restored panel undoes one verified inverse via the runtime path', async () => {
    const store = memoryJournalStore()
    const seeder = new MutationJournal(store)
    seeder.setThread('persisted-f5')
    const args = { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } }
    const entry = await seeder.record({
      tool: 'notion-update-page',
      args,
      kind: 'properties',
      inverse: { tool: 'notion-update-page', args },
    })
    const journal = new MutationJournal(store)
    journal.scopeThread('persisted-f5')
    const calls: Array<{ name: string }> = []
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name) => {
        calls.push({ name })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# Simple\noriginal text',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: {
        isOwner: () => true,
        getOwnerGeneration: () => 'owner-f5',
        getConnectionGeneration: () => 'conn-f5',
      },
      getWorkspaceId: () => 'workspace-f5',
    })
    expect(journal.captureScope()).toMatchObject({ threadId: 'persisted-f5', turnId: null })
    const ok = await requestRuntimeUndo(gate, entry.id)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect((await journal.getEntry(entry.id))?.status).toBe('undone')
  })
})

describe('Epoch F5 — R2 model-visible completeness (integrated)', () => {
  function gateWithExecutor(providerText: string) {
    const dispatches: Array<{ name: string }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f5-r2')
    const access = createTurnAccessState()
    access.begin('ask', [PAGE], [], { allowed: false, pages: [] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: providerText }] }
        dispatches.push({ name })
        void args
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
        getOwnerGeneration: () => 'o-f5',
        getConnectionGeneration: () => 'c-f5',
      },
      getWorkspaceId: () => 'w-f5',
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
    return { gate, executor, dispatches }
  }

  it('truncated dynamic fetch refuses replacement before approval with zero dispatch', async () => {
    const providerText = `${'a'.repeat(29_990)}UNSEEN TAIL`
    const { executor, gate, dispatches } = gateWithExecutor(providerText)
    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    expect(fetched.success).toBe(true)
    const modelText = fetched.contentItems.map((c) => c.text).join('\n')
    expect(modelText).not.toContain('UNSEEN TAIL')
    expect(modelText).toMatch(/continuation/)
    const out = (await gate.handle(replaceReq(2))) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/PARTIAL_BASELINE/)
    expect(gate.approvals.pendingCount).toBe(0)
    expect(dispatches).toHaveLength(0)
  })

  it('fully delivered continuation restores completeness and reaches approval', async () => {
    const providerText = `${'a'.repeat(30_000)}TAIL`
    const { executor, gate, dispatches } = gateWithExecutor(providerText)
    const fetched = await executor.execute({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    expect(fetched.success).toBe(true)
    const handle = /handle="([^"]+)"/.exec(fetched.contentItems.map((c) => c.text).join('\n'))?.[1]
    expect(handle).toBeTruthy()
    const continued = await executor.execute({
      rid: 2,
      tool: 'nox-read-continuation',
      args: { handle: handle!, offset: 24_000 },
      namespace: null,
    })
    expect(continued.success).toBe(true)
    const pending = gate.handle(replaceReq(3, '# Short replacement'))
    for (let i = 0; i < 200 && gate.approvals.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
    expect(gate.approvals.pendingCount).toBe(1)
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
    const out = (await pending) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toContain('ok')
    expect(dispatches).toHaveLength(1)
  })
})

describe('Epoch F5 — R3 retained untrusted exposure (integrated)', () => {
  function fakeCodex(script: (tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
    let onTool: ((req: { tool: string; args: Record<string, unknown>; rid: number; namespace: null }) => Promise<unknown>) | null = null
    const client = {
      onToolCall: null as unknown,
      emit: () => undefined,
      async startThread() { return 'codex-f5' },
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

  it('turn-two keeps untrusted provenance, restores conservatively, fresh stays clean', async () => {
    const calls: Array<{ tool: string; provenance?: string }> = []
    const executor = new ToolExecutor({
      callTool: async (name, _args, _signal, provenance) => {
        calls.push({ tool: name, provenance })
        return { content: [{ type: 'text', text: 'synthetic workspace text' }] }
      },
      assertToolAllowed: () => undefined,
    })
    let script: (tool: (name: string) => Promise<unknown>) => Promise<void> = async (tool) => {
      await tool('notion-fetch')
    }
    const codex = fakeCodex((tool) => script(tool))
    const loop = new AgentLoop({
      bridge: { disconnect: () => undefined } as unknown as never,
      codex: codex as unknown as never,
      executor,
      getDynamicTools: async () => [],
      developerInstructions: 'Nox',
    })
    await loop.sendUserMessage('read it', { mentions: [{ pageId: PAGE, title: 'P', markdown: '# hello' }] })
    expect(calls[0].provenance).toBe('untrusted-context')
    expect(loop.hasUntrustedConversation()).toBe(true)
    script = async (tool) => { await tool('notion-update-page') }
    await loop.sendUserMessage('edit it')
    expect(calls[1]).toMatchObject({ tool: 'notion-update-page', provenance: 'untrusted-context' })

    const reloadedCalls: Array<{ tool: string; provenance?: string }> = []
    const reloadedExecutor = new ToolExecutor({
      callTool: async (name, _args, _signal, provenance) => {
        reloadedCalls.push({ tool: name, provenance })
        return { content: [{ type: 'text', text: 'x' }] }
      },
      assertToolAllowed: () => undefined,
    })
    const reloadedCodex = fakeCodex(async (tool) => { await tool('notion-update-page') })
    const reloaded = new AgentLoop({
      bridge: { disconnect: () => undefined } as unknown as never,
      codex: reloadedCodex as unknown as never,
      executor: reloadedExecutor,
      getDynamicTools: async () => [],
      developerInstructions: 'Nox',
    })
    reloaded.restoreThread(loop.currentThreadId ?? 'codex-f5')
    expect(reloaded.hasUntrustedConversation()).toBe(true)
    await reloaded.sendUserMessage('edit after reload')
    expect(reloadedCalls[0].provenance).toBe('untrusted-context')

    const fresh = new AgentLoop({
      bridge: { disconnect: () => undefined } as unknown as never,
      codex: fakeCodex(async () => undefined) as unknown as never,
      executor: new ToolExecutor({ callTool: async () => ({ content: [{ type: 'text', text: 'x' }] }), assertToolAllowed: () => undefined }),
      getDynamicTools: async () => [],
      developerInstructions: 'Nox',
    })
    fresh.newThread()
    expect(fresh.hasUntrustedConversation()).toBe(false)
  })

  it('granted turn-two small edit still requires confirmation after exposure', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-f5-r3')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const dispatches: string[] = []
    const gate = new WriteGate({
      callTool: async (name) => {
        dispatches.push(name)
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
})

describe('Epoch F5 — R5 stale login never resurrects (integrated)', () => {
  function deps() {
    const session = memoryStore()
    const local = memoryStore()
    return {
      session,
      local,
      fetchImpl: (async () => new Response(JSON.stringify(tokenResponse()), { status: 200 })) as typeof fetch,
      getClientId: async () => 'client-f5',
      now: () => 1_000_000,
    }
  }

  it('late save after wipe throws STALE_LOGIN_ATTEMPT with zero credentials', async () => {
    const d = deps()
    const s = new TokenStore(d)
    const attempt = await s.beginLogin()
    await s.wipe()
    await expect(s.saveFromTokenResponse(tokenResponse(), attempt)).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    expect(await s.getAccessToken()).toBeNull()
    expect(await s.hasRefreshToken()).toBe(false)
  })

  it('older login cannot replace newer login', async () => {
    const d = deps()
    const s = new TokenStore(d)
    const a = await s.beginLogin()
    const b = await s.beginLogin()
    await s.saveFromTokenResponse(tokenResponse({ access_token: 'at-B', refresh_token: 'rt-B' }), b)
    await expect(s.saveFromTokenResponse(tokenResponse({ access_token: 'at-A', refresh_token: 'rt-A' }), a)).rejects.toThrow(
      /STALE_LOGIN_ATTEMPT/,
    )
    expect(await s.getAccessToken()).toBe('at-B')
  })
})

describe('Epoch F5 — R7 MCP byte budget (integrated)', () => {
  function chunked(full: string, chunkBytes = 64 * 1024): Response {
    const bytes = new TextEncoder().encode(full)
    let offset = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (offset >= bytes.length) { c.close(); return }
        const end = Math.min(offset + chunkBytes, bytes.length)
        c.enqueue(bytes.subarray(offset, end))
        offset = end
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('3 MiB ASCII JSON resolves; truly oversized body fails bounded', async () => {
    resetRequestIds()
    const text = 'a'.repeat(3 * 1024 * 1024)
    const okClient = new McpClient({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number }
        return chunked(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }))
      }) as typeof fetch,
      getAccessToken: async () => 'tok-f5',
    })
    const res = await okClient.callTool('notion-fetch', {})
    expect(McpClient.resultText(res).length).toBe(text.length)

    resetRequestIds()
    const big = 'b'.repeat(MCP_RESPONSE_BUDGET_BYTES + 1024)
    const bigClient = new McpClient({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number }
        return chunked(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: big }] } }))
      }) as typeof fetch,
      getAccessToken: async () => 'tok-f5',
    })
    await expect(bigClient.callTool('notion-fetch', {})).rejects.toThrow(/MCP_OVERSIZE/)
  })
})

describe('Epoch F5 — upload stays disabled and clean Auto still works (integrated)', () => {
  it('raw ticket and local-upload routes refuse with zero transport; fresh Auto grant stays silent', async () => {
    const calls: string[] = []
    const journal = new MutationJournal()
    journal.setThread('thread-f5-upload')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name) => {
        calls.push(name)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      fetchPageMarkdown: async () => '# Simple\noriginal text',
      getMode: () => access.mode(),
      getContextSet: () => access.contextPages(),
      journal,
      getSmallEditGrant: () => access.smallEditGrant(),
      recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
      ownership: { isOwner: () => true, getOwnerGeneration: () => 'o', getConnectionGeneration: () => 'c' },
      getWorkspaceId: () => 'w',
    })
    for (const tool of ['notion-create-file-upload', 'nox-upload-local-file']) {
      const out = (await gate.handle({ rid: 90, tool, args: { id: PAGE }, namespace: null })) as {
        isError?: boolean
        content: Array<{ text?: string }>
      }
      expect(out.isError).toBe(true)
      expect(out.content[0].text).toMatch(/UNSUPPORTED_EFFECT|UPLOAD_UNSUPPORTED/)
    }
    expect(calls).toHaveLength(0)
    const silent = (await gate.handle(propertiesReq(91))) as { content: Array<{ text?: string }> }
    expect(silent.content[0].text).toContain('ok')
    expect(calls).toHaveLength(1)
  })
})
