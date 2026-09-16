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
  /**
   * Absolute timestamp (scheduler clock) bounding every wait: a token or
   * backoff wait that would run past it throws SchedulerDeadlineError
   * instead of sleeping through the turn deadline.
   */
  deadline?: number
  /** Called after capacity/rate admission, immediately before fn. */
  beforeInvoke?: () => void
}

/**
 * A rate-limit wait would run past the turn deadline, so the scheduler stops
 * instead of sleeping through it. Admission waits throw before (re)dispatch;
 * a mutation guard does not stay valid across a wait.
 */
export class SchedulerDeadlineError extends Error {
  constructor(waitMs: number, remainingMs: number) {
    super(
      `DEADLINE_EXCEEDED: a ${Math.ceil(waitMs)}ms rate-limit cooldown exceeds the ` +
        `${Math.max(0, Math.ceil(remainingMs))}ms left before the turn deadline; ` +
        'stopping instead of waiting past the deadline.',
    )
    this.name = 'SchedulerDeadlineError'
  }
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
    // Token-bucket burst capacities (not a strict rolling-window quota):
    // global holds 3 tokens at 3 rps; search holds 1 token at 0.5 rps, with
    // a floor of 1 so a single token is always reachable.
    return { capacity: Math.max(1, ratePerSecond), tokens: Math.max(1, ratePerSecond), lastRefill: this.now() }
  }

  private refill(bucket: BucketState, ratePerSecond: number): void {
    const t = this.now()
    const elapsedSeconds = (t - bucket.lastRefill) / 1000
    if (elapsedSeconds <= 0) return
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * ratePerSecond)
    bucket.lastRefill = t
  }

  private async acquire(bucketName: Bucket, signal?: AbortSignal, deadline?: number): Promise<void> {
    // A search call spends one token from each budget; everything else
    // spends the global budget only.
    const needed: Bucket[] = bucketName === 'search' ? ['global', 'search'] : ['global']
    for (;;) {
      signal?.throwIfAborted()
      for (const name of needed) this.refill(this.bucketState(name), this.rates[name])
      const lacking = needed.filter((name) => this.bucketState(name).tokens < 1)
      if (lacking.length === 0 && this.inFlight < this.maxConcurrent) {
        // Reserve every permit synchronously: a call runs only when
        // concurrency and all rate budgets hold together.
        for (const name of needed) this.bucketState(name).tokens -= 1
        this.inFlight += 1
        return
      }
      if (lacking.length > 0) {
        // Sleep for the longest token deficit without holding a concurrency
        // slot: nothing is reserved while waiting for tokens.
        const waitMs = Math.max(...lacking.map((name) =>
          Math.max(10, Math.ceil(((1 - this.bucketState(name).tokens) / this.rates[name]) * 1000)),
        ))
        this.throwIfPastDeadline(waitMs, deadline)
        await abortable(this.sleep(waitMs), signal)
        continue
      }
      // Tokens are ready but every concurrency slot is busy: queue fairly
      // for the next release, then recheck everything on wakeup.
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
  }

  private bucketState(bucket: Bucket): BucketState {
    return bucket === 'search' ? this.search : this.global
  }

  private throwIfPastDeadline(waitMs: number, deadline?: number): void {
    if (deadline == null) return
    const remainingMs = deadline - this.now()
    if (waitMs > remainingMs) {
      throw new SchedulerDeadlineError(waitMs, remainingMs)
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
      await this.acquire(bucket, signal, opts.deadline)
      // Abort between admission and invocation: the function never ran, so
      // no dispatch can be blamed on this call.
      signal?.throwIfAborted()
      try {
        opts.beforeInvoke?.()
      } catch (error) {
        this.release()
        throw error
      }
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
      this.throwIfPastDeadline(delay, opts.deadline)
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

  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    // An explicit server cooldown is a minimum: honor it in full instead of
    // capping it like locally generated backoff.
    return retryAfterSeconds * 1000 + jitter()
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
