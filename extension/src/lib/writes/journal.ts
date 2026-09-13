import type { IDBPDatabase } from 'idb'

/** Durable operation outcome. `pending` precedes dispatch; `unknown` means dispatch may have happened. */
export type OperationStatus = 'pending' | 'applied' | 'failed' | 'unknown' | 'undone'

/**
 * Runtime scope captured synchronously when an intent is enqueued — never
 * from model fields and never from mutable journal state at a later await.
 */
export interface IntentScope {
  threadId: string
  turnId: string
  workspaceId: string | null
  connectionGeneration: string | null
  ownerGeneration: string | null
}

export interface JournalEntry {
  id: string
  ts: number
  threadId: string
  turnId: string
  status: OperationStatus
  tool: string
  /** Frozen provider arguments actually sent (validated local fields removed). */
  args: Record<string, unknown>
  kind: string
  /** Absent on legacy rows, which must restore without invented scope. */
  scope?: IntentScope
  preImage?: unknown
  inverse?: { tool: string; args: Record<string, unknown> }
  notUndoableReason?: string
  targetPageId?: string
  callId?: string
  /** Undo intents link to their original operation id. */
  undoOf?: string
  /** Originals locked while an undo intent is pending or unresolved. */
  reservedByUndoOpId?: string
  /** Human inspection timestamp: lifts the conflict block, never rewrites the outcome. */
  reviewedAt?: number
  reviewNote?: string
  /** Cancel stage, error codes, verification notes — never a success promise the store could not save. */
  outcomeDetail?: string
}

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>
  list(): Promise<JournalEntry[]>
  get?(id: string): Promise<JournalEntry | undefined>
  listForThread?(threadId: string): Promise<JournalEntry[]>
  /**
   * Reserve an applied original for undo and persist the linked undo intent
   * atomically. Returns the original when reserved, null when it is no
   * longer applied, has no inverse, or is already reserved.
   */
  reserveUndo?(originalId: string, undoEntry: JournalEntry): Promise<JournalEntry | null>
}

function isReservable(original: JournalEntry | undefined): original is JournalEntry {
  return !!original && original.status === 'applied' && original.inverse != null && original.reservedByUndoOpId == null
}

