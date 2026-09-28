// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: vi.fn() } } })
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'provider result' }] }))
  const codex = {
    onToolCall: undefined as undefined | ((request: unknown) => Promise<unknown>),
    emit: undefined as unknown,
    startThread: vi.fn(async () => 'codex-thread'),
    runTurn: vi.fn(async () => ({ finalText: 'answer', interrupted: false })),
    researchLimitation: null,
  }
  return { callTool, codex }
})

vi.mock('../../src/lib/notion/panel', () => ({ notion: {
  scheduleCallTool: boundary.callTool,
  listTools: vi.fn(async () => [{ name: 'notion-search', description: 'Search', inputSchema: { type: 'object' } }]),
  capabilities: { can: () => ({ allowed: true }) },
  connectionGeneration: 'connection',
  identity: { workspaceId: 'workspace' },
} }))
vi.mock('../../src/lib/codex/panel', () => ({ codex: boundary.codex, bridge: { disconnect: vi.fn() } }))

import { agentLoop, prepareAgentTurn, setAgentHistoryThread, writeGate } from '../../src/lib/agent/panel'

it('routes a Codex tool request through the real panel executor and write gate to Notion', async () => {
  boundary.callTool.mockClear()
  const gateCall = vi.spyOn(writeGate, 'handle')
  boundary.codex.runTurn.mockImplementationOnce(async () => {
    const result = await boundary.codex.onToolCall!({
      tool: 'notion-search', namespace: null, args: { query: 'tasks' }, rid: 1, callId: 'call-1',
    }) as { success: boolean; contentItems: Array<{ text: string }> }
    expect(result.success).toBe(true)
    expect(result.contentItems[0].text).toContain('provider result')
    return { finalText: 'answer', interrupted: false }
  })
  setAgentHistoryThread(null)
  prepareAgentTurn('ask', [])
  const answer = await agentLoop.sendUserMessage('find tasks')
  expect(answer.text).toBe('answer')
  expect(gateCall).toHaveBeenCalledWith(expect.objectContaining({ tool: 'notion-search', callId: 'call-1' }))
  expect(boundary.callTool).toHaveBeenCalledWith('notion-search', { query: 'tasks' }, expect.any(AbortSignal), expect.any(Object))
  gateCall.mockRestore()
})
