import { RESTRICTED_FEATURES } from '../../src/lib/codex/research'
import wireFixtures from './fixtures/turns.json'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexClient, type CodexEvent, type ThreadSettings } from '../../src/lib/codex/client'
import type { NativeBridge } from '../../src/lib/codex/native'

function fakeBridge() {
  const rpcHandlers: Array<{ method: string; resolve: (v: unknown) => void }> = []
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const requests: Array<{ rid: number; method: string; params: Record<string, unknown> }> = []
  const responses: Array<{ rid: number; result: unknown }> = []
  const bridge = {
    rpc: vi.fn((method: string, _params?: unknown) => {
      if (method === 'thread/inject_items') return Promise.resolve({})
      if (method === 'config/read') return Promise.resolve({ config: {} })
      if (method === 'configRequirements/read') return Promise.resolve({ requirements: null })
      if (method === 'experimentalFeature/list') return Promise.resolve({ data: RESTRICTED_FEATURES.map(name => ({ name, enabled: false })) })
      if (method === 'mcpServerStatus/list') return Promise.resolve({ data: [] })
      if (method === 'turn/start') {
        // turn/start resolves when the server acks; the promise we care about
        // is the client's completion promise.
        return Promise.resolve({ turn: { id: 'turn_1' } })
      }
      return new Promise<unknown>((resolve) => {
        rpcHandlers.push({ method, resolve })
      })
    }),
    notify: vi.fn(),
    disconnect: vi.fn(),
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
  bridge.onNotification?.({ method, params: { threadId: 'thr_9', turnId: 'turn_1', itemId: 'a1', ...params, ...(method === 'turn/completed' ? { turn: { id: 'turn_1', status: params.interrupted ? 'interrupted' : 'completed', ...(params.turn as object ?? {}) } } : {}) } })
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

  async function startThreadFixture(settings: ThreadSettings = { dynamicTools: [], developerInstructions: 'be nice' }) {
    const initP = client.initialize()
    h.rpcHandlers.find((r) => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.149.0' })
    await initP
    void h.rpcHandlers.splice(0)
    const modelsP = client.startThread(settings)
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
    expect(params).not.toHaveProperty('effort')
    expect(params.personality).toBe('pragmatic')
    await expect(client.listModels()).resolves.toHaveLength(2)
  })

  it('passes the selected service tier to thread/start', async () => {
    await startThreadFixture({ dynamicTools: [], developerInstructions: 'be nice', serviceTier: 'fast' })
    const call = h.bridge.rpc.mock.calls.find((c) => c[0] === 'thread/start')
    expect(call![1]).toMatchObject({ serviceTier: 'fast' })
  })

  it('streams deltas and resolves with final text + usage', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([{ type: 'text', text: 'hi' }])
    emit(h.bridge, 'item/reasoning/summaryTextDelta', { threadId: 'thr_9', delta: 'hmm' })
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: 'Hello' })
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: ' world' })
    emit(h.bridge, 'turn/completed', { threadId: 'thr_9', turn: { usage: { input_tokens: 1, output_tokens: 2 } } })
    const result = await turnPromise
    expect(result).toEqual({ interrupted: false, finalText: 'Hello world' })
    expect(events.map((e) => e.kind)).toEqual([
      'turn-started',
      'reasoning-delta',
      'text-replaced',
      'usage',
      'done',
    ])
  })

  it('prefers the completed agentMessage over truncated deltas', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    emit(h.bridge, 'item/agentMessage/delta', { threadId: 'thr_9', delta: 'partial' })
    emit(h.bridge, 'item/completed', { threadId: 'thr_9', item: { type: 'agentMessage', id: 'a1', text: 'the full answer' } })
    emit(h.bridge, 'turn/completed', {})
    const result = await turnPromise
    expect(result.finalText).toBe('the full answer')
  })

  it('routes item/tool/call to the tool handler and answers success payloads', async () => {
    await startThreadFixture()
    client.onToolCall = async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'ok-data' }] })
    const turnPromise = client.runTurn([])
    h.bridge.onCodexRequest?.({ rid: 42, method: 'item/tool/call', params: { threadId: 'thr_9', turnId: 'turn_1', tool: 'notion-fetch', arguments: { page_id: 'p1' }, callId: 'call_7' } })
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
    h.bridge.onCodexRequest?.({ rid: 43, method: 'item/tool/call', params: { threadId: 'thr_9', turnId: 'turn_1', tool: 'notion-search', arguments: {} } })
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
    emit(h.bridge, 'turn/completed', { threadId: 'thr_9', turn: { status: 'failed', error: { message: 'quota exhausted' } } })
    await assertion
  })

  it('interrupt sends turn/interrupt and completes interrupted=true', async () => {
    await startThreadFixture()
    const turnPromise = client.runTurn([])
    await Promise.resolve()
    const interrupting = client.interrupt()
    h.rpcHandlers.find((r) => r.method === 'turn/interrupt')?.resolve({})
    await interrupting
    expect(h.bridge.rpc).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thr_9', turnId: 'turn_1' }, 5000)
    emit(h.bridge, 'turn/completed', { interrupted: true })
    expect((await turnPromise).interrupted).toBe(true)
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
    h.bridge.onCodexRequest?.({ rid: 45, method: 'item/tool/call', params: { threadId: 'thr_9', turnId: 'turn_1', tool: 'notion-update-page', arguments: {}, callId: 'rejected-1' } })
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
  // Expected failures establish the baseline before lifecycle implementation.
  it('wire: completed final text replaces longer deltas and commentary', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    for (const e of wireFixtures.messages) emit(h.bridge, e.method, e.params)
    expect((await pending).finalText).toBe('42.')
  })

  it('wire: failed status cannot be concealed by partial output', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    const assertion = expect(pending).rejects.toThrow('quota exhausted')
    for (const e of wireFixtures.failed) emit(h.bridge, e.method, e.params)
    await assertion
  })

  it('wire: interrupted status preserves partial text', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    for (const e of wireFixtures.interrupted) emit(h.bridge, e.method, e.params)
    expect(await pending).toMatchObject({ interrupted: true, finalText: 'Partial answer' })
  })

  it('wire: documented summary event supplies progress', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    for (const e of wireFixtures.summary) emit(h.bridge, e.method, e.params)
    emit(h.bridge, 'turn/completed', wireFixtures.messages.at(-1)!.params)
    await pending
    expect(events).toContainEqual({ kind: 'reasoning-delta', text: 'Checking evidence.' })
  })

  it('wire: explicit effort is sent on turn/start', async () => {
    await startThreadFixture({ effort: 'high' })
    const pending = client.runTurn([])
    emit(h.bridge, 'turn/completed', wireFixtures.messages.at(-1)!.params)
    await pending
    expect(h.bridge.rpc.mock.calls.find(c => c[0] === 'turn/start')![1]).toMatchObject({ effort: 'high' })
  })

  it('ignores foreign turns before the start response', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    emit(h.bridge, 'item/agentMessage/delta', { turnId: 'old', delta: 'wrong' })
    emit(h.bridge, 'turn/completed', { turn: { id: 'old', status: 'completed' } })
    emit(h.bridge, 'item/agentMessage/delta', { delta: 'right' })
    emit(h.bridge, 'turn/completed', {})
    expect((await pending).finalText).toBe('right')
  })
  it('uses the last phase-less completed message', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    emit(h.bridge, 'item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Progress' } })
    emit(h.bridge, 'item/completed', { item: { type: 'agentMessage', id: 'a2', text: 'Answer' } })
    emit(h.bridge, 'turn/completed', {})
    expect((await pending).finalText).toBe('Answer')
    expect(events).toContainEqual({ kind: 'commentary', id: 'a1', text: 'Progress' })
  })
  it('settles on disconnect after acknowledgement', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    const assertion = expect(pending).rejects.toThrow('disconnected')
    await Promise.resolve()
    h.bridge.onBridgeDisconnected?.()
    await assertion
  })

  it('deduplicates native searches and interrupts at the observable research budget', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    await Promise.resolve()
    for (let i = 0; i < 12; i++) {
      const params = { item: { type: 'webSearch', id: `s${i}`, query: 'public question', action: { type: 'search', query: 'public question' } } }
      emit(h.bridge, 'item/started', params)
      emit(h.bridge, 'item/started', params)
    }
    await vi.waitFor(() => expect(h.rpcHandlers.some(r => r.method === 'turn/interrupt')).toBe(true))
    h.rpcHandlers.find(r => r.method === 'turn/interrupt')!.resolve({})
    emit(h.bridge, 'turn/completed', { interrupted: true })
    await pending
    expect(events.filter(e => e.kind === 'web-search')).toHaveLength(12)
    expect(events.find(e => e.kind === 'web-search')).toMatchObject({ id: 's0', query: 'public question' })
  })

  it.each([false, true])('settles cancellation without a completion event (before ack: %s)', async (beforeAck) => {
    await startThreadFixture()
    vi.useFakeTimers()
    try {
      if (beforeAck) h.bridge.rpc.mockImplementationOnce(() => new Promise(() => {}))
      const pending = client.runTurn([])
      const assertion = expect(pending).rejects.toThrow(/stop.*completion/i)
      await Promise.resolve()
      const stopping = client.interrupt()
      h.rpcHandlers.find(r => r.method === 'turn/interrupt')?.resolve({})
      await stopping
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
      expect(h.bridge.disconnect).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it.each(['resolve', 'reject'])('ignores a late tool %s after the next turn starts', async (outcome) => {
    await startThreadFixture()
    let resolve!: (v: unknown) => void
    let reject!: (e: Error) => void
    client.onToolCall = () => new Promise((yes, no) => { resolve = yes; reject = no })
    const first = client.runTurn([])
    h.bridge.onCodexRequest?.({ rid: 99, method: 'item/tool/call', params: { threadId: 'thr_9', turnId: 'turn_1', tool: 'notion-fetch' } })
    await vi.waitFor(() => expect(resolve).toBeDefined())
    emit(h.bridge, 'turn/completed', { interrupted: true })
    await first
    const next = client.runTurn([])
    if (outcome === 'resolve') resolve({ success: true })
    else reject(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(events.filter(e => e.kind === 'tool-completed')).toHaveLength(0)
    expect(h.responses.filter(r => r.rid === 99)).toHaveLength(0)
    emit(h.bridge, 'turn/completed', {})
    await next
  })

  it('uses the last completed phaseless answer over a later unfinished message', async () => {
    await startThreadFixture()
    const pending = client.runTurn([])
    emit(h.bridge, 'item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Answer' } })
    emit(h.bridge, 'item/agentMessage/delta', { itemId: 'a2', delta: 'Unfinished' })
    emit(h.bridge, 'turn/completed', {})
    expect((await pending).finalText).toBe('Answer')
    expect(events).not.toContainEqual({ kind: 'commentary', id: 'a1', text: 'Answer' })
  })

  it('does not activate a thread whose setup was cancelled', async () => {
    await startThreadFixture()
    const abort = new AbortController()
    const pending = client.resumeThread('other-thread', {}, abort.signal)
    h.rpcHandlers.find(r => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.153.4' })
    await vi.waitFor(() => expect(h.rpcHandlers.some(r => r.method === 'thread/resume')).toBe(true))
    abort.abort()
    h.rpcHandlers.find(r => r.method === 'thread/resume')!.resolve({ thread: { id: 'other-thread' } })
    await expect(pending).rejects.toThrow()
    const turn = client.runTurn([])
    emit(h.bridge, 'turn/completed', {})
    await turn
    expect(h.bridge.rpc.mock.calls.find(c => c[0] === 'turn/start')![1]).toMatchObject({ threadId: 'thr_9' })
  })

  it('reloads the app server before resuming so updated research settings take effect', async () => {
    await startThreadFixture()
    const pending = client.resumeThread('thr_9', { webSearchEnabled: true, developerInstructions: 'Current instructions' })
    await vi.waitFor(() => expect(h.bridge.disconnect).toHaveBeenCalledOnce())
    h.rpcHandlers.find(r => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.153.4' })
    await vi.waitFor(() => expect(h.rpcHandlers.some(r => r.method === 'thread/resume')).toBe(true))
    h.rpcHandlers.find(r => r.method === 'thread/resume')!.resolve({ thread: { id: 'thr_9' } })
    expect(await pending).toBe('thr_9')
    expect(h.bridge.rpc).toHaveBeenCalledWith('thread/inject_items', { threadId: 'thr_9', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Current instructions' }] }] })
    expect(h.bridge.rpc.mock.calls.find(c => c[0] === 'thread/resume')![1]).toMatchObject({ threadId: 'thr_9', config: { web_search: 'live' } })
  })



  it('rejects a different resumed thread before appending instructions', async () => {
    await startThreadFixture()
    const pending = client.resumeThread('thr_9', {})
    h.rpcHandlers.find(r => r.method === 'initialize')!.resolve({ userAgent: 'codex/0.153.4' })
    await vi.waitFor(() => expect(h.rpcHandlers.some(r => r.method === 'thread/resume')).toBe(true))
    h.rpcHandlers.find(r => r.method === 'thread/resume')!.resolve({ thread: { id: 'unexpected' } })
    await expect(pending).rejects.toThrow(/different thread/)
    expect(h.bridge.rpc.mock.calls.some(c => c[0] === 'thread/inject_items')).toBe(false)
  })

})
