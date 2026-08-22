import { ChunkAssembler } from './frame'

/**
 * Native messaging host client. Envelope shapes come from bridge/PROTOCOL.md.
 * Uses an injectable port factory so tests can drive it without Chrome.
 */
export interface PortLike {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(cb: (message: unknown) => void): void }
  onDisconnect: { addListener(cb: () => void): void }
}

export type BridgeEnvelope =
  | { t: 'pong'; codex: { found: boolean; version?: string; path?: string; error?: string }; spawn: { state: string; restarts: number; uptimeMs: number }; stderrTail?: string; maxMessageBytes?: number }
  | { t: 'resp'; cid: string; result?: unknown; error?: { code: number; message: string } }
  | { t: 'req'; rid: number; method: string; params: Record<string, unknown> }
  | { t: 'notif'; method: string; params: Record<string, unknown> }
  | { t: 'status'; state: string; detail?: Record<string, unknown> }

const DEFAULT_RPC_TIMEOUT_MS = 600_000

export class NativeBridge {
  private port: PortLike | null = null
  private assembler = new ChunkAssembler()
  private nextCid = 0
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private disconnected = false

  constructor(
    private readonly connectPort: () => PortLike,
  ) {}

  get isConnected(): boolean {
    return this.port != null && !this.disconnected
  }

  ensureConnected(): void {
    if (this.isConnected) return
    this.disconnected = false
    this.assembler.reset()
    const port = this.connectPort()
    port.onMessage.addListener((raw) => this.onEnvelope(raw))
    port.onDisconnect.addListener(() => {
      const wasConnected = !this.disconnected
      this.disconnected = true
      this.port = null
      this.failAllPending('bridge port disconnected')
      if (wasConnected) this.onBridgeDisconnected?.()
    })
    this.port = port
  }

  onBridgeDisconnected: (() => void) | null = null

  /** Sends a request to Codex and resolves with its result. */
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    this.ensureConnected()
    const cid = `c${++this.nextCid}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid)
        reject(new Error(`bridge timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(cid, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.port!.postMessage({ t: 'rpc', cid, method, params: params ?? {} })
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.ensureConnected()
    this.port!.postMessage({ t: 'notify', method, params: params ?? {} })
  }

  /** Answers a Codex→client request (e.g. item/tool/call). */
  respondTool(rid: number, result: unknown): void {
    this.ensureConnected()
    this.port!.postMessage({ t: 'tool-response', rid, result })
  }

  ping(timeoutMs = 15_000): Promise<Extract<BridgeEnvelope, { t: 'pong' }>> {
    this.ensureConnected()
    const cid = `c${++this.nextCid}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid)
        reject(new Error('bridge ping timed out — is the native host installed?'))
      }, timeoutMs)
      this.pending.set(cid, {
        resolve: (v) => resolve(v as Extract<BridgeEnvelope, { t: 'pong' }>),
        reject,
        timer,
      })
      this.port!.postMessage({ t: 'ping', cid })
    })
  }

  disconnect(): void {
    this.port?.disconnect()
    this.port = null
    this.disconnected = true
    this.failAllPending('bridge closed by client')
  }

  private failAllPending(reason: string): void {
    for (const [cid, p] of [...this.pending.entries()]) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
      this.pending.delete(cid)
    }
  }

  private onEnvelope(raw: unknown): void {
    // Reassembly first: chunk/chunkEnd frames carry a serialized envelope.
    if (
      typeof raw === 'object' &&
      raw !== null &&
      ((raw as { t?: string }).t === 'chunk' || (raw as { t?: string }).t === 'chunkEnd')
    ) {
      const result = this.assembler.push(raw as never)
      if (result.kind === 'waiting') return
      if (result.kind === 'error') {
        console.error('[nox] chunk reassembly failed:', result.message)
        return
      }
      try {
        this.dispatch(JSON.parse(result.text))
      } catch (e) {
        console.error('[nox] reassembled envelope was not JSON:', e)
      }
      return
    }
    this.dispatch(raw)
  }

  private dispatch(envelope: unknown): void {
    if (typeof envelope !== 'object' || envelope === null) return
    const env = envelope as Record<string, unknown> & { t?: string }

    if (env.t === 'resp') {
      const cid = String(env.cid)
      const pending = this.pending.get(cid)
      if (!pending) return
      this.pending.delete(cid)
      clearTimeout(pending.timer)
      if (env.error) pending.reject(new Error(`[${(env.error as { code?: number }).code}] ${(env.error as { message?: string }).message}`))
      else pending.resolve(env.result)
      return
    }

    if (env.__cid !== undefined && env.t === 'pong') {
      // Ping responses carry the synthetic cid back.
      const cid = String(env.__cid)
      const pending = this.pending.get(cid)
      if (pending) {
        this.pending.delete(cid)
        clearTimeout(pending.timer)
        pending.resolve(envelope as unknown)
        return
      }
      this.onPong?.(envelope as unknown as Extract<BridgeEnvelope, { t: 'pong' }>)
      return
    }

    if (env.t === 'req') {
      this.onCodexRequest?.({ rid: Number(env.rid), method: String(env.method), params: (env.params ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'notif') {
      this.onNotification?.({ method: String(env.method), params: (env.params ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'status') {
      this.onStatus?.({ state: String(env.state), detail: (env.detail ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'pong') {
      this.onPong?.(envelope as unknown as Extract<BridgeEnvelope, { t: 'pong' }>)
    }
  }

  onCodexRequest: ((req: { rid: number; method: string; params: Record<string, unknown> }) => void) | null = null
  onNotification: ((n: { method: string; params: Record<string, unknown> }) => void) | null = null
  onStatus: ((s: { state: string; detail: Record<string, unknown> }) => void) | null = null
  onPong: ((p: Extract<BridgeEnvelope, { t: 'pong' }>) => void) | null = null
}
