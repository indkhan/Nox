import { normalizeId } from '../../shared/notion-page'

/**
 * Session-memory ledger of successful workspace retrievals, keyed by thread.
 * Plan evidence may only cite ids Nox actually retrieved in the current
 * scope; anything else is an unverified claim, not inspection. Entries are
 * bounded and thread-scoped, so no cross-thread or cross-session leakage and
 * no explicit clearing protocol is needed.
 */
const MAX_RETRIEVALS = 2000

const inspected = new Map<string, number>()

function key(threadId: string, normalizedId: string): string {
  return `${threadId} ${normalizedId}`
}

/** Record successfully retrieved object ids for a thread. Invalid ids are skipped, never stored. */
export function recordRetrievals(threadId: string | null, ids: Array<string | null | undefined>): void {
  if (threadId == null) return
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const normalized = normalizeId(id)
    if (!normalized) continue
    inspected.set(key(threadId, normalized), Date.now())
    while (inspected.size > MAX_RETRIEVALS) {
      const oldest = inspected.keys().next()
      if (oldest.done) break
      inspected.delete(oldest.value)
    }
  }
}

/** True only for an id Nox recorded retrieving in the given thread. */
export function isInspectedEvidence(threadId: string | null, id: string): boolean {
  if (threadId == null || typeof id !== 'string') return false
  const normalized = normalizeId(id)
  if (!normalized) return false
  return inspected.has(key(threadId, normalized))
}
