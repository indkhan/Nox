import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { ToolExecutor } from '../../src/lib/agent/executor'
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
    // Wired below once the gate exposes model-delivery reporting (F2.1).
    onModelTruncation: (pageId, delivered, total) => {
      ;(gate as unknown as { noteModelTruncation?: (p: string, d: number, t: number) => void })
        .noteModelTruncation?.(pageId, delivered, total)
    },
  })
  executor.beginTurn()
  gate.beginTurn()
  return executor
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
