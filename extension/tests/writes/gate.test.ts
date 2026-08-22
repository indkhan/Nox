import { describe, expect, it, vi } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { GuardViolation } from '../../src/lib/writes/guard'
import { undoEntry, undoNewest } from '../../src/lib/writes/undo'
import { buildInverse } from '../../src/lib/writes/inverse'
import type { Mode } from '../../src/lib/writes/approvals'

const PAGE = 'a'.repeat(32)

function makeGate(over: {
  mode?: Mode
  markdown?: () => string
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>
  contextSet?: Set<string>
} = {}) {
  let answer: 'approve' | 'reject' | null = null
  const journal = new MutationJournal()
  const gate = new WriteGate({
    callTool:
      over.callTool ??
      (async (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] })),
    fetchPageMarkdown: async () => over.markdown?.() ?? '# Simple\noriginal text',
    getMode: () => over.mode ?? 'ask',
    getContextSet: () => over.contextSet ?? new Set([PAGE]),
    journal,
  })
  return { gate, journal, setAnswer: (a: 'approve' | 'reject') => void (answer = a), getAnswer: () => answer }
}

describe('WriteGate', () => {
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
    gate.approvals.answer(gate.approvals['pending'].values().next().value!.id, 'approve')
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
    const pending = gate.handle({ rid: 3, tool: 'notion-move-pages', args: {}, namespace: null })
    await new Promise((r) => setTimeout(r, 10))
    gate.approvals.answer([...gate.approvals['pending'].keys()][0]!, 'reject')
    const out = (await pending) as { isError?: boolean; content: Array<{ text: string }> }
    expect(executed).toBe(false)
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/REJECTED_BY_USER/)
  })

  it('auto mode runs in-context non-escalated writes immediately', async () => {
    const { gate } = makeGate({ mode: 'auto', contextSet: new Set([PAGE]) })
    const out = (await gate.handle({
      rid: 4,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      namespace: null,
    })) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toContain('ran notion-update-page')
  })

  it('write guard aborts when the page changed after our snapshot', async () => {
    let version = 0
    const { gate } = makeGate({
      mode: 'ask',
      markdown: () => `# v${version++}`,
    })
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

  it('aborts when the page changed since the agent originally read it', async () => {
    let markdown = '# Original'
    let writes = 0
    const { gate } = makeGate({
      mode: 'auto',
      contextSet: new Set([PAGE]),
      markdown: () => markdown,
      callTool: async (name) => {
        if (name === 'notion-fetch') return { content: [{ type: 'text', text: markdown }] }
        writes++
        return { content: [{ type: 'text', text: 'written' }] }
      },
    })
    await gate.handle({ rid: 1, tool: 'notion-fetch', args: { id: PAGE }, namespace: null })
    markdown = '# Human edit'
    const out = (await gate.handle({
      rid: 2,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: '# Agent edit' } },
      namespace: null,
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('PAGE_CHANGED_SINCE_READ')
    expect(writes).toBe(0)
  })

  it('marks rich-page content replacements not-undoable with a reason', async () => {
    const { gate, journal } = makeGate({ mode: 'ask', markdown: () => '# Page\nsynced_block here' })
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
    await gate.handle({
      rid: 7,
      tool: 'notion-create-pages',
      args: { injected_request: true },
      namespace: null,
    })
    expect(received).toEqual({})
  })

  it('returns a successful write even when journal persistence fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const journal = new MutationJournal({
      append: async () => { throw new Error('disk full') },
      list: async () => [],
    })
    const gate = new WriteGate({
      callTool: async () => ({ content: [{ type: 'text', text: 'written' }] }),
      fetchPageMarkdown: async () => '# page',
      getMode: () => 'auto',
      getContextSet: () => new Set([PAGE]),
      journal,
    })
    const out = await gate.handle({
      rid: 9,
      tool: 'notion-update-page',
      args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: {} } },
      namespace: null,
    }) as { content: Array<{ text: string }> }
    expect(out.content[0].text).toBe('written')
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('does not journal an inverse as a new user mutation', async () => {
    const { gate, journal } = makeGate({ mode: 'ask' })
    await gate.handleUndo('notion-update-page', {
      data: { page_id: PAGE },
      command: { type: 'update_properties', properties: {} },
    })
    expect(await journal.newestFirst()).toHaveLength(0)
  })
})

describe('MutationJournal undo ordering', () => {
  it('lists newest first and separates undoable from not-undoable', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 't1', args: {}, kind: 'move', inverse: { tool: 'notion-move-pages', args: {} } })
    await journal.record({ tool: 't2', args: {}, kind: 'create-page', notUndoableReason: 'no delete tool' })
    await journal.record({ tool: 't3', args: {}, kind: 'move', inverse: { tool: 'notion-move-pages', args: {} } })

    const newestFirst = await journal.newestFirst()
    expect(newestFirst.map((e) => e.tool)).toEqual(['t3', 't2', 't1'])
    expect((await journal.undoable()).map((e) => e.tool)).toEqual(['t3', 't1'])
  })

  it('keeps the journal entry when undo fails', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 'write', args: {}, kind: 'content-update', inverse: { tool: 'undo', args: {} } })
    await expect(undoNewest(journal, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect((await journal.newestFirst())[0].status).toBe('failed')
    expect(await journal.undoable()).toHaveLength(0)
  })

  it('marks a successful undo without deleting its audit record', async () => {
    const journal = new MutationJournal()
    await journal.record({ tool: 'write', args: {}, kind: 'content-update', inverse: { tool: 'undo', args: {} } })
    await expect(undoNewest(journal, async () => undefined)).resolves.toBe(true)
    expect((await journal.newestFirst())[0].status).toBe('undone')
    expect(await journal.undoable()).toHaveLength(0)
  })

  it('undoes a selected journal entry instead of only the newest', async () => {
    const journal = new MutationJournal()
    const older = await journal.record({ tool: 'first', args: {}, kind: 'move', inverse: { tool: 'undo-first', args: {} } })
    await journal.record({ tool: 'second', args: {}, kind: 'move', inverse: { tool: 'undo-second', args: {} } })
    const calls: string[] = []
    await expect(undoEntry(journal, older.id, async (tool) => { calls.push(tool) })).resolves.toBe(true)
    expect(calls).toEqual(['undo-first'])
  })

  it('does not advertise unsupported inverse plans', () => {
    expect(buildInverse('notion-move-pages', {}, { kind: 'move', moves: [{ pageId: 'a', parentPageId: 'b' }] }).kind).toBe('not-undoable')
    expect(buildInverse('notion-update-page', {}, { kind: 'properties', properties: [{ name: 'N', type: 'number', value: 1 }] }).kind).toBe('not-undoable')
    expect(buildInverse('notion-update-view', {}, { kind: 'view', config: {} }).kind).toBe('not-undoable')
  })

  it('exposes GuardViolation as a typed error', () => {
    expect(new GuardViolation('changed')).toBeInstanceOf(Error)
  })
})


