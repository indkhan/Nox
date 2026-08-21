export interface JournalEntry {
  id: number
  ts: number
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
  remove?(id: number): Promise<void>
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

export class MutationJournal {
  private nextId = 1

  constructor(private readonly store: JournalStore = memoryJournalStore()) {}

  async record(input: Omit<JournalEntry, 'id' | 'ts'>): Promise<JournalEntry> {
    const entry: JournalEntry = { ...input, id: this.nextId++, ts: Date.now() }
    await this.store.append(entry)
    return entry
  }

  /** Newest-first for the undo UI (MVP §6.5). */
  async newestFirst(): Promise<JournalEntry[]> {
    return (await this.store.list()).reverse()
  }

  /** Entries that carry a runnable inverse. */
  async undoable(): Promise<JournalEntry[]> {
    return (await this.newestFirst()).filter((e) => e.inverse != null)
  }

  /** Removes an entry after it was undone (or explicitly dismissed). */
  async drop(id: number): Promise<void> {
    await this.store.remove?.(id)
  }

  get size(): number {
    return this.nextId - 1
  }
}
