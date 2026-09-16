import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal, type JournalEntry, type JournalStore } from '../../src/lib/writes/journal'
import { requestRuntimeUndo } from '../../src/lib/writes/undo'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'

const PAGE = 'f'.repeat(32)

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

interface GateHarness {
  gate: WriteGate
  journal: MutationJournal
  calls: Array<{ name: string; args: Record<string, unknown> }>
  fetches: string[]
  setOwner: (v: boolean) => void
  setOwnerGen: (v: string | null) => void
  setConnGen: (v: string | null) => void
  setWorkspace: (v: string | null) => void
}

async function handleWithApproval(gate: WriteGate, req: Parameters<WriteGate['handle']>[0]) {
  const pending = gate.handle(req)
  for (let i = 0; i < 200 && gate.approvals.pendingCount === 0; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
  if (gate.approvals.pendingCount > 0) {
    gate.approvals.answer(gate.approvals.pendingIds[0], 'approve')
  }
  return pending
}

function makeHarness(opts: {
  journalStore?: JournalStore
  fetchImpl?: (pageId: string) => Promise<string>
  onAppend?: (entry: JournalEntry) => void
  mode?: 'auto' | 'ask'
} = {}): GateHarness {
  let owner = true
  let ownerGen: string | null = 'owner-gen-1'
  let connGen: string | null = 'conn-1'
  let workspace: string | null = 'workspace-1'
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const fetches: string[] = []
  const backing: JournalEntry[] = []
  const store: JournalStore = opts.journalStore ?? {
    async append(entry) {
      opts.onAppend?.(entry)
      const i = backing.findIndex((e) => e.id === entry.id)
      if (i >= 0) backing[i] = entry
      else backing.push(entry)
    },
    async list() {
      return [...backing]
    },
  }
  const journal = new MutationJournal(store)
  journal.setThread('thread-f1')
  const access = createTurnAccessState()
  access.begin(opts.mode ?? 'auto', [PAGE], [], { allowed: true, pages: [PAGE] })
  const gate = new WriteGate({
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    fetchPageMarkdown: async (pageId) => {
      fetches.push(pageId)
      if (opts.fetchImpl) return opts.fetchImpl(pageId)
      return '# Simple\noriginal text'
    },
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (c) => access.recordUnplannedEffects(c),
    ownership: {
      isOwner: () => owner,
      getOwnerGeneration: () => ownerGen,
      getConnectionGeneration: () => connGen,
    },
    getWorkspaceId: () => workspace,
  })
  return {
    gate,
    journal,
    calls,
    fetches,
    setOwner: (v) => { owner = v },
    setOwnerGen: (v) => { ownerGen = v },
    setConnGen: (v) => { connGen = v },
    setWorkspace: (v) => { workspace = v },
  }
}

describe('Epoch F1.1 — R1 forward-write dispatch revalidation', () => {
  it('refuses with zero transport when the owner lease is lost during intent persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.status === 'pending') harness.setOwner(false)
      },
    })
    const h = harness
    const out = await h.gate.handle(propertiesReq(1)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER|LEASE_EXPIRED|owner/i)
    expect(h.calls).toHaveLength(0)
    const rows = await h.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })

  it('refuses with zero transport when the connection generation changes during intent persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.status === 'pending') harness.setConnGen('conn-2')
      },
    })
    const out = await harness.gate.handle(propertiesReq(2)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/CONNECTION_CHANGED/)
    expect(harness.calls).toHaveLength(0)
    const rows = await harness.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].scope?.connectionGeneration).toBe('conn-1')
  })

  it('refuses with zero transport when the workspace changes during intent persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.status === 'pending') harness.setWorkspace('workspace-2')
      },
    })
    const out = await harness.gate.handle(propertiesReq(3)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/CONNECTION_CHANGED|workspace/i)
    expect(harness.calls).toHaveLength(0)
    const rows = await harness.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })

  it('refuses with zero transport when the owner is lost during guard reads', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      mode: 'ask',
      fetchImpl: async () => {
        harness.setOwner(false)
        return '# Simple\noriginal text'
      },
    })
    await harness.gate.rememberPageRead(PAGE, '# Simple\noriginal text')
    const out = await handleWithApproval(harness.gate, replaceReq(4)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER|LEASE_EXPIRED|owner/i)
    expect(harness.calls).toHaveLength(0)
  })

  it('refuses with zero transport when the owner is lost during the final pre-dispatch re-read', async () => {
    let harness!: GateHarness
    let fetchCount = 0
    harness = makeHarness({
      mode: 'ask',
      fetchImpl: async () => {
        fetchCount++
        // Guard uses 2 fetches (snapshot + assertUnchanged); final recheck is #3.
        if (fetchCount >= 3) harness.setOwner(false)
        return '# Simple\noriginal text'
      },
    })
    await harness.gate.rememberPageRead(PAGE, '# Simple\noriginal text')
    const out = await handleWithApproval(harness.gate, replaceReq(5)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(fetchCount).toBeGreaterThanOrEqual(3)
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER|LEASE_EXPIRED|owner/i)
    expect(harness.calls).toHaveLength(0)
    const rows = await harness.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })
})

