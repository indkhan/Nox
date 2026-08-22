import { openDB, type IDBPDatabase } from 'idb'
import type { IDBDatabase } from '../../shared/idb-types'

export const DB_NAME = 'nox'
export const DB_VERSION = 1

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
  ts: number
}

export interface JournalRow {
  id: number
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
}

export async function openNoxDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      migrations(db as unknown as IDBDatabase, oldVersion)
    },
  })
}
