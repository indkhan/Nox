import { describe, expect, it, vi } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { requestRuntimeUndo } from '../../src/lib/writes/undo'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'
import type { Mode } from '../../src/lib/writes/approvals'

const PAGE = 'b'.repeat(32)

type Transport = (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>

function makeGate(opts: {
  owner?: boolean
  ownerGen?: string | null
  connGen?: string | null
  onOwnerGen?: () => string | null
  onConnGen?: () => string | null
  transport?: Transport
  mode?: Mode
  journal?: MutationJournal
} = {}) {
  let owner = opts.owner ?? true
  let ownerGen: string | null = opts.ownerGen ?? 'owner-gen-1'
  let connGen: string | null = opts.connGen ?? 'conn-1'
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const journal = opts.journal ?? new MutationJournal()
  journal.setThread('thread-owner')
  const access = createTurnAccessState()
  access.begin(opts.mode ?? 'auto', [PAGE], [], { allowed: true, pages: [PAGE] })
  const gate = new WriteGate({
    callTool: opts.transport ?? (async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: 'ok' }] }
    }),
    fetchPageMarkdown: async () => '# Simple\noriginal text',
    getMode: () => access.mode(),
    getContextSet: () => access.contextPages(),
    journal,
    getSmallEditGrant: () => access.smallEditGrant(),
    recordUnplannedEffects: (count) => access.recordUnplannedEffects(count),
    ownership: {
      isOwner: () => owner,
      getOwnerGeneration: opts.onOwnerGen ?? (() => ownerGen),
      getConnectionGeneration: opts.onConnGen ?? (() => connGen),
    },
    getWorkspaceId: () => 'workspace-1',
  })
  return {
    gate,
    calls,
    setOwner: (v: boolean) => { owner = v },
    setOwnerGen: (v: string | null) => { ownerGen = v },
    setConnGen: (v: string | null) => { connGen = v },
  }
}

