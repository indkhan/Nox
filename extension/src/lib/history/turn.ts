import type { ThreadRepository } from './repository'
import type { ActivityItem } from '../agent/activity'

export type PersistedOutcome = 'streaming' | 'complete' | 'interrupted' | 'failed'

/** Exact banner copy surfaced near the affected answer on final-save failure. */
export const HISTORY_SAVE_ERROR = 'History could not be saved'

interface Snapshot {
  text: string
  usage?: Record<string, number>
  activity?: ActivityItem[]
  turnStatus: PersistedOutcome
  error?: string
}

interface QueuedSave {
  snapshot: Snapshot
  isFinal: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

export interface PersistedTurn {
  threadId: string
  /**
   * Enqueue one assistant snapshot. Each call gets its own result: it
   * resolves when that snapshot lands (or is superseded by newer state) and
   * rejects when its own write fails. A failure never poisons the queue —
   * the internal tail always recovers for the next operation.
   */
  persistAssistant(
    text: string,
    usage?: Record<string, number>,
    activity?: ActivityItem[],
    turnStatus?: PersistedOutcome,
    error?: string,
  ): Promise<void>
  /** Re-attempt the latest final/outcome snapshot without rerunning the turn. */
  retryFinal(): Promise<void>
  /** Final-save failures for the "History could not be saved" banner. */
  onSaveError(callback: (message: string) => void): () => void
}

/**
 * Durable per-turn history writer (Epoch 09 / M16).
 *
 * At most one save is in flight and at most one waits; rapid streaming
 * partials coalesce so only the latest unsent partial is kept. A
 * final/outcome snapshot supersedes any waiting partial, is always attempted
 * after the in-flight save settles, and can never be overwritten by an older
 * partial. Thread/message identities are captured here, before any async
 * work, so a later new chat or thread deletion cannot redirect old saves.
 */
export async function startPersistedTurn(
  repo: ThreadRepository,
  threadId: string | null,
  userText: string,
): Promise<PersistedTurn> {
  const id = threadId ?? (await repo.createThread()).id
  await repo.appendMessage(id, { role: 'user', text: userText })
  // Captured once, up front: every save below lands under these identities.
  const assistantId = crypto.randomUUID()
  let inFlight: Promise<void> | null = null
  let waiting: QueuedSave | null = null
  let finalSeen = false
  let lastFinal: Snapshot | null = null
  const saveErrorListeners = new Set<(message: string) => void>()

  function emitSaveError(): void {
    for (const listener of [...saveErrorListeners]) {
      try {
        listener(HISTORY_SAVE_ERROR)
      } catch {
        // One failing observer must not break persistence bookkeeping.
      }
    }
  }

  function writeSnapshot(snapshot: Snapshot): Promise<void> {
    return repo.appendMessage(id, {
      id: assistantId,
      role: 'assistant',
      text: snapshot.text,
      usage: snapshot.usage,
      activity: snapshot.activity,
      turnStatus: snapshot.turnStatus,
      error: snapshot.error,
    }).then(() => undefined)
  }

  function pump(): void {
    if (inFlight || !waiting) return
    const current = waiting
    waiting = null
    inFlight = writeSnapshot(current.snapshot).then(
      () => {
        inFlight = null
        current.resolve()
        pump()
      },
      (error) => {
        // Recover the tail: the next operation still runs. Only final
        // failures surface; superseded partials resolve, failed ones reject
        // their own promise without taking the queue down.
        inFlight = null
        if (current.isFinal) emitSaveError()
        current.reject(error)
        pump()
      },
    )
  }

  function enqueue(snapshot: Snapshot, isFinal: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Defensive copy: later turn events build new arrays, but the waiting
      // snapshot must never observe them.
      const frozen: Snapshot = { ...snapshot, activity: snapshot.activity ? [...snapshot.activity] : undefined }
      if (isFinal) {
        finalSeen = true
        lastFinal = frozen
        if (waiting && !waiting.isFinal) waiting.resolve() // superseded partial
        waiting = { snapshot: frozen, isFinal, resolve, reject }
      } else {
        if (finalSeen || (waiting && waiting.isFinal)) {
          // Already covered by a final: converge without another write.
          resolve()
          return
        }
        if (waiting) waiting.resolve() // coalesce: keep only the latest partial
        waiting = { snapshot: frozen, isFinal, resolve, reject }
      }
      pump()
    })
  }

  return {
    threadId: id,
    persistAssistant(
      text: string,
      usage?: Record<string, number>,
      activity?: ActivityItem[],
      turnStatus: PersistedOutcome = 'streaming',
      error?: string,
    ): Promise<void> {
      return enqueue({ text, usage, activity, turnStatus, error }, turnStatus !== 'streaming')
    },
    retryFinal(): Promise<void> {
      if (!lastFinal) throw new Error('no final snapshot to retry yet')
      return enqueue({ ...lastFinal }, true)
    },
    onSaveError(callback: (message: string) => void): () => void {
      saveErrorListeners.add(callback)
      return () => {
        saveErrorListeners.delete(callback)
      }
    },
  }
}
