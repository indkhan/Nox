import { closeNoxDBConnections, openNoxDB } from './schema'
import { threadRepository, type ThreadRepository } from './repository'
import { OwnerLock } from './lock'
import { chromeArea } from '../chrome-storage'

export const historyRepo: ThreadRepository = threadRepository(openNoxDB)

/** One lock instance per panel document. */
export const ownerLock = new OwnerLock(chromeArea('session'))

export type WindowRole = 'owner' | 'viewer' | 'pending'

/**
 * Claims ownership for this window. Viewer windows still render history but
 * never start turns (MVP §8).
 */
export async function claimWindowRole(): Promise<WindowRole> {
  return (await ownerLock.acquire()) ? 'owner' : 'viewer'
}

/** Storage usage via the Storage API (extension origin quota is unlimited). */
export async function storageUsageBytes(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/** Nukes IndexedDB and both chrome.storage areas ("Delete all data"). */
export async function deleteAllData(): Promise<void> {
  closeNoxDBConnections()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nox')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Could not delete Nox database'))
    request.onblocked = () => reject(new Error('Close other Nox panels before deleting all data'))
  })
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
}