export function memoryJournalStore(): JournalStore {
  let entries: JournalEntry[] = []
  const find = (id: string) => entries.find((e) => e.id === id)
  return {
    async append(entry) {
      entries = [...entries.filter((e) => e.id !== entry.id), entry]
    },
    async list() {
      return [...entries]
    },
    async get(id) {
      return find(id)
    },
    async listForThread(threadId) {
      return entries.filter((e) => e.threadId === threadId)
    },
    async reserveUndo(originalId, undoEntry) {
      const original = find(originalId)
      if (!isReservable(original)) return null
      const reserved = { ...original, reservedByUndoOpId: undoEntry.id }
      entries = [...entries.filter((e) => e.id !== original.id && e.id !== undoEntry.id), reserved, undoEntry]
      return original
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
    async get(id) {
      return await (await db()).get('journal', id) as JournalEntry | undefined
    },
    async listForThread(threadId) {
      return await (await db()).getAllFromIndex('journal', 'by_thread', threadId) as JournalEntry[]
    },
    async reserveUndo(originalId, undoEntry) {
      // One local transaction: a concurrent reserver either sees the
      // reservation or wins it — never a double claim.
      const connection = await db()
      const tx = connection.transaction('journal', 'readwrite')
      const store = tx.objectStore('journal')
      const original = await store.get(originalId) as JournalEntry | undefined
      if (!isReservable(original)) {
        await tx.done
        return null
      }
      await store.put({ ...original, reservedByUndoOpId: undoEntry.id })
      await store.put(undoEntry)
      await tx.done
      return original
    },
  }
}

export class MutationJournal {
  private threadId: string | null = null
  private turnId: string | null = null
  // Per-instance only: duplicate undo across panels is serialized by the
  // gate's re-validation, but atomic cross-window reservation arrives with
  // durable intent. Do not treat this flag as cross-window coordination.
  private undoInFlight = false
  private lastTimestamp = 0
  private scopeActive = false
  private recordQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: JournalStore = memoryJournalStore()) {}

  setThread(threadId: string | null): void {
    this.threadId = threadId
    this.scopeActive = true
    this.turnId = threadId == null ? null : crypto.randomUUID()
  }

  scopeThread(threadId: string | null): void {
    this.threadId = threadId
    this.scopeActive = true
  }

  /** Synchronous runtime scope snapshot for intent capture at enqueue time. */
  captureScope(): { threadId: string | null; turnId: string | null } {
    return { threadId: this.threadId, turnId: this.turnId }
  }

  record(input: Omit<JournalEntry, 'id' | 'ts' | 'threadId' | 'turnId' | 'status'>): Promise<JournalEntry> {
    const task = this.recordQueue.then(async () => {
      // No full-store scan: timestamps are local high-water marks and IDs
      // are unique, with a deterministic (ts, id) tie-breaker for order.
      this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
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

  /**
   * Persist a pending intent before any external effect. Throws on storage
   * failure so the caller makes zero external calls.
   */
  async beginIntent(input: {
    tool: string
    args: Record<string, unknown>
    kind: string
    scope: IntentScope
    preImage?: unknown
    targetPageId?: string
    callId?: string
    undoOf?: string
  }): Promise<JournalEntry> {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    const entry: JournalEntry = {
      id: crypto.randomUUID(),
      ts: this.lastTimestamp,
      threadId: input.scope.threadId,
      turnId: input.scope.turnId,
      status: 'pending',
      tool: input.tool,
      args: input.args,
      kind: input.kind,
      scope: { ...input.scope },
      preImage: input.preImage,
      targetPageId: input.targetPageId,
      callId: input.callId,
      undoOf: input.undoOf,
    }
    await this.store.append(entry)
    return entry
  }

  /**
   * Settle a pending intent under the same id. Returns null when the row is
   * missing, so the caller can show a recovery warning instead of promising
   * durable information the store could not save.
   */
  async settleIntent(id: string, update: {
    status: 'applied' | 'failed' | 'unknown' | 'undone'
    outcomeDetail?: string
    inverse?: { tool: string; args: Record<string, unknown> }
    notUndoableReason?: string
    reservedByUndoOpId?: string | null
  }): Promise<JournalEntry | null> {
    const entry = await this.readEntry(id)
    if (!entry) return null
    const settled: JournalEntry = {
      ...entry,
      status: update.status,
      outcomeDetail: update.outcomeDetail ?? entry.outcomeDetail,
      inverse: update.inverse ?? entry.inverse,
      notUndoableReason: update.notUndoableReason ?? entry.notUndoableReason,
    }
    if (update.reservedByUndoOpId !== undefined) {
      if (update.reservedByUndoOpId == null) delete settled.reservedByUndoOpId
      else settled.reservedByUndoOpId = update.reservedByUndoOpId
    }
    await this.store.append(settled)
    return settled
  }

  /**
   * Atomically reserve an applied original for undo and persist the linked
   * undo intent. Returns null when the original is no longer reservable, so
   * a second undo attempt fails without transport.
   */
  async beginUndoReservation(originalId: string, undoInput: {
    tool: string
    args: Record<string, unknown>
    kind: string
    scope: IntentScope
    targetPageId?: string
  }): Promise<{ original: JournalEntry; undo: JournalEntry } | null> {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    const undo: JournalEntry = {
      id: crypto.randomUUID(),
      ts: this.lastTimestamp,
      threadId: undoInput.scope.threadId,
      turnId: undoInput.scope.turnId,
      status: 'pending',
      tool: undoInput.tool,
      args: undoInput.args,
      kind: undoInput.kind,
      scope: { ...undoInput.scope },
      targetPageId: undoInput.targetPageId,
      undoOf: originalId,
    }
    if (this.store.reserveUndo) {
      const original = await this.store.reserveUndo(originalId, undo)
      return original ? { original, undo } : null
    }
    // Fallback stores serialize callers without a shared transaction; the
    // gate's serial runner still prevents same-process double claims.
    const original = await this.readEntry(originalId)
    if (!isReservable(original)) return null
    await this.store.append({ ...original, reservedByUndoOpId: undo.id })
    await this.store.append(undo)
    return { original, undo }
  }

  /** Release a reservation only when it still belongs to the given undo op. */
  async releaseUndoReservation(originalId: string, undoOpId: string): Promise<void> {
    const entry = await this.readEntry(originalId)
    if (entry?.reservedByUndoOpId === undoOpId) {
      await this.store.append({ ...entry, reservedByUndoOpId: undefined })
    }
  }

  /** Durable human inspection: lifts the conflict block, never rewrites the outcome. */
  async markReviewed(id: string, note?: string): Promise<boolean> {
    const entry = await this.readEntry(id)
    if (!entry) return false
    await this.store.append({ ...entry, reviewedAt: Date.now(), reviewNote: note })
    return true
  }

  /** Unresolved, unreviewed operations in scope: blockers for new conflicting work. */
  async unresolvedInScope(threadId: string | null, excludeIds: Set<string> = new Set()): Promise<JournalEntry[]> {
    if (threadId == null) return []
    const entries = await this.listScoped(threadId)
    return entries.filter((entry) =>
      (entry.status === 'pending' || entry.status === 'unknown') &&
      entry.reviewedAt == null &&
      !excludeIds.has(entry.id),
    )
  }

  async getEntry(id: string): Promise<JournalEntry | undefined> {
    return this.readEntry(id)
  }

  /** Newest-first for the undo UI (MVP §6.5). */
  async newestFirst(): Promise<JournalEntry[]> {
    if (this.scopeActive && this.threadId == null) return []
    const entries = this.scopeActive && this.threadId != null
      ? await this.listScoped(this.threadId)
      : await this.store.list()
    return entries
      .filter((entry) => !this.scopeActive || entry.threadId === this.threadId)
      .sort(compareEntries)
  }

  /** Entries that carry a runnable inverse: applied, unreserved, unreviewed-agnostic. */
  async undoable(): Promise<JournalEntry[]> {
    return (await this.newestFirst()).filter((e) => e.status === 'applied' && e.inverse != null && e.reservedByUndoOpId == null)
  }

  async newestForThread(threadId: string): Promise<JournalEntry[]> {
    return (await this.listScoped(threadId)).sort(compareEntries)
  }

  async setStatus(id: string, status: JournalEntry['status']): Promise<void> {
    const entry = await this.readEntry(id)
    if (entry) await this.store.append({ ...entry, status })
  }

  async claimUndo(id?: string): Promise<JournalEntry | null> {
    if (this.undoInFlight) return null
    this.undoInFlight = true
    try {
      const entry = (await this.undoable()).find((candidate) => id == null || candidate.id === id) ?? null
      if (!entry) this.undoInFlight = false
      return entry
    } catch (e) {
      // A failed storage read must not wedge later undo behind a stale claim.
      this.undoInFlight = false
      throw e
    }
  }

  releaseUndo(): void {
    this.undoInFlight = false
  }

  private async readEntry(id: string): Promise<JournalEntry | undefined> {
    if (this.store.get) return this.store.get(id)
    return (await this.store.list()).find((candidate) => candidate.id === id)
  }

  private async listScoped(threadId: string): Promise<JournalEntry[]> {
    if (this.store.listForThread) return this.store.listForThread(threadId)
    return (await this.store.list()).filter((entry) => entry.threadId === threadId)
  }
}

/** Deterministic newest-first order: timestamp, then id tie-breaker. */
function compareEntries(a: JournalEntry, b: JournalEntry): number {
  if (b.ts !== a.ts) return b.ts - a.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
