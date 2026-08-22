import type { MutationJournal } from './journal'

export async function undoNewest(
  journal: MutationJournal,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = await journal.claimUndo()
  if (!entry?.inverse) return false
  try {
    await callTool(entry.inverse.tool, entry.inverse.args)
    await journal.setStatus(entry.id, 'undone')
    return true
  } catch (error) {
    throw error
  } finally {
    journal.releaseUndo()
  }
}

export async function undoEntry(
  journal: MutationJournal,
  id: string,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = await journal.claimUndo(id)
  if (!entry?.inverse) return false
  try {
    await callTool(entry.inverse.tool, entry.inverse.args)
    await journal.setStatus(entry.id, 'undone')
    return true
  } catch (error) {
    throw error
  } finally {
    journal.releaseUndo()
  }
}
