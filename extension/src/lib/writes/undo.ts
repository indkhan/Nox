import type { MutationJournal } from './journal'

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
