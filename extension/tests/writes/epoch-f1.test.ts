import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal, type JournalEntry, type JournalStore } from '../../src/lib/writes/journal'
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
