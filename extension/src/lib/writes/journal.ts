import type { IDBPDatabase } from 'idb'

export interface JournalEntry {
  id: string
  ts: number
  threadId: string
  turnId: string
  status: 'applied' | 'undone' | 'failed'
  tool: string
  args: Record<string, unknown>
  kind: string
  preImage?: unknown
  inverse?: { tool: string; args: Record<string, unknown> }
  notUndoableReason?: string
  targetPageId?: string
}

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>
  list(): Promise<JournalEntry[]>
  remove?(id: string): Promise<void>
}

export function memoryJournalStore(): JournalStore {
  let entries: JournalEntry[] = []
  return {
    async append(entry) {
      entries.push(entry)
    },
    async list() {
      return [...entries]
    },
    async remove(id) {
      entries = entries.filter((e) => e.id !== id)
    },
  }
}

export function idbJournalStore(db: () => Promise<IDBPDatabase>): JournalStore {
  return {
    async append(entry) {
      await (await db()).put('journal', entry)
    },
    async list() {
      return await (await db()).getAll('journal') as JournalEntry[]
    },
    async remove(id) {
      await (await db()).delete('journal', id)
    },
  }
}

export class MutationJournal {
  private threadId: string | null = null
  private turnId: string | null = null

  constructor(private readonly store: JournalStore = memoryJournalStore()) {}

  setThread(threadId: string): void {
    this.threadId = threadId
    this.turnId = crypto.randomUUID()
  }

  async record(input: Omit<JournalEntry, 'id' | 'ts' | 'threadId' | 'turnId' | 'status'>): Promise<JournalEntry> {
    const entry: JournalEntry = {
      ...input,
      id: crypto.randomUUID(),
      ts: Date.now(),
      threadId: this.threadId ?? 'unscoped',
      turnId: this.turnId ?? crypto.randomUUID(),
      status: 'applied',
    }
    await this.store.append(entry)
    return entry
  }

  /** Newest-first for the undo UI (MVP §6.5). */
  async newestFirst(): Promise<JournalEntry[]> {
    const entries = await this.store.list()
    return entries.filter((entry) => this.threadId == null || entry.threadId === this.threadId).reverse()
  }

  /** Entries that carry a runnable inverse. */
  async undoable(): Promise<JournalEntry[]> {
    return (await this.newestFirst()).filter((e) => e.inverse != null)
  }

  /** Removes an entry after it was undone (or explicitly dismissed). */
  async drop(id: string): Promise<void> {
    await this.store.remove?.(id)
  }
}