function propertiesWrite(rid: number) {
  return {
    rid,
    tool: 'notion-update-page',
    args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
    namespace: null,
  } as const
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('mutation ownership (Epoch 02.1)', () => {
  it('viewer writes make zero transport calls', async () => {
    const { gate, calls } = makeGate({ owner: false })
    const out = await gate.handle(propertiesWrite(1)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/NOT_OWNER/)
    expect(calls).toHaveLength(0)
  })

  it('viewer undo makes zero transport calls', async () => {
    const { gate, calls } = makeGate({ owner: false })
    await expect(gate.handleUndo('notion-update-page', {})).rejects.toThrow(/NOT_OWNER/)
    expect(calls).toHaveLength(0)
  })

  it('reads still pass through without ownership', async () => {
    const { gate, calls } = makeGate({ owner: false })
    const out = await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null }) as { content: Array<{ text?: string }> }
    expect(out.content[0].text).toBe('ok')
    expect(calls).toHaveLength(1)
  })

  it('a queued mutation fails without transport after the owner lease expires', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    const { gate, calls, setOwnerGen } = makeGate({
      transport: async (name, args) => {
        calls.push({ name, args })
        return release.promise
      },
    })
    const first = gate.handle(propertiesWrite(1))
    while (calls.length < 1) await new Promise((r) => setTimeout(r, 0))
    const second = gate.handle(propertiesWrite(2))
    // Expire the lease while the second operation is queued behind the first.
    setOwnerGen('owner-gen-2')
    release.resolve({ content: [{ type: 'text', text: 'ok' }] })
    const [firstOut, secondOut] = await Promise.all([first, second]) as Array<{ isError?: boolean; content: Array<{ text?: string }> }>
    expect(firstOut.isError).not.toBe(true)
    expect(secondOut.isError).toBe(true)
    expect(secondOut.content[0].text).toMatch(/LEASE_EXPIRED/)
    expect(calls).toHaveLength(1)
  })

  it('a queued mutation fails without transport after the connection changes', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    const { gate, calls, setConnGen } = makeGate({
      transport: async (name, args) => {
        calls.push({ name, args })
        return release.promise
      },
    })
    const first = gate.handle(propertiesWrite(1))
    while (calls.length < 1) await new Promise((r) => setTimeout(r, 0))
    const second = gate.handle(propertiesWrite(2))
    setConnGen('conn-2')
    release.resolve({ content: [{ type: 'text', text: 'ok' }] })
    const [, secondOut] = await Promise.all([first, second]) as Array<{ isError?: boolean; content: Array<{ text?: string }> }>
    expect(secondOut.isError).toBe(true)
    expect(secondOut.content[0].text).toMatch(/CONNECTION_CHANGED/)
    expect(calls).toHaveLength(1)
  })

  it('simultaneous mutations serialize to at most one in-flight dispatch', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { gate, calls } = makeGate({
      transport: async (name, args) => {
        calls.push({ name, args })
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    await Promise.all([gate.handle(propertiesWrite(1)), gate.handle(propertiesWrite(2)), gate.handle(propertiesWrite(3))])
    expect(calls).toHaveLength(3)
    expect(maxInFlight).toBe(1)
  })

  it('upload effects share the serial mutation runner', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const slow: Transport = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const { gate } = makeGate({ transport: slow })
    const uploadIntent = { tool: 'nox-upload-local-file', args: { attachment_id: 'a1' }, kind: 'upload' }
    await Promise.all([
      gate.handle(propertiesWrite(1)),
      gate.runEffectExclusive(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
      }, undefined, uploadIntent),
    ])
    expect(maxInFlight).toBe(1)
  })

  it('viewer upload effects make zero transport calls', async () => {
    const { gate } = makeGate({ owner: false })
    const effect = vi.fn(async () => 'uploaded')
    const uploadIntent = { tool: 'nox-upload-local-file', args: { attachment_id: 'a1' }, kind: 'upload' }
    await expect(gate.runEffectExclusive(effect, undefined, uploadIntent)).rejects.toThrow(/NOT_OWNER/)
    expect(effect).not.toHaveBeenCalled()
  })

  it('undo is rejected while a turn is active instead of running later', async () => {
    const { gate, calls } = makeGate()
    gate.beginTurn()
    await expect(gate.handleUndo('notion-update-page', {})).rejects.toThrow(/TURN_ACTIVE/)
    expect(calls).toHaveLength(0)
    gate.endTurn()
    await gate.handleUndo('notion-update-page', {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: {} },
    })
    expect(calls).toHaveLength(1)
  })

  it('forward writes are rejected while an undo is active', async () => {
    const release = deferred<{ content: Array<{ type: string; text?: string }> }>()
    const journal = new MutationJournal()
    journal.setThread('thread-owner')
    const entry = await journal.record({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      kind: 'properties',
      inverse: { tool: 'notion-update-page', args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } } },
    })
    const { gate, calls } = makeGate({
      journal,
      transport: async (name, args) => {
        calls.push({ name, args })
        return release.promise
      },
    })
    const undo = gate.handleUndo(entry.inverse!.tool, entry.inverse!.args, { journalId: entry.id })
    while (calls.length < 1) await new Promise((r) => setTimeout(r, 0))
    expect(gate.isUndoActive()).toBe(true)
    const blocked = await gate.handle(propertiesWrite(9)) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(blocked.isError).toBe(true)
    expect(blocked.content[0].text).toMatch(/UNDO_IN_PROGRESS/)
    release.resolve({ content: [{ type: 'text', text: 'ok' }] })
    await undo
    expect(gate.isUndoActive()).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('double undo dispatches exactly once', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-owner')
    const entry = await journal.record({
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      kind: 'properties',
      inverse: { tool: 'notion-update-page', args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } } },
    })
    let dispatches = 0
    const { gate } = makeGate({
      journal,
      transport: async () => {
        dispatches++
        await new Promise((r) => setTimeout(r, 5))
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const [first, second] = await Promise.all([
      requestRuntimeUndo(gate, entry.id),
      requestRuntimeUndo(gate, entry.id),
    ])
    expect([first, second].sort()).toEqual([false, true])
    expect(dispatches).toBe(1)
  })
})