describe('Epoch F1.2 — R1 undo and shared-effect dispatch revalidation', () => {
  function propertiesArgs() {
    return { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } }
  }

  async function seedApplied(h: GateHarness) {
    return h.journal.record({
      tool: 'notion-update-page',
      args: propertiesArgs(),
      kind: 'properties',
      inverse: { tool: 'notion-update-page', args: propertiesArgs() },
    })
  }

  it('undo refuses with zero transport when the owner is lost during reservation persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.kind === 'undo' && entry.status === 'pending') harness.setOwner(false)
      },
    })
    const entry = await seedApplied(harness)
    await expect(
      harness.gate.handleUndo(entry.inverse!.tool, entry.inverse!.args, { journalId: entry.id }),
    ).rejects.toThrow(/NOT_OWNER|LEASE_EXPIRED/)
    expect(harness.calls).toHaveLength(0)
    // The refused undo settles as failed and releases the original.
    expect(await harness.journal.undoable()).toHaveLength(1)
    const undos = (await harness.journal.newestFirst()).filter((e) => e.kind === 'undo')
    expect(undos).toHaveLength(1)
    expect(undos[0].status).toBe('failed')
  })

  it('undo refuses with zero transport when the connection changes during reservation persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.kind === 'undo' && entry.status === 'pending') harness.setConnGen('conn-2')
      },
    })
    const entry = await seedApplied(harness)
    await expect(
      harness.gate.handleUndo(entry.inverse!.tool, entry.inverse!.args, { journalId: entry.id }),
    ).rejects.toThrow(/CONNECTION_CHANGED/)
    expect(harness.calls).toHaveLength(0)
    expect(await harness.journal.undoable()).toHaveLength(1)
  })

  it('undo refuses with zero transport when the owner is lost during guard reads', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      fetchImpl: async () => {
        harness.setOwner(false)
        return '# Simple\noriginal text'
      },
    })
    const contentArgs = { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Undo content' } }
    const entry = await harness.journal.record({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Before' } },
      kind: 'content-replace',
      inverse: { tool: 'notion-update-page', args: contentArgs },
    })
    await expect(
      harness.gate.handleUndo(entry.inverse!.tool, entry.inverse!.args, { journalId: entry.id }),
    ).rejects.toThrow(/NOT_OWNER|LEASE_EXPIRED/)
    expect(harness.calls).toHaveLength(0)
    expect(await harness.journal.undoable()).toHaveLength(1)
  })

  it('shared effects refuse without invoking the effect when authority is lost during intent persistence', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.kind === 'upload' && entry.status === 'pending') harness.setOwner(false)
      },
    })
    let ran = 0
    await expect(
      harness.gate.runEffectExclusive(
        async () => { ran++; return 'ok' },
        undefined,
        { tool: 'nox-upload-local-file', args: { attachment_id: 'a1' }, kind: 'upload' },
      ),
    ).rejects.toThrow(/NOT_OWNER|LEASE_EXPIRED/)
    expect(ran).toBe(0)
    expect(harness.calls).toHaveLength(0)
    const rows = await harness.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
  })

  it('restored undo still reaches the runtime path helper with zero transport on revoked authority', async () => {
    let harness!: GateHarness
    harness = makeHarness({
      onAppend: (entry) => {
        if (entry.kind === 'undo' && entry.status === 'pending') harness.setOwner(false)
      },
    })
    const entry = await seedApplied(harness)
    await expect(requestRuntimeUndo(harness.gate, entry.id)).rejects.toThrow(/NOT_OWNER|LEASE_EXPIRED/)
    expect(harness.calls).toHaveLength(0)
  })
})

