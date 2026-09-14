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
    port.onMessage.addListener((raw) => { if (this.port === port) this.onEnvelope(raw) })
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      const wasConnected = !this.disconnected
      this.disconnected = true
      this.port = null
      this.assembler.reset()
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
    this.assembler.reset()
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
        // Bounded diagnostic only: never echo attacker-controlled chunk data.
        console.error('[nox] chunk reassembly failed:', result.message)
        return
      }
      try {
        this.dispatch(JSON.parse(result.text))
      } catch {
        console.error('[nox] reassembled envelope was not JSON (preview):', result.text.slice(0, 200))
      }
      return
    }
    this.dispatch(raw)
  }

  private dispatch(envelope: unknown): void {
    if (typeof envelope !== 'object' || envelope === null) return
    const env = envelope as Record<string, unknown> & { t?: unknown }

    if (env.t === 'resp') {
      if (!isValidCid(env.cid)) return
      const pending = this.pending.get(env.cid)
      if (!pending) return
      this.pending.delete(env.cid)
      clearTimeout(pending.timer)
      if (env.error !== undefined) {
        if (!isRecord(env.error) || typeof env.error.code !== 'number' || !Number.isFinite(env.error.code) || typeof env.error.message !== 'string') {
          pending.reject(new Error('[malformed] bridge error payload'))
          return
        }
        pending.reject(new Error(`[${env.error.code}] ${env.error.message.slice(0, 500)}`))
        return
      }
      pending.resolve(env.result)
      return
    }

    if (env.__cid !== undefined && env.t === 'pong') {
      // Ping responses carry the synthetic cid back.
      if (!isValidCid(env.__cid)) return
      const pending = this.pending.get(env.__cid)
      if (pending) {
        this.pending.delete(env.__cid)
        clearTimeout(pending.timer)
        pending.resolve(envelope as unknown)
        return
      }
      if (!isValidPong(envelope)) return
      this.onPong?.(envelope as unknown as Extract<BridgeEnvelope, { t: 'pong' }>)
      return
    }

    if (env.t === 'req') {
      const rid = env.rid
      if (!isValidRid(rid)) {
        console.error('[nox] dropping req with invalid rid')
        return
      }
      if (typeof env.method !== 'string' || env.method.length === 0 || env.method.length > 256) {
        this.replyMalformed(rid, 'invalid method')
        return
      }
      if (env.params !== undefined && !isRecord(env.params)) {
        this.replyMalformed(rid, 'invalid params')
        return
      }
      this.onCodexRequest?.({ rid, method: env.method, params: (env.params ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'notif') {
      if (typeof env.method !== 'string' || env.method.length === 0 || env.method.length > 256) return
      if (env.params !== undefined && !isRecord(env.params)) return
      this.onNotification?.({ method: env.method, params: (env.params ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'status') {
      if (typeof env.state !== 'string' || env.state.length === 0 || env.state.length > 64) return
      if (env.detail !== undefined && !isRecord(env.detail)) return
      this.onStatus?.({ state: env.state, detail: (env.detail ?? {}) as Record<string, unknown> })
      return
    }

    if (env.t === 'pong') {
      if (!isValidPong(envelope)) return
      this.onPong?.(envelope as unknown as Extract<BridgeEnvelope, { t: 'pong' }>)
    }
    // Unknown discriminants are dropped silently: no handler, no coercion.
  }

  /**
   * Bounded correlated error for a malformed Codex→client request. Only used
   * when `rid` itself is a valid correlation id; otherwise the frame is
   * dropped with no reply. Never echoes attacker-controlled content.
   */
  private replyMalformed(rid: number, reason: 'invalid method' | 'invalid params'): void {
    try {
      this.port?.postMessage({
        t: 'tool-response',
        rid,
        result: { success: false, contentItems: [{ type: 'inputText', text: `MALFORMED_REQUEST: ${reason}. No changes were made.` }] },
      })
    } catch {
      // Port failure already surfaces via disconnect handling.
    }
  }

  onCodexRequest: ((req: { rid: number; method: string; params: Record<string, unknown> }) => void) | null = null
  onNotification: ((n: { method: string; params: Record<string, unknown> }) => void) | null = null
  onStatus: ((s: { state: string; detail: Record<string, unknown> }) => void) | null = null
  onPong: ((p: Extract<BridgeEnvelope, { t: 'pong' }>) => void) | null = null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Bridge `cid` values are `c` + integer (e.g. `c12`); never coerce numbers. */
function isValidCid(v: unknown): v is string {
  return typeof v === 'string' && /^c\d{1,16}$/.test(v)
}

/** Codex request ids are finite non-negative integers. */
function isValidRid(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER
}

function isValidPong(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false
  const codex = (envelope as Record<string, unknown>).codex
  const spawn = (envelope as Record<string, unknown>).spawn
  return isRecord(codex) && isRecord(spawn)
}
