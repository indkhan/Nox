import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { GuardViolation } from '../../src/lib/writes/guard'
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

  it('refuses injected requests outright', async () => {
    let executed = false
    const { gate } = makeGate({
      mode: 'auto',
      callTool: async () => {
        executed = true
        throw new Error('should not run')
      },
    })
    const out = (await gate.handle({
      rid: 7,
      tool: 'notion-create-pages',
      args: { injected_request: true },
      namespace: null,
    })) as { isError?: boolean }
    expect(executed).toBe(false)
    expect(out.isError).toBe(true)
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

  it('exposes GuardViolation as a typed error', () => {
    expect(new GuardViolation('changed')).toBeInstanceOf(Error)
  })
})