describe('Epoch F1.3 — R4 queued work stops behind unknown outcomes', () => {
  function deferred<T = void>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  async function waitForCalls(h: { calls: unknown[] }, n: number) {
    for (let i = 0; i < 500 && h.calls.length < n; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(h.calls.length).toBeGreaterThanOrEqual(n)
  }

  it('queues two mutations behind an ambiguous first outcome and dispatches only once', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    // Hold the first dispatch so the next two admit while its intent is active.
    let first = true
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f1')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        calls.push({ name, args })
        if (first) {
          first = false
          return release.promise
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
        getOwnerGeneration: () => 'owner-gen-1',
        getConnectionGeneration: () => 'conn-1',
      },
      getWorkspaceId: () => 'workspace-1',
    })
    const controlled = { gate, journal, calls }
    const p1 = controlled.gate.handle(propertiesReq(11))
    await waitForCalls(controlled, 1)
    const p2 = controlled.gate.handle(propertiesReq(12))
    const p3 = controlled.gate.handle(propertiesReq(13))
    await new Promise((r) => setTimeout(r, 0))
    release.reject(new Error('connection reset after dispatch'))
    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3])
    expect(r1.status).toBe('rejected')
    expect(controlled.calls).toHaveLength(1)
    for (const r of [r2, r3]) {
      expect(r.status).toBe('fulfilled')
      const v = (r as PromiseFulfilledResult<unknown>).value as { isError?: boolean; content: Array<{ text?: string }> }
      expect(v.isError).toBe(true)
      expect(v.content[0].text).toMatch(/CONFLICT_UNRESOLVED/)
    }
    const rows = await controlled.journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('unknown')
    // Explicit review unblocks new work.
    await controlled.journal.markReviewed(rows[0].id, 'inspected in Notion')
    const after = await controlled.gate.handle(propertiesReq(14)) as { content: Array<{ text?: string }> }
    expect(after.content[0].text).toContain('ok')
    expect(controlled.calls).toHaveLength(2)
  })

  it('queued work still stops when the first settlement cannot be persisted', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    let appends = 0
    const backing: JournalEntry[] = []
    const failingStore: JournalStore = {
      async append(entry) {
        appends++
        // beginIntent (#1) succeeds; the unknown settlement (#2) fails.
        if (appends === 2) throw new Error('disk full')
        const i = backing.findIndex((e) => e.id === entry.id)
        if (i >= 0) backing[i] = entry
        else backing.push(entry)
      },
      async list() {
        return [...backing]
      },
    }
    let firstCall = true
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const journal = new MutationJournal(failingStore)
    journal.setThread('thread-f1')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        calls.push({ name, args })
        if (firstCall) {
          firstCall = false
          return release.promise
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
        getOwnerGeneration: () => 'owner-gen-1',
        getConnectionGeneration: () => 'conn-1',
      },
      getWorkspaceId: () => 'workspace-1',
    })
    const p1 = gate.handle(propertiesReq(21))
    for (let i = 0; i < 500 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 0))
    const p2 = gate.handle(propertiesReq(22))
    await new Promise((r) => setTimeout(r, 0))
    release.reject(new Error('connection lost after dispatch'))
    const [r1, r2] = await Promise.allSettled([p1, p2])
    expect(r1.status).toBe('rejected')
    expect(calls).toHaveLength(1)
    expect(r2.status).toBe('fulfilled')
    const v2 = (r2 as PromiseFulfilledResult<unknown>).value as { isError?: boolean; content: Array<{ text?: string }> }
    expect(v2.isError).toBe(true)
    expect(v2.content[0].text).toMatch(/CONFLICT_UNRESOLVED/)
    const rows = await journal.newestFirst()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
  })

  it('successful prior work still lets the queue progress normally', async () => {
    const harness = makeHarness()
    const out1 = await harness.gate.handle(propertiesReq(31)) as { content: Array<{ text?: string }> }
    const out2 = await harness.gate.handle(propertiesReq(32)) as { content: Array<{ text?: string }> }
    expect(out1.content[0].text).toContain('ok')
    expect(out2.content[0].text).toContain('ok')
    expect(harness.calls).toHaveLength(2)
  })

  it('queued undo stops behind an ambiguous forward outcome', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    let firstCall = true
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f1')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        calls.push({ name, args })
        if (firstCall) {
          firstCall = false
          return release.promise
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
        getOwnerGeneration: () => 'owner-gen-1',
        getConnectionGeneration: () => 'conn-1',
      },
      getWorkspaceId: () => 'workspace-1',
    })
    const applied = await journal.record({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      kind: 'properties',
      inverse: { tool: 'notion-update-page', args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } } },
    })
    const p1 = gate.handle(propertiesReq(41))
    for (let i = 0; i < 500 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 0))
    const undoP = gate.handleUndo(applied.inverse!.tool, applied.inverse!.args, { journalId: applied.id })
    await new Promise((r) => setTimeout(r, 0))
    release.reject(new Error('connection reset after dispatch'))
    const [r1, ru] = await Promise.allSettled([p1, undoP])
    expect(r1.status).toBe('rejected')
    expect(calls).toHaveLength(1)
    expect(ru.status).toBe('rejected')
    expect(String((ru as PromiseRejectedResult).reason?.message ?? ru)).toMatch(/CONFLICT_UNRESOLVED/)
  })

  it('queued shared effects stop behind an ambiguous forward outcome', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    let firstCall = true
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const journal = new MutationJournal()
    journal.setThread('thread-f1')
    const access = createTurnAccessState()
    access.begin('auto', [PAGE], [], { allowed: true, pages: [PAGE] })
    const gate = new WriteGate({
      callTool: async (name, args) => {
        calls.push({ name, args })
        if (firstCall) {
          firstCall = false
          return release.promise
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
        getOwnerGeneration: () => 'owner-gen-1',
        getConnectionGeneration: () => 'conn-1',
      },
      getWorkspaceId: () => 'workspace-1',
    })
    const p1 = gate.handle(propertiesReq(51))
    for (let i = 0; i < 500 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 0))
    let ran = 0
    const effectP = gate.runEffectExclusive(
      async () => { ran++; return 'ok' },
      undefined,
      { tool: 'nox-upload-local-file', args: { attachment_id: 'a1' }, kind: 'upload' },
    )
    await new Promise((r) => setTimeout(r, 0))
    release.reject(new Error('connection reset after dispatch'))
    const [r1, re] = await Promise.allSettled([p1, effectP])
    expect(r1.status).toBe('rejected')
    expect(calls).toHaveLength(1)
    expect(ran).toBe(0)
    expect(re.status).toBe('rejected')
    expect(String((re as PromiseRejectedResult).reason?.message ?? re)).toMatch(/CONFLICT_UNRESOLVED/)
  })
})
