import { closeNoxDBConnections, openNoxDB } from './schema'
import { beginDeletion, defaultDeletionStore, endDeletion, reassertDeletion, type DeletionStore } from './deletion'
import { threadRepository, type ThreadRepository } from './repository'

export const historyRepo: ThreadRepository = threadRepository(openNoxDB)

/** One lock instance per panel document. */
export type WindowRole = 'owner' | 'viewer' | 'pending'
let releaseWebLock: (() => void) | null = null

/**
 * Read-only runtime lease for the `nox-agent-owner` Web Lock. The mutation
 * gate reads this — never a mutable UI role — before dispatching any write,
 * upload effect, or undo. A fresh generation is minted on every acquisition
 * so an operation queued under an expired lease fails without transport.
 */
let currentRole: WindowRole = 'pending'
let ownerGeneration: string | null = null

export function getWindowRole(): WindowRole {
  return currentRole
}

export function getOwnerGeneration(): string | null {
  return ownerGeneration
}

export function isOwnerActive(): boolean {
  return currentRole === 'owner' && ownerGeneration != null
}

/** Test-only reset for the module lease state (no lock is held in tests). */
export function __resetWindowRoleForTests(): void {
  currentRole = 'pending'
  ownerGeneration = null
  releaseWebLock = null
}

/**
 * Claims ownership for this window. Viewer windows still render history but
 * never start turns (MVP §8).
 */
export async function claimWindowRole(): Promise<WindowRole> {
  if (navigator.locks) {
    const acquired = new Promise<boolean>((resolve) => {
      void navigator.locks.request('nox-agent-owner', { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
        resolve(lock != null)
        if (lock) await new Promise<void>((release) => { releaseWebLock = release })
      })
    })
    const owner = await acquired
    if (owner) {
      currentRole = 'owner'
      ownerGeneration = crypto.randomUUID()
      window.addEventListener('pagehide', () => { releaseWebLock?.(); releaseWebLock = null }, { once: true })
    } else {
      currentRole = 'viewer'
      ownerGeneration = null
    }
    return owner ? 'owner' : 'viewer'
  }
  // Unsupported browsers stay read-only rather than risking two owners via
  // a non-atomic storage fallback.
  currentRole = 'viewer'
  ownerGeneration = null
  return 'viewer'
}

/** Storage usage via the Storage API (extension origin quota is unlimited). */
export async function storageUsageBytes(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/** Dependencies for "Delete all data" (Epoch 09 / M9, Epoch 11 owns the rest). */
export interface DeleteAllDataDeps {
  /** Tombstone store for cross-panel deletion coordination. */
  deletionStore?: DeletionStore
  /**
   * Credential invalidation. Defaults to clearing both chrome.storage areas.
   * Runs BEFORE the database deletion so a blocked database never holds
   * tokens hostage. Epoch 11 replaces this with the shared serialized
   * credential-generation path; until then this named dependency is the
   * explicit seam (never wait on DB deletion for sign-out hygiene).
   */
  clearCredentials?: () => Promise<void>
  /** Fired when another context holds the database open (blocked, not failed). */
  onBlocked?: () => void
  /** Database deleter, injectable for deterministic blocked-state tests. */
  deleteDatabase?: (onBlocked?: () => void) => Promise<void>
}

/**
 * Nukes IndexedDB and both chrome.storage areas ("Delete all data").
 *
 * Order matters: mark deleting first (other panels cancel turns, close, and
 * stop reopening), close local connections, clear credentials promptly, then
 * delete the database — surfacing (not timing out) a blocked deletion — and
 * finally clear storage and lift the mark. The delete request keeps its real
 * lifecycle: blocked waits for a genuine outcome, never a false success.
 */
export async function deleteAllData(deps: DeleteAllDataDeps = {}): Promise<void> {
  const store = deps.deletionStore ?? defaultDeletionStore()
  const generation = await beginDeletion(store)
  try {
    closeNoxDBConnections()
    await (deps.clearCredentials ?? defaultClearCredentials)()
    // Storage clears may wipe the tombstone; re-assert it so late panels
    // still observe the in-flight deletion.
    await reassertDeletion(store, generation)
    await (deps.deleteDatabase ?? deleteNoxDatabase)(deps.onBlocked)
    await chrome.storage.local.clear()
    await chrome.storage.session.clear()
  } finally {
    await endDeletion(store)
  }
}

async function defaultClearCredentials(): Promise<void> {
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
}

function deleteNoxDatabase(onBlocked?: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nox')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Could not delete Nox database'))
    // A blocked deletion remains queued by IndexedDB and may later succeed;
    // surface the blocker ("another Nox window is keeping storage open") and
    // keep the UI pending until the request has a real success/error outcome.
    request.onblocked = () => onBlocked?.()
  })
}
