import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexClient, type CodexEvent } from '../../src/lib/codex/client'
import type { NativeBridge } from '../../src/lib/codex/native'

function fakeBridge() {
  const rpcHandlers: Array<{ method: string; resolve: (v: unknown) => void }> = []
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const requests: Array<{ rid: number; method: string; params: Record<string, unknown> }> = []
  const responses: Array<{ rid: number; result: unknown }> = []
  const bridge = {
    rpc: vi.fn((method: string, _params?: unknown) => {
      if (method === 'turn/start') {
        // turn/start resolves when the server acks; the promise we care about
        // is the client's completion promise.
        return Promise.resolve({})
      }
      return new Promise<unknown>((resolve) => {
        rpcHandlers.push({ method, resolve })
      })
    }),
    notify: vi.fn(),
    respondTool: vi.fn((rid: number, result: unknown) => responses.push({ rid, result })),
    onNotification: null as NativeBridge['onNotification'],
    onCodexRequest: null as NativeBridge['onCodexRequest'],
  } as unknown as NativeBridge & {
    rpc: ReturnType<typeof vi.fn>
    notify: ReturnType<typeof vi.fn>
    respondTool: ReturnType<typeof vi.fn>
  }
  return { bridge, rpcHandlers, notifications, requests, responses }
}

function emit(bridge: NativeBridge, method: string, params: Record<string, unknown>) {
  bridge.onNotification?.({ method, params })
}

