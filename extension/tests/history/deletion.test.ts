import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginDeletion,
  endDeletion,
  isDeletionPending,
  onDeletionNotice,
  reassertDeletion,
  refreshDeletionState,
  __resetDeletionStateForTests,
  type DeletionMark,
  type DeletionStore,
} from '../../src/lib/history/deletion'

/** Memory tombstone store with observable writes (stands in for session storage). */
function memoryDeletionStore() {
  let mark: DeletionMark | null = null
  const listeners = new Set<() => void>()
  const events: string[] = []
  return {
    store: {
      get: async () => mark,
      set: async (next: DeletionMark) => {
        mark = next
        events.push(`set:${next.generation}`)
        for (const listener of [...listeners]) listener()
      },
      clear: async () => {
        mark = null
        events.push('clear')
        for (const listener of [...listeners]) listener()
      },
      onChange: (callback: () => void) => {
        listeners.add(callback)
        return () => {
          listeners.delete(callback)
        }
      },
    } satisfies DeletionStore,
    events,
    peek: () => mark,
  }
}

describe('cooperative deletion protocol (Epoch 09)', () => {
  beforeEach(() => {
    __resetDeletionStateForTests()
  })

  it('marks deleting, notifies once, and releases on completion', async () => {
    const { store, events } = memoryDeletionStore()
    const notices: boolean[] = []
    const unsubscribe = onDeletionNotice(() => void notices.push(isDeletionPending()))
    const generation = await beginDeletion(store)
    expect(generation).toBeGreaterThan(0)
    expect(isDeletionPending()).toBe(true)
    expect(events).toEqual([`set:${generation}`])
    await endDeletion(store)
    expect(isDeletionPending()).toBe(false)
    expect(events).toEqual([`set:${generation}`, 'clear'])
    // Exactly one transition each way, despite the store event echo.
    expect(notices).toEqual([true, false])
    unsubscribe()
  })

  it('observes a tombstone written by another panel without any live event', async () => {
    const { store } = memoryDeletionStore()
    // Another panel writes directly: this panel missed every transient event.
    await store.set({ state: 'deleting', generation: 7, ts: Date.now() })
    __resetDeletionStateForTests()
    expect(isDeletionPending()).toBe(false)
    expect(await refreshDeletionState(store)).toBe(true)
    expect(isDeletionPending()).toBe(true)
  })

  it('clears a stale tombstone left by a crashed deleter', async () => {
    const { store, events } = memoryDeletionStore()
    await store.set({ state: 'deleting', generation: 3, ts: Date.now() - 60 * 60 * 1000 })
    events.length = 0
    expect(await refreshDeletionState(store)).toBe(false)
    expect(isDeletionPending()).toBe(false)
    // The stale mark is removed so history is not bricked forever.
    expect(events).toEqual(['clear'])
  })

  it('re-asserts the mark after a storage wipe without dropping the local flag', async () => {
    const { store, events } = memoryDeletionStore()
    const generation = await beginDeletion(store)
    await store.clear() // e.g. a credential/storage clear mid-flow
    events.length = 0
    await reassertDeletion(store, generation)
    expect(isDeletionPending()).toBe(true)
    expect(events).toEqual([`set:${generation}`])
  })

  it('survives a failing tombstone store without blocking deletion', async () => {
    const failing: DeletionStore = {
      get: async () => {
        throw new Error('storage offline')
      },
      set: async () => {
        throw new Error('storage offline')
      },
      clear: async () => {
        throw new Error('storage offline')
      },
      onChange: () => () => undefined,
    }
    await beginDeletion(failing)
    expect(isDeletionPending()).toBe(true)
    expect(await refreshDeletionState(failing)).toBe(true)
    await endDeletion(failing)
    expect(isDeletionPending()).toBe(false)
  })

  it('unsubscribed observers stop receiving transitions', async () => {
    const { store } = memoryDeletionStore()
    let notices = 0
    const unsubscribe = onDeletionNotice(() => void notices++)
    unsubscribe()
    await beginDeletion(store)
    await endDeletion(store)
    expect(notices).toBe(0)
  })
})
