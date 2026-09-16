/**
 * Cooperative storage-deletion protocol (Epoch 09 / M9).
 *
 * One panel's "Delete all data" must not spin forever because another open
 * panel holds IndexedDB connections, and other panels must learn about the
 * deletion even if they miss the transient notification. Two mechanisms work
 * together:
 *
 * 1. A durable tombstone (`nox.deletion` in chrome.storage.session): written
 *    before connections close, cleared after deletion completes. A panel that
 *    missed the live event still sees the mark on its next state refresh and
 *    refuses to (re)open the database while it stands.
 * 2. Listener notification for panels that are already open: storage change
 *    events plus explicit local transitions.
 *
 * The tombstone carries a timestamp: a mark older than DELETION_STALE_MS
 * (e.g. left by a panel that crashed mid-deletion) is treated as stale and
 * cleared, so one crash cannot brick history forever. Deletion state lives
 * outside any webpage message: only extension contexts observe it.
 */

export interface DeletionMark {
  state: 'deleting'
  /** Monotonic per-writer generation for debugging successive deletions. */
  generation: number
  /** Wall-clock milliseconds; stale marks are ignored and cleared. */
  ts: number
}

export const DELETION_KEY = 'nox.deletion'

/** A tombstone older than this is presumed left by a crashed deleter. */
export const DELETION_STALE_MS = 5 * 60 * 1000

/** Minimal storage surface for the tombstone; production uses session storage. */
export interface DeletionStore {
  get(): Promise<DeletionMark | null>
  set(mark: DeletionMark): Promise<void>
  clear(): Promise<void>
  /** Live push for panels already open; may miss events (tombstone covers). */
  onChange(callback: () => void): () => void
}

type Listener = () => void

const listeners = new Set<Listener>()
let localPending = false
let lastGeneration = 0

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One failing observer must not break deletion coordination.
    }
  }
}

/** This panel's view of deletion state. True from mark-or-event until cleared. */
export function isDeletionPending(): boolean {
  return localPending
}

/** Subscribe to deletion pending/cleared transitions. Returns an unsubscribe. */
export function onDeletionNotice(callback: Listener): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function setLocalPending(pending: boolean): void {
  if (localPending === pending) return
  localPending = pending
  notify()
}

function isStale(mark: DeletionMark, now: number): boolean {
  return now - mark.ts > DELETION_STALE_MS
}

/**
 * Re-read the shared mark and converge local state. Safe to call often:
 * transitions notify exactly once. A stale mark is cleared so a crashed
 * deleter cannot block history forever.
 */
export async function refreshDeletionState(store: DeletionStore, now: number = Date.now()): Promise<boolean> {
  let mark: DeletionMark | null
  try {
    mark = await store.get()
  } catch {
    return localPending
  }
  if (mark == null || mark.state !== 'deleting') {
    setLocalPending(false)
    return false
  }
  if (isStale(mark, now)) {
    try {
      await store.clear()
    } catch {
      // Best effort; the next refresh retries.
    }
    setLocalPending(false)
    return false
  }
  if (mark.generation > lastGeneration) lastGeneration = mark.generation
  setLocalPending(true)
  return true
}

/** Mark storage as deleting before connections close. Returns the generation. */
export async function beginDeletion(store: DeletionStore, now: number = Date.now()): Promise<number> {
  const generation = lastGeneration + 1
  lastGeneration = generation
  try {
    await store.set({ state: 'deleting', generation, ts: now })
  } catch {
    // The local flag still protects this panel; other panels fall back to
    // versionchange-close plus their own refresh. Never block deletion here.
  }
  setLocalPending(true)
  return generation
}

/** Re-assert the mark after an operation that may have wiped it (e.g. a storage clear). */
export async function reassertDeletion(store: DeletionStore, generation: number, now: number = Date.now()): Promise<void> {
  if (!localPending) return
  try {
    await store.set({ state: 'deleting', generation, ts: now })
  } catch {
    // Best effort; the local flag still holds this panel.
  }
}

/** Clear the mark after deletion completes and release waiting panels. */
export async function endDeletion(store: DeletionStore): Promise<void> {
  try {
    await store.clear()
  } catch {
    // Best effort; staleness bounds the damage of a leftover mark.
  }
  setLocalPending(false)
}

/** Test-only reset for module flag state (tombstone store untouched). */
export function __resetDeletionStateForTests(): void {
  localPending = false
  lastGeneration = 0
  listeners.clear()
}

/**
 * Live push for already-open panels: storage events refresh local state.
 * Returns an unsubscribe. The tombstone (not the event) is the source of
 * truth, so a missed event is repaired on the next refresh/open.
 */
export function watchDeletionChanges(store: DeletionStore): () => void {
  void refreshDeletionState(store).catch(() => undefined)
  return store.onChange(() => {
    void refreshDeletionState(store).catch(() => undefined)
  })
}

/** Production tombstone store over chrome.storage.session. */
export function chromeSessionDeletionStore(): DeletionStore {
  const area = chrome.storage.session
  return {
    async get(): Promise<DeletionMark | null> {
      const result = await area.get(DELETION_KEY)
      const mark = result[DELETION_KEY] as DeletionMark | undefined
      return mark != null && typeof mark === 'object' ? mark : null
    },
    async set(mark: DeletionMark): Promise<void> {
      await area.set({ [DELETION_KEY]: mark })
    },
    async clear(): Promise<void> {
      await area.remove(DELETION_KEY)
    },
    onChange(callback: () => void): () => void {
      const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
        if (areaName === 'session' && DELETION_KEY in changes) callback()
      }
      chrome.storage.onChanged.addListener(listener)
      return () => chrome.storage.onChanged.removeListener(listener)
    },
  }
}

/**
 * Default store: session-backed in the extension, inert elsewhere (tests,
 * workers without chrome). Inert reads resolve null so the database stays
 * usable; real coordination always passes an explicit store.
 */
export function defaultDeletionStore(): DeletionStore {
  if (typeof chrome !== 'undefined' && chrome.storage?.session && chrome.storage?.onChanged) {
    return chromeSessionDeletionStore()
  }
  return {
    async get(): Promise<DeletionMark | null> {
      return null
    },
    async set(): Promise<void> {},
    async clear(): Promise<void> {},
    onChange(): () => void {
      return () => undefined
    },
  }
}