describe('CodexClient', () => {
  let h: ReturnType<typeof fakeBridge>
  let client: CodexClient
  const events: CodexEvent[] = []

  beforeEach(() => {
    h = fakeBridge()
    client = new CodexClient(h.bridge)
    events.length = 0
    client.emit = (e) => events.push(e)
  })

  async function startThreadFixture() {
    const initP = client.initialize()
    h.rpcHandlers.find((r) => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.149.0' })
    await initP
    void h.rpcHandlers.splice(0)
    const modelsP = client.startThread({ dynamicTools: [], developerInstructions: 'be nice' })
    h.rpcHandlers.find((r) => r.method === 'model/list')!.resolve({
      data: [
        { id: 'gpt-x', isDefault: true },
        { id: 'gpt-mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      ],
    })
    await vi.waitFor(() => expect(h.rpcHandlers.some((r) => r.method === 'thread/start')).toBe(true))
    h.rpcHandlers.find((r) => r.method === 'thread/start')!.resolve({ thread: { id: 'thr_9' } })
    return modelsP
  }

  it('initialize stores the userAgent', async () => {
    const p = client.initialize()
    h.rpcHandlers.find((r) => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.149.0 (x)' })
    expect(await p).toContain('0.149.0')
    expect(client.userAgent).toContain('codex/')
  })

  it('thread/start pins model + read-only sandbox and returns the id', async () => {
    await startThreadFixture()
    const call = h.bridge.rpc.mock.calls.find((c) => c[0] === 'thread/start')
    const params = call![1] as Record<string, unknown>
    expect(params.model).toBe('gpt-x')
    expect(params.sandbox).toBe('read-only')
    expect(params.effort).toBe('low')
    expect(params.personality).toBe('pragmatic')
    await expect(client.listModels()).resolves.toHaveLength(2)
  })

  it('streams deltas and resolves with final text + usage', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([{ type: 'text', text: 'hi' }])
    emit(h.bridge, 'item/reasoning/delta', { threadId: 'thr_9', delta: 'hmm' })
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: 'Hello' })
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: ' world' })
    emit(h.bridge, 'turn/completed', { threadId: 'thr_9', turn: { usage: { input_tokens: 1, output_tokens: 2 } } })
    const result = await turnPromise
    expect(result).toEqual({ interrupted: false, finalText: 'Hello world' })
    expect(events.map((e) => e.kind)).toEqual([
      'turn-started',
      'reasoning-delta',
      'text-delta',
      'text-delta',
      'usage',
      'done',
    ])
  })

  it('prefers the completed agentMessage over truncated deltas', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: 'partial' })
    emit(h.bridge, 'item/completed', { threadId: 'thr_9', item: { type: 'agentMessage', text: 'the full answer' } })
    emit(h.bridge, 'turn/completed', {})
    const result = await turnPromise
    expect(result.finalText).toBe('the full answer')
  })

  it('routes item/tool/call to the tool handler and answers success payloads', async () => {
    await startThreadFixture()
    client.onToolCall = async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'ok-data' }] })
    const turnPromise = client.runTurn([])
    h.bridge.onCodexRequest?.({ rid: 42, method: 'item/tool/call', params: { tool: 'notion-fetch', arguments: { page_id: 'p1' }, callId: 'call_7' } })
    await vi.waitFor(() => expect(h.responses.some((r) => r.rid === 42)).toBe(true))
    expect(h.responses[0].result).toMatchObject({ success: true })
    expect(events.filter((e) => e.kind === 'tool-call')).toHaveLength(1)
    expect(events.find((e) => e.kind === 'tool-completed')).toMatchObject({
      kind: 'tool-completed',
      callId: 'call_7',
      tool: 'notion-fetch',
      success: true,
      resultText: 'ok-data',
    })
    emit(h.bridge, 'turn/completed', {})
    await turnPromise
  })

  it('returns tool errors as model-readable results instead of crashing', async () => {
    await startThreadFixture()
    client.onToolCall = async () => {
      throw new Error('rate limited')
    }
    const turnPromise = client.runTurn([])
    h.bridge.onCodexRequest?.({ rid: 43, method: 'item/tool/call', params: { tool: 'notion-search', arguments: {} } })
    await vi.waitFor(() => expect(h.responses.some((r) => r.rid === 43)).toBe(true))
    expect(JSON.stringify(h.responses[0].result)).toContain('ERROR: rate limited')
    expect(events.find((e) => e.kind === 'tool-completed')).toMatchObject({
      kind: 'tool-completed',
      tool: 'notion-search',
      success: false,
      error: 'rate limited',
    })
    emit(h.bridge, 'turn/completed', {})
    await turnPromise
  })

  it('declines non-tool server requests', async () => {
    await startThreadFixture()
    h.bridge.onCodexRequest?.({ rid: 44, method: 'applyPatch/approval', params: {} })
    await vi.waitFor(() => expect(h.responses.some((r) => r.rid === 44)).toBe(true))
    expect(h.responses[0].result).toEqual({ decision: 'decline' })
  })

  it('rejects the turn when error fires without any output', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    const assertion = expect(turnPromise).rejects.toThrow(/quota exhausted/)
    emit(h.bridge, 'error', { threadId: 'thr_9', error: { message: 'quota exhausted' } })
    emit(h.bridge, 'turn/completed', { threadId: 'thr_9' })
    await assertion
  })

  it('interrupt sends turn/interrupt and completes interrupted=true', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    emit(h.bridge, 'turn/completed', { threadId: 'thr_9', interrupted: true })
    const result = await turnPromise
    expect(result.interrupted).toBe(true)
    const interrupting = client.interrupt()
    h.rpcHandlers.find((r) => r.method === 'turn/interrupt')?.resolve({})
    await interrupting
    expect(h.bridge.rpc).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thr_9' })
  })

  it('refuses to run a turn before a thread exists', async () => {
    await expect(client.runTurn([])).rejects.toThrow(/no active thread/)
  })

  it('emits web search start and completion events', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    emit(h.bridge, 'item/started', { item: { type: 'webSearch' } })
    emit(h.bridge, 'item/completed', { item: { type: 'webSearch' } })
    emit(h.bridge, 'turn/completed', {})
    await turnPromise
    expect(events.map((event) => event.kind)).toContain('web-search')
    expect(events.map((event) => event.kind)).toContain('web-search-completed')
  })

  it('emits a failed completion when the tool handler returns success false', async () => {
    await startThreadFixture()
    client.onToolCall = async () => ({
      success: false,
      displayText: 'REJECTED_BY_USER',
      contentItems: [{ type: 'inputText', text: 'wrapped rejection' }],
    })
    const turnPromise = client.runTurn([])
    h.bridge.onCodexRequest?.({ rid: 45, method: 'item/tool/call', params: { tool: 'notion-update-page', arguments: {}, callId: 'rejected-1' } })
    await vi.waitFor(() => expect(h.responses.some((r) => r.rid === 45)).toBe(true))
    expect(events.find((e) => e.kind === 'tool-completed')).toMatchObject({
      kind: 'tool-completed', callId: 'rejected-1', success: false, resultText: 'REJECTED_BY_USER', error: 'REJECTED_BY_USER',
    })
    emit(h.bridge, 'turn/completed', {})
    await turnPromise
  })

  it('refuses a second turn while one is running', async () => {
    await startThreadFixture()
    const first = client.runTurn([])
    await expect(client.runTurn([])).rejects.toThrow(/turn already running/)
    emit(h.bridge, 'turn/completed', {})
    await first
  })
})
