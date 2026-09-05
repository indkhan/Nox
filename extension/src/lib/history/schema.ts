import { openDB, type IDBPDatabase } from 'idb'
import type { ActivityItem } from '../agent/activity'

export const DB_NAME = 'nox'
export const DB_VERSION = 3
const openConnections = new Set<IDBPDatabase>()

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

export async function openNoxDB(): Promise<IDBPDatabase> {
  const connection = await openDB(DB_NAME, DB_VERSION, {
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
  })
  openConnections.add(connection)
  return connection
}

export function closeNoxDBConnections(): void {
  for (const connection of openConnections) connection.close()
  openConnections.clear()
}
