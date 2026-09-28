import type { IDBPDatabase } from 'idb'
import { normalizeId } from '../../shared/notion-page'

/** Durable operation outcome. `pending` precedes dispatch; `unknown` means dispatch may have happened. */
export type OperationStatus = 'pending' | 'submitted' | 'applied' | 'failed' | 'unknown' | 'undone'

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
  verification?: 'verified' | 'unverified' | 'not-applicable'
  remoteTaskId?: string
}

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>
  list(): Promise<JournalEntry[]>
  get?(id: string): Promise<JournalEntry | undefined>
  listForThread?(threadId: string): Promise<JournalEntry[]>
  /** Read and replace one row in a single storage transaction; null leaves it unchanged. */
  update?(id: string, change: (entry: JournalEntry | undefined) => JournalEntry | null): Promise<JournalEntry | null>
  /**
   * Reserve an applied original for undo and persist the linked undo intent
   * atomically. Returns the original when reserved, null when it is no
   * longer applied, has no inverse, or is already reserved.
   */
  reserveUndo?(originalId: string, undoEntry: JournalEntry): Promise<JournalEntry | null>
}

function isReservable(original: JournalEntry | undefined): original is JournalEntry {
  return !!original && original.status === 'applied' && original.verification === 'verified' && original.inverse != null && original.reservedByUndoOpId == null
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
    async update(id, change) {
      const next = change(find(id))
      if (next) entries = [...entries.filter((e) => e.id !== id), next]
      return next
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
    async update(id, change) {
      const tx = (await db()).transaction('journal', 'readwrite')
      const store = tx.objectStore('journal')
      const next = change(await store.get(id) as JournalEntry | undefined)
      if (next) await store.put(next)
      await tx.done
      return next
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
  /** Observers of durable journal changes (e.g. the UndoBar count). */
  private readonly changeListeners = new Set<() => void>()

  constructor(store: JournalStore = memoryJournalStore()) {
    const inner = store
    // Every durable mutation flows through append, update, or reserveUndo: wrap each
    // once so observers fire after success, never on storage failure.
    this.store = {
      ...inner,
      append: async (entry) => {
        const result = await inner.append(entry)
        this.emitChange()
        return result
      },
      ...(inner.update
        ? {
            update: async (id, change) => {
              const result = await inner.update!(id, change)
              if (result) this.emitChange()
              return result
            },
          }
        : {}),
      ...(inner.reserveUndo
        ? {
            reserveUndo: async (originalId, undoEntry) => {
              const result = await inner.reserveUndo!(originalId, undoEntry)
              if (result) this.emitChange()
              return result
            },
          }
        : {}),
    }
  }

  /** Wrapped store: every durable mutation notifies change observers. */
  private declare readonly store: JournalStore;

  /** Subscribe to durable journal changes. Returns an unsubscribe. */
  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback)
    return () => {
      this.changeListeners.delete(callback)
    }
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener()
      } catch {
        // One failing observer must not break journal bookkeeping.
      }
    }
  }

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

  /**
   * Undo operation scope after restore (Epoch F1 / R6): a fresh panel only
   * calls scopeThread(), leaving turnId null. Undo must not require an
   * unrelated new model turn, so mint one operation turn bound to the
   * restored persisted thread. Returns null when no thread is restored.
   */
  ensureUndoTurn(): string | null {
    if (this.threadId == null) return null
    if (this.turnId == null) this.turnId = crypto.randomUUID()
    return this.turnId
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
    status: 'submitted' | 'applied' | 'failed' | 'unknown' | 'undone'
    outcomeDetail?: string
    inverse?: { tool: string; args: Record<string, unknown> }
    notUndoableReason?: string
    reservedByUndoOpId?: string | null
    verification?: JournalEntry['verification']
    remoteTaskId?: string
  }): Promise<JournalEntry | null> {
    return this.updateEntry(id, (entry) => {
      if (!entry) return null
      if (!canSettle(entry.status, update.status)) throw new Error(`INVALID_JOURNAL_TRANSITION: ${entry.status} -> ${update.status}`)
      const settled: JournalEntry = {
        ...entry,
        status: update.status,
        outcomeDetail: update.outcomeDetail ?? entry.outcomeDetail,
        inverse: update.inverse ?? entry.inverse,
        notUndoableReason: update.notUndoableReason ?? entry.notUndoableReason,
        verification: update.verification ?? entry.verification,
        remoteTaskId: update.remoteTaskId ?? entry.remoteTaskId,
      }
      if (update.reservedByUndoOpId !== undefined) {
        if (update.reservedByUndoOpId == null) delete settled.reservedByUndoOpId
        else settled.reservedByUndoOpId = update.reservedByUndoOpId
      }
      return settled
    })
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
    await this.updateEntry(originalId, (entry) =>
      entry?.reservedByUndoOpId === undoOpId ? { ...entry, reservedByUndoOpId: undefined } : null)
  }

  /** Durable human inspection: lifts the conflict block, never rewrites the outcome. */
  async markReviewed(id: string, note?: string): Promise<boolean> {
    return (await this.updateEntry(id, (entry) =>
      entry ? { ...entry, reviewedAt: Date.now(), reviewNote: note } : null)) != null
  }

  /** Unresolved, unreviewed operations in scope: blockers for new conflicting work. */
  async unresolvedInScope(threadId: string | null, excludeIds: Set<string> = new Set(), workspaceId?: string | null, targets: string[] = []): Promise<JournalEntry[]> {
    if (threadId == null && !workspaceId) return []
    const entries = workspaceId ? await this.store.list() : await this.listScoped(threadId!)
    const normalizedTargets = new Set(targets.map((id) => normalizeId(id) ?? id))
    return entries.filter((entry) =>
      (entry.status === 'pending' || entry.status === 'submitted' || entry.status === 'unknown') &&
      entry.reviewedAt == null &&
      !excludeIds.has(entry.id) &&
      (entry.threadId === threadId || entry.scope?.workspaceId === workspaceId) &&
      (entry.threadId === threadId || normalizedTargets.size === 0 || !entry.targetPageId || normalizedTargets.has(normalizeId(entry.targetPageId) ?? entry.targetPageId)),
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
    return (await this.newestFirst()).filter((e) => e.status === 'applied' && e.verification === 'verified' && e.inverse != null && e.reservedByUndoOpId == null)
  }

  /**
   * Scoped undoable count for the UndoBar. Reads through the existing
   * thread-scoped path (`by_thread` in IndexedDB), never the whole store —
   * and the component keeps only the number, never a copy of inverses.
   */
  async undoableCount(): Promise<number> {
    return (await this.undoable()).length
  }

  async newestForThread(threadId: string): Promise<JournalEntry[]> {
    return (await this.listScoped(threadId)).sort(compareEntries)
  }

  async setStatus(id: string, status: JournalEntry['status']): Promise<void> {
    await this.updateEntry(id, (entry) =>
      entry && (entry.status === status || (entry.status === 'applied' && status === 'undone'))
        ? { ...entry, status } : null)
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

  private async updateEntry(id: string, change: (entry: JournalEntry | undefined) => JournalEntry | null): Promise<JournalEntry | null> {
    if (this.store.update) return this.store.update(id, change)
    // Legacy test stores lack transactions; production stores implement update.
    const next = change(await this.readEntry(id))
    if (next) await this.store.append(next)
    return next
  }

  private async listScoped(threadId: string): Promise<JournalEntry[]> {
    if (this.store.listForThread) return this.store.listForThread(threadId)
    return (await this.store.list()).filter((entry) => entry.threadId === threadId)
  }
}

function canSettle(current: OperationStatus, next: OperationStatus): boolean {
  return current === 'pending' && next !== 'pending' && next !== 'undone'
    || current === 'submitted' && (next === 'submitted' || next === 'applied' || next === 'failed' || next === 'unknown')
    || current === 'applied' && (next === 'applied' || next === 'undone')
}

/** Deterministic newest-first order: timestamp, then id tie-breaker. */
function compareEntries(a: JournalEntry, b: JournalEntry): number {
  if (b.ts !== a.ts) return b.ts - a.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
