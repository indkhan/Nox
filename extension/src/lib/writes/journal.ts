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
  callId?: string
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
      entries = [...entries.filter((e) => e.id !== entry.id), entry]
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
  private undoInFlight = false
  private lastTimestamp = 0
  private scopeActive = false
  private recordQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: JournalStore = memoryJournalStore()) {}

  setThread(threadId: string): void {
    this.threadId = threadId
    this.scopeActive = true
    this.turnId = crypto.randomUUID()
  }

  scopeThread(threadId: string | null): void {
    this.threadId = threadId
    this.scopeActive = true
  }

  record(input: Omit<JournalEntry, 'id' | 'ts' | 'threadId' | 'turnId' | 'status'>): Promise<JournalEntry> {
    const task = this.recordQueue.then(async () => {
      const persisted = await this.store.list()
      const persistedMax = persisted.reduce((max, entry) => Math.max(max, entry.ts), 0)
      this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1, persistedMax + 1)
      const entry: JournalEntry = {
        ...input,
        id: crypto.randomUUID(),
        ts: this.lastTimestamp,
        threadId: this.threadId ?? 'unscoped',
        turnId: this.turnId ?? crypto.randomUUID(),
        status: 'applied',
      }
      await this.store.append(entry)
      return entry
    })
    this.recordQueue = task.then(() => undefined, () => undefined)
    return task
  }

  /** Newest-first for the undo UI (MVP §6.5). */
  async newestFirst(): Promise<JournalEntry[]> {
    const entries = await this.store.list()
    if (this.scopeActive && this.threadId == null) return []
    return entries
      .filter((entry) => !this.scopeActive || entry.threadId === this.threadId)
      .sort((a, b) => b.ts - a.ts)
  }

  /** Entries that carry a runnable inverse. */
  async undoable(): Promise<JournalEntry[]> {
    return (await this.newestFirst()).filter((e) => e.status === 'applied' && e.inverse != null)
  }

  async newestForThread(threadId: string): Promise<JournalEntry[]> {
    return (await this.store.list()).filter((entry) => entry.threadId === threadId).sort((a, b) => b.ts - a.ts)
  }

  async setStatus(id: string, status: JournalEntry['status']): Promise<void> {
    const entry = (await this.store.list()).find((candidate) => candidate.id === id)
    if (entry) await this.store.append({ ...entry, status })
  }

  async claimUndo(id?: string): Promise<JournalEntry | null> {
    if (this.undoInFlight) return null
    this.undoInFlight = true
    const entry = (await this.undoable()).find((candidate) => id == null || candidate.id === id) ?? null
    if (!entry) this.undoInFlight = false
    return entry
  }

  releaseUndo(): void {
    this.undoInFlight = false
  }

  /** Removes an entry after it was undone (or explicitly dismissed). */
  async drop(id: string): Promise<void> {
    await this.store.remove?.(id)
  }
}
