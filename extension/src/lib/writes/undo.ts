import type { MutationJournal } from './journal'
import { MutationRejectedError, type WriteGate } from './gate'

export function undoNewest(
  journal: MutationJournal,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  return undoEntry(journal, undefined, callTool)
}

export async function undoEntry(
  journal: MutationJournal,
  id: string | undefined,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = await journal.claimUndo(id)
  if (!entry?.inverse) return false
  try {
    await callTool(entry.inverse.tool, entry.inverse.args)
    await journal.setStatus(entry.id, 'undone')
    return true
  } finally {
    journal.releaseUndo()
  }
}

/**
 * The single runtime undo entry point for panel UI. Re-reads the target
 * entry from storage (scope-aware) instead of trusting a restored activity
 * row, then dispatches through the gate's serial mutation boundary, which
 * re-validates ownership, turn state, and entry status before transport.
 * Returns false when nothing is undoable; ownership/turn violations throw.
 */
export async function requestRuntimeUndo(gate: WriteGate, id?: string): Promise<boolean> {
  const entries = await gate.journal.undoable()
  const entry = id == null ? entries[0] : entries.find((candidate) => candidate.id === id)
  if (!entry?.inverse) return false
  try {
    await gate.handleUndo(entry.inverse.tool, entry.inverse.args, { journalId: entry.id })
    return true
  } catch (e) {
    if (e instanceof MutationRejectedError && e.code === 'NOT_UNDOABLE') return false
    throw e
  }
}
