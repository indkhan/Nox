import { isPreDispatchFailure, McpHttpError, McpRpcError } from './client'

export type Bucket = 'global' | 'search'

/** 180 req/min per user overall; notion-search is capped at 30/min (RESEARCH §2.6). */
export const GLOBAL_RPS = 3
export const SEARCH_RPS = 0.5
export const MAX_CONCURRENT = 3
export const MAX_RETRIES = 3

const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

/**
 * A non-retryable call failed after its function was invoked: exactly one
 * attempt ran, so a committed-then-failed mutation is indistinguishable
 * from a clean failure at this layer. The original failure is preserved as
 * `cause`. Reconciling (durable intent) must happen before any resubmission;
 * nothing here may replay the call.
 */
export class UncertainDispatchError extends Error {
  constructor(failure: unknown) {
    super(
      `UNCERTAIN_OUTCOME: ${failure instanceof Error ? failure.message : String(failure)} ` +
        'The request was attempted once and the result is unknown. ' +
        'Do not retry automatically; reconcile before resubmitting.',
      { cause: failure },
    )
    this.name = 'UncertainDispatchError'
  }
}

export interface SchedulerOptions {
  globalRps?: number
  searchRps?: number
  maxConcurrent?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

export interface ScheduleOptions {
  /**
   * Retry transient failures (HTTP 429/5xx, RPC -32001) with bounded
   * backoff. Established only for trusted known reads; mutations, upload
   * tickets, blob POSTs, undo, and unknown effects default to no retry.
   */
  retryable?: boolean
}

interface BucketState {
  capacity: number // tokens per second × window
  tokens: number
  lastRefill: number
}

/**
 * One queue for every MCP call (MVP §4): token buckets per class, a shared
 * concurrency cap, and — only for calls with established retry safety —
 * jittered exponential backoff on 429/5xx/-32001 that honors Retry-After.
 * Anything else runs exactly once; an ambiguous post-dispatch failure
 * surfaces as UncertainDispatchError instead of a silent replay.
 */
export class Scheduler {
  private readonly global: BucketState
  private readonly search: BucketState
  private inFlight = 0
  private readonly waiters: Array<() => void> = []
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxConcurrent: number
  private readonly rates: Record<Bucket, number>
  private readonly maxRetries: number

  constructor(opts: SchedulerOptions = {}) {
    this.rates = {
      global: opts.globalRps ?? GLOBAL_RPS,
      search: opts.searchRps ?? SEARCH_RPS,
    }
    this.now = opts.now ?? Date.now
    this.sleep =
      opts.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES
    this.global = this.emptyBucket(this.rates.global)
    this.search = this.emptyBucket(this.rates.search)
  }

  private emptyBucket(ratePerSecond: number): BucketState {
    // Burst capacity is a whole number ≥ 1 so a single token is always
    // reachable even for sub-1-rps buckets like search (0.5 rps).
    return { capacity: Math.max(1, ratePerSecond), tokens: Math.max(1, ratePerSecond), lastRefill: this.now() }
  }

  private refill(bucket: BucketState, ratePerSecond: number): void {
    const t = this.now()
    const elapsedSeconds = (t - bucket.lastRefill) / 1000
    if (elapsedSeconds <= 0) return
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * ratePerSecond)
    bucket.lastRefill = t
  }

  private async acquire(bucketName: Bucket, signal?: AbortSignal): Promise<void> {
    // Concurrency gate first: never more than MAX_CONCURRENT calls in flight.
    while (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { cleanup(); resolve() }
        const aborted = () => {
          const index = this.waiters.indexOf(ready)
          if (index >= 0) this.waiters.splice(index, 1)
          cleanup()
          reject(signal?.reason)
        }
        const cleanup = () => signal?.removeEventListener('abort', aborted)
        this.waiters.push(ready)
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
      })
    }
    for (;;) {
      const bucket = bucketName === 'search' ? this.search : this.global
      this.refill(bucket, this.rates[bucketName])
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        this.inFlight += 1
        return
      }
      const deficitMs = ((1 - bucket.tokens) / this.rates[bucketName]) * 1000
      await abortable(this.sleep(Math.max(10, Math.ceil(deficitMs))), signal)
    }
  }

  private release(): void {
    this.inFlight -= 1
    const waiter = this.waiters.shift()
    waiter?.()
  }

  /**
   * Runs `fn` under the scheduler. Retryable (known reads only): HTTP 429 /
   * 5xx and JSON-RPC -32001 ("Server overloaded") retry with bounded
   * backoff. Everything else runs exactly once — a post-dispatch failure
   * throws UncertainDispatchError, never a replay.
   */
  async schedule<T>(bucket: Bucket, fn: () => Promise<T>, signal?: AbortSignal, opts: ScheduleOptions = {}): Promise<T> {
    const retryable = opts.retryable ?? false
    let attempt = 0
    for (;;) {
      signal?.throwIfAborted()
      await this.acquire(bucket, signal)
      // Abort between admission and invocation: the function never ran, so
      // no dispatch can be blamed on this call.
      signal?.throwIfAborted()
      let delay: number | null = null
      try {
        return await fn()
      } catch (e) {
        if (!retryable) {
          // Exactly one attempt ran. A local pre-dispatch failure proves
          // nothing was sent; an ambiguous failure leaves the outcome
          // unknown. Declared provider rejections propagate as-is.
          if (isPreDispatchFailure(e)) throw e
          if (isAmbiguousFailure(e)) throw new UncertainDispatchError(e)
          throw e
        }
        delay = retryDelayFor(e, attempt)
        if (delay == null || attempt++ >= this.maxRetries) throw e
      } finally {
        this.release()
      }
      await abortable(this.sleep(delay), signal)
    }
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => { cleanup(); resolve(value) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

/**
 * True when a post-dispatch failure leaves the outcome unknown. Transient
 * HTTP/RPC failures may follow a server-side commit; network loss, lost
 * replies, parse errors, and post-dispatch aborts prove nothing either way.
 * Declared provider rejections (other HTTP statuses, malformed-request RPC
 * codes) prove refusal and propagate as-is instead.
 */
function isAmbiguousFailure(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return error.status === 429 || error.status >= 500
  }
  if (error instanceof McpRpcError) {
    return error.code === -32001 || error.code === -32603 || (error.code <= -32000 && error.code >= -32099)
  }
  return true
}

/** Milliseconds to back off, or null when the error must propagate. */
export function retryDelayFor(
  error: unknown,
  attempt: number,
): number | null {
  let status: number | null = null
  let rpcCode: number | null = null
  let retryAfterSeconds: number | null = null

  if (error instanceof McpHttpError) {
    status = error.status
    retryAfterSeconds = error.retryAfterSeconds
  } else if (error instanceof McpRpcError && error.code === -32001) {
    rpcCode = -32001
  } else {
    return null
  }

  const retryable = status === 429 || (status != null && status >= 500) || rpcCode === -32001
  if (!retryable) return null

  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds)) {
    return clampBackoff(retryAfterSeconds * 1000 + jitter())
  }
  const exponential = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** attempt)
  return clampBackoff(exponential + jitter())
}

function jitter(): number {
  // Positive jitter avoids synchronized retries without violating Retry-After.
  return 100 + Math.random() * 400
}

function clampBackoff(ms: number): number {
  return Math.min(MAX_BACKOFF_MS, Math.max(INITIAL_BACKOFF_MS, ms))
}
