import { openDB, type IDBPDatabase } from 'idb'
import type { IDBDatabase } from '../../shared/idb-types'
import type { ActivityItem } from '../agent/activity'

export const DB_NAME = 'nox'
export const DB_VERSION = 2
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
  turnStatus?: 'streaming' | 'complete' | 'interrupted'
  ts: number
}

export interface JournalRow {
  id: string
  threadId: string
  turnId: string
  tool: string
  args: unknown
  preImage?: unknown
  inverse?: { tool: string; args: Record<string, unknown> }
  status: 'applied' | 'undone' | 'failed'
}

/** Versioned migration chain (MVP §8). Add v2 blocks below, never edit v1. */
function migrations(db: IDBDatabase, oldVersion: number): void {
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
    upgrade(db, oldVersion) {
      migrations(db as unknown as IDBDatabase, oldVersion)
    },
  })
  openConnections.add(connection)
  return connection
}

export function closeNoxDBConnections(): void {
  for (const connection of openConnections) connection.close()
  openConnections.clear()
}
