import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeBridge, type PortLike } from '../../src/lib/codex/native'
import { ChunkAssembler } from '../../src/lib/codex/frame'

function fakePort() {
  const listeners: Array<(m: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const sent: unknown[] = []
  const port: PortLike = {
    postMessage: (m) => void sent.push(m),
    disconnect: () => disconnectListeners.forEach((f) => f()),
    onMessage: { addListener: (cb) => listeners.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
  }
  return {
    port,
    sent,
    emit: (m: unknown) => listeners.forEach((f) => f(m)),
    emitDisconnect: () => disconnectListeners.forEach((f) => f()),
  }
}

describe('ChunkAssembler', () => {
  it('reassembles a split envelope in order', () => {
    const asm = new ChunkAssembler()
    expect(asm.push({ t: 'chunk', id: 1, data: 'hel' }).kind).toBe('waiting')
    expect(asm.push({ t: 'chunk', id: 1, data: 'lo' }).kind).toBe('waiting')
    const done = asm.push({ t: 'chunkEnd', id: 1, totalChars: 5, chunks: 2 })
    expect(done).toEqual({ kind: 'complete', text: 'hello' })
  })

  it('handles interleaved chunk ids', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 1, data: 'A' })
    asm.push({ t: 'chunk', id: 2, data: 'B' })
    expect(asm.push({ t: 'chunkEnd', id: 2, totalChars: 1, chunks: 1 })).toEqual({ kind: 'complete', text: 'B' })
    expect(asm.push({ t: 'chunkEnd', id: 1, totalChars: 1, chunks: 1 })).toEqual({ kind: 'complete', text: 'A' })
  })

  it('reports size mismatches as errors', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 3, data: 'abc' })
    const out = asm.push({ t: 'chunkEnd', id: 3, totalChars: 10, chunks: 1 })
    expect(out.kind).toBe('error')
  })

  it('errors on chunkEnd for an unknown id', () => {
    expect(new ChunkAssembler().push({ t: 'chunkEnd', id: 9, totalChars: 0, chunks: 0 }).kind).toBe('error')
  })

  it('reset clears partial state', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 1, data: 'x' })
    expect(asm.pendingCount).toBe(1)
    asm.reset()
    expect(asm.pendingCount).toBe(0)
  })
})

describe('NativeBridge', () => {
  let harness: ReturnType<typeof fakePort>
  let bridge: NativeBridge

  beforeEach(() => {
    vi.useFakeTimers()
    harness = fakePort()
    bridge = new NativeBridge(() => harness.port)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function respond(envelope: unknown) {
    harness.emit(envelope)
  }

  it('correlates rpc responses by cid', async () => {
    const p = bridge.rpc<string>('model/list', {})
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    const sent = harness.sent[0] as { t: string; cid: string; method: string }
    expect(sent.method).toBe('model/list')
    respond({ t: 'resp', cid: sent.cid, result: { data: [] } })
    await expect(p).resolves.toEqual({ data: [] })
  })

  it('rejects rpc on error responses with code and message', async () => {
    const p = bridge.rpc('turn/start')
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    const cid = (harness.sent[0] as { cid: string }).cid
    respond({ t: 'resp', cid, error: { code: -32001, message: 'Server overloaded; retry later' } })
    await expect(p).rejects.toThrow(/-32001.*overloaded/s)
  })

  it('times out rpc calls that never answer', async () => {
    const p = bridge.rpc('slow/method', {}, 50)
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    const assertion = expect(p).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
  })

  it('reassembles a chunked resp before dispatch', async () => {
    const payload = JSON.stringify({ x: 'y'.repeat(1000) })
    const parts = [payload.slice(0, 400), payload.slice(400)]
    const p = bridge.rpc<Record<string, string>>('big/thing')
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    const cid = (harness.sent[0] as { cid: string }).cid
    // The host chunks the SERIALIZED envelope; emulate that.
    const envelope = JSON.stringify({ t: 'resp', cid, result: { x: 'y'.repeat(1000) } })
    const mid = Math.floor(envelope.length / 2)
    harness.emit({ t: 'chunk', id: 77, data: envelope.slice(0, mid) })
    harness.emit({ t: 'chunk', id: 77, data: envelope.slice(mid) })
    harness.emit({ t: 'chunkEnd', id: 77, totalChars: envelope.length, chunks: 2 })
    void parts
    const res = await p
    expect(res.x).toHaveLength(1000)
  })

  it('forwards codex requests and notifications to handlers', () => {
    const req = vi.fn()
    const notif = vi.fn()
    bridge.onCodexRequest = req
    bridge.onNotification = notif
    bridge.ensureConnected() // registers port listeners
    respond({ t: 'req', rid: 5, method: 'item/tool/call', params: { tool: 'notion_fetch' } })
    respond({ t: 'notif', method: 'item/started', params: { item: { type: 'reasoning' } } })
    expect(req).toHaveBeenCalledWith({ rid: 5, method: 'item/tool/call', params: { tool: 'notion_fetch' } })
    expect(notif).toHaveBeenCalledOnce()
  })

  it('fails pending rpcs when the port disconnects and signals the handler', async () => {
    let disconnectedSignal = 0
    bridge.onBridgeDisconnected = () => disconnectedSignal++
    const p = bridge.rpc('turn/start')
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    harness.emitDisconnect()
    await expect(p).rejects.toThrow(/disconnected/)
    expect(disconnectedSignal).toBe(1)
    expect(bridge.isConnected).toBe(false)
  })

  it('reconnects transparently after a disconnect', async () => {
    bridge.ensureConnected()
    harness.emitDisconnect()
    bridge.rpc('initialize').catch(() => undefined)
    expect(bridge.isConnected).toBe(true)
  })

  it('ping correlates through the __cid echo', async () => {
    const p = bridge.ping()
    await vi.waitFor(() => expect(harness.sent.length).toBeGreaterThan(0))
    const cid = (harness.sent[0] as { cid: string }).cid
    harness.emit({ t: 'pong', __cid: cid, codex: { found: true, version: '9.9.9' }, spawn: { state: 'running', restarts: 0 } })
    const pong = await p
    expect(pong.codex.version).toBe('9.9.9')
  })
})
