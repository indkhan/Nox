import { describe, expect, it, vi } from 'vitest'
import { retryDelayFor, Scheduler, SEARCH_RPS } from '../src/lib/mcp/scheduler'
import { McpHttpError, McpRpcError } from '../src/lib/mcp/client'

class FakeClock {
  t = 0
  now = () => this.t
  async advance(ms: number) {
    this.t += ms
  }
}

function makeScheduler(over: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  const clock = new FakeClock()
  const sleeps: number[] = []
  const scheduler = new Scheduler({
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms)
      await clock.advance(ms)
    },
    ...over,
  })
  return { clock, sleeps, scheduler }
}

const ok = () => Promise.resolve('ok')

describe('Scheduler', () => {
  it('runs a call immediately when buckets are full', async () => {
    const { scheduler, sleeps } = makeScheduler()
    expect(await scheduler.schedule('global', ok)).toBe('ok')
    expect(sleeps).toHaveLength(0)
  })

  it('throttles the third immediate global call (3 rps → 1s of tokens)', async () => {
    const { clock, scheduler, sleeps } = makeScheduler()
    await scheduler.schedule('global', ok)
    await scheduler.schedule('global', ok)
    await scheduler.schedule('global', ok) // bucket drained
    const start = clock.t
    await scheduler.schedule('global', ok)
    expect(clock.t - start).toBeGreaterThanOrEqual(300)
    expect(sleeps.length).toBeGreaterThan(0)
  })

  it('gives search its own slower bucket', async () => {
    const { clock, scheduler } = makeScheduler()
    await scheduler.schedule('search', ok) // consumes the single pre-loaded token
    const start = clock.t
    await scheduler.schedule('search', ok)
    // next token arrives in ~2s at 0.5 rps
    expect(clock.t - start).toBeGreaterThanOrEqual(1900)
  })

  it('shares tokens across both buckets via the global budget', async () => {
    const { scheduler } = makeScheduler({ globalRps: 2 })
    await scheduler.schedule('search', ok)
    await scheduler.schedule('search', ok)
    let calls = 0
    await scheduler.schedule('global', async () => {
      calls++
      return null
    })
    expect(calls).toBe(1)
  })

  it('caps concurrency and drains waiters on release', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 2 })
    let running = 0
    let peak = 0
    const task = () =>
      scheduler.schedule('global', async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return null
      })
    await Promise.all(Array.from({ length: 6 }, task))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('propagates permanent errors without retrying', async () => {
    const { scheduler, sleeps } = makeScheduler()
    let calls = 0
    await expect(
      scheduler.schedule('global', () => {
        calls++
        throw new McpRpcError(-32600, 'bad request')
      }),
    ).rejects.toMatchObject({ code: -32600 })
    expect(calls).toBe(1)
    expect(sleeps).toHaveLength(0)
  })

  it('retries transient HTTP 5xx then succeeds', async () => {
    const { scheduler, sleeps } = makeScheduler()
    let calls = 0
    const result = await scheduler.schedule<string>('global', () => {
      calls++
      if (calls < 3) throw new McpHttpError(503, 'down')
      return Promise.resolve('recovered')
    })
    expect(result).toBe('recovered')
    expect(calls).toBe(3)
    expect(sleeps.length).toBe(2)
  })

  it('caps transient retries', async () => {
    const { scheduler } = makeScheduler()
    let calls = 0
    await expect(scheduler.schedule('global', async () => {
      calls++
      throw new McpHttpError(503, 'still down')
    })).rejects.toThrow('still down')
    expect(calls).toBe(4)
  })

  it('releases concurrency capacity while backing off', async () => {
    let resumeSleep!: () => void
    const sleeping = new Promise<void>((resolve) => { resumeSleep = resolve })
    const scheduler = new Scheduler({ globalRps: 100, maxConcurrent: 1, sleep: () => sleeping })
    let calls = 0
    const retrying = scheduler.schedule('global', async () => {
      if (calls++ === 0) throw new McpHttpError(503, 'retry')
      return 'done'
    })
    await vi.waitFor(() => expect(calls).toBe(1))
    await expect(scheduler.schedule('global', async () => 'second')).resolves.toBe('second')
    resumeSleep()
    await expect(retrying).resolves.toBe('done')
  })

  it('honors an already-aborted signal', async () => {
    const { scheduler } = makeScheduler()
    const controller = new AbortController()
    controller.abort()
    await expect(scheduler.schedule('global', ok, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts promptly during retry backoff', async () => {
    const controller = new AbortController()
    let calls = 0
    const scheduler = new Scheduler({ sleep: () => new Promise(() => undefined) })
    const pending = scheduler.schedule('global', async () => {
      calls++
      throw new McpHttpError(503, 'down')
    }, controller.signal)
    await vi.waitFor(() => expect(calls).toBe(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('honors Retry-After over exponential growth', async () => {
    const { scheduler, sleeps } = makeScheduler()
    let calls = 0
    const out = await scheduler.schedule('global', () => {
      calls++
      if (calls === 1) throw new McpHttpError(429, 'slow down', 4)
      return Promise.resolve('after-retry')
    })
    expect(out).toBe('after-retry')
    expect(sleeps[0]).toBeGreaterThanOrEqual(3500) // ~4 s ± jitter, not 500 ms
    expect(sleeps[0]).toBeLessThanOrEqual(4500)
  })

  it('retries JSON-RPC -32001 overload', async () => {
    const { scheduler } = makeScheduler()
    let calls = 0
    const out = await scheduler.schedule('search', () => {
      calls++
      if (calls === 1) throw new McpRpcError(-32001, 'Server overloaded; retry later')
      return Promise.resolve('done')
    })
    expect(out).toBe('done')
    expect(calls).toBe(2)
  })

  it('never lets a bulk run exceed its rate over time', async () => {
    const { clock, scheduler } = makeScheduler({ globalRps: 10, maxConcurrent: 10 })
    const n = 25
    const start = clock.t
    await Promise.all(Array.from({ length: n }, () => scheduler.schedule('global', ok)))
    // 25 calls at 10 rps ⇒ at least ceil((25-10)/10)=1.5 s of waiting.
    expect(clock.t - start).toBeGreaterThanOrEqual(1400)
  })

  it('exposes the verified search rate constant', () => {
    expect(SEARCH_RPS).toBe(0.5) // 30/min (RESEARCH §2.6)
  })
})

describe('retryDelayFor', () => {
  it('uses Retry-After seconds when provided', () => {
    const d = retryDelayFor(new McpHttpError(429, '', 5), 0)
    expect(d).toBeGreaterThanOrEqual(4500)
    expect(d).toBeLessThanOrEqual(5500)
  })

  it('grows exponentially with ±jitter for missing Retry-After', () => {
    const d0 = retryDelayFor(new McpHttpError(500, ''), 0)!
    const d3 = retryDelayFor(new McpHttpError(500, ''), 3)!
    expect(d0).toBeGreaterThanOrEqual(400)
    expect(d3).toBeGreaterThan(d0)
  })

  it('returns null for client errors and unknown shapes', () => {
    expect(retryDelayFor(new McpHttpError(403, 'Invalid Origin'), 0)).toBeNull()
    expect(retryDelayFor(new Error('x'), 0)).toBeNull()
    expect(retryDelayFor(new McpRpcError(-32600, 'bad'), 0)).toBeNull()
  })

  it('caps backoff at 30 s', () => {
    expect(retryDelayFor(new McpRpcError(-32001, 'overloaded'), 30)).toBeLessThanOrEqual(30_000)
  })
})
