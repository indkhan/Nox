import { openDB, type IDBPDatabase } from 'idb'
import type { ActivityItem } from '../agent/activity'
import { isDeletionPending, refreshDeletionState, defaultDeletionStore, type DeletionStore } from './deletion'

export const DB_NAME = 'nox'
export const DB_VERSION = 3

/**
 * One cached connection per panel document. Caching (instead of opening per
 * call) bounds connection objects and lets `blocking` close promptly: when
 * another context deletes or upgrades the database, IndexedDB fires
 * versionchange and this panel closes immediately instead of holding the
 * deletion blocked. The cache resets on open rejection, explicit close,
 * versionchange-close, and connection termination.
 */
let cachedOpen: Promise<IDBPDatabase> | null = null
let cachedConnection: IDBPDatabase | null = null

function resetCache(promise: Promise<IDBPDatabase> | null): void {
  if (cachedOpen === promise) {
    cachedOpen = null
    cachedConnection = null
  }
}

function closeCachedConnection(): void {
  const connection = cachedConnection
  cachedOpen = null
  cachedConnection = null
  if (connection) {
    try {
      connection.close()
    } catch {
      // Already closed or terminated; the cache reset is what matters.
    }
  }
}

export interface ThreadRow {
  id: string
  title: string
  codexThreadId?: string
  createdAt: number
  updatedAt: number
  mode: 'ask' | 'auto'
  workspaceId?: string
  pinned: boolean
}

export interface MessageRow {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  toolCalls?: Array<{ tool: string; args: unknown }>
  usage?: Record<string, number>
  activity?: ActivityItem[]
  turnStatus?: 'streaming' | 'complete' | 'interrupted' | 'failed'
  error?: string
  ts: number
}

/** Versioned migration chain (MVP §8). Add upgrade blocks below, never edit v1. */
function migrations(db: IDBPDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const threads = db.createObjectStore('threads', { keyPath: 'id' })
    threads.createIndex('by_updated', 'updatedAt')
    threads.createIndex('by_pinned', 'pinned')

    const messages = db.createObjectStore('messages', { keyPath: 'id' })
    messages.createIndex('by_thread', 'threadId')
    messages.createIndex('by_ts', 'ts')

    db.createObjectStore('journal', { keyPath: 'id' })
      .createIndex('by_thread', 'threadId')

    db.createObjectStore('pageCache', { keyPath: 'pageId' })
    db.createObjectStore('mentionCache', { keyPath: 'pageId' })

    const attachments = db.createObjectStore('attachments', { keyPath: 'id' })
    attachments.createIndex('by_thread', 'threadId')
  }
  // v2 stores structured activity inside existing message records; no new store is required.
}

export async function openNoxDB(store: DeletionStore = defaultDeletionStore()): Promise<IDBPDatabase> {
  if (cachedOpen) return cachedOpen
  // Refresh on miss only: the cached connection implies a recent check, and
  // close paths (explicit, blocking, terminated) reset the cache.
  let deleting = false
  try {
    deleting = await refreshDeletionState(store)
  } catch {
    deleting = isDeletionPending()
  }
  if (deleting) {
    throw new Error('DELETION_PENDING: Nox data is being deleted — close other Nox windows to finish, then retry.')
  }
  const promise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      migrations(db, oldVersion)
      if (oldVersion < 3) {
        db.deleteObjectStore('pageCache')
        db.deleteObjectStore('mentionCache')
        transaction.objectStore('threads').deleteIndex('by_updated')
        transaction.objectStore('threads').deleteIndex('by_pinned')
        transaction.objectStore('messages').deleteIndex('by_ts')
      }
    },
    blocking: () => {
      closeCachedConnection()
    },
    terminated: () => {
      resetCache(promise)
    },
  })
  cachedOpen = promise
  try {
    cachedConnection = await promise
  } catch (error) {
    resetCache(promise)
    throw error
  }
  return cachedConnection
}

/** Close this panel's cached connection, if any. Other contexts are unaffected. */
export function closeNoxDBConnections(): void {
  closeCachedConnection()
}

/** Test-only: close and drop the cache so tests start isolated. */
export function __resetConnectionCacheForTests(): void {
  closeCachedConnection()
}
