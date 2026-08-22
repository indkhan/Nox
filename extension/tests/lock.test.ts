import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnerLock } from '../src/lib/history/lock'
import { memoryStore } from '../src/lib/storage'

describe('OwnerLock', () => {
  let nowMs: number

  beforeEach(() => {
    vi.useFakeTimers()
    nowMs = 1_000_000
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeLock(session = memoryStore()) {
    return new OwnerLock(session, () => nowMs)
  }

  it('grants ownership to the first window', async () => {
    const lock = makeLock()
    expect(await lock.acquire()).toBe(true)
    await lock.release()
  })

  it('denies a second live window', async () => {
    const session = memoryStore()
    const first = new OwnerLock(session, () => nowMs, 'win-a')
    expect(await first.acquire()).toBe(true)

    const second = new OwnerLock(session, () => nowMs, 'win-b')
    expect(await second.acquire()).toBe(false)
    const owner = await second.owner()
    expect(owner?.windowId).toBe('win-a')
    await first.release()
  })

  it('elects only one owner when panels claim simultaneously', async () => {
    const session = memoryStore()
    const first = new OwnerLock(session, () => nowMs, 'win-a')
    const second = new OwnerLock(session, () => nowMs, 'win-b')
    const results = await Promise.all([first.acquire(), second.acquire()])
    expect(results.filter(Boolean)).toHaveLength(1)
    await first.release()
    await second.release()
  })

  it('lets a latecomer steal after the heartbeat goes stale (crash)', async () => {
    const session = memoryStore()
    const first = new OwnerLock(session, () => nowMs, 'win-a')
    await first.acquire()

    // Simulate crash: time passes with no renewal.
    nowMs += 60_000
    const second = new OwnerLock(session, () => nowMs, 'win-b')
    expect(await second.acquire()).toBe(true)
  })

  it('renews the heartbeat while held', async () => {
    const session = memoryStore()
    const first = new OwnerLock(session, () => nowMs, 'win-a')
    await first.acquire()
    nowMs += 4_000
    await vi.advanceTimersByTimeAsync(5_000) // one beat

    const second = new OwnerLock(session, () => nowMs, 'win-b')
    expect(await second.acquire()).toBe(false)
    await first.release()
  })

  it('release clears only our own claim', async () => {
    const session = memoryStore()
    const a = new OwnerLock(session, () => nowMs, 'win-a')
    await a.acquire()
    await a.release()
    expect((await session.get('nox.ownerLock'))['nox.ownerLock']).toBeUndefined()
  })
})

