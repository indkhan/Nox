import type { MutationJournal } from './journal'

export async function undoNewest(
  journal: MutationJournal,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = (await journal.undoable())[0]
  if (!entry?.inverse) return false
  try {
    await callTool(entry.inverse.tool, entry.inverse.args)
    await journal.setStatus(entry.id, 'undone')
    return true
  } catch (error) {
    throw error
  }
}

export async function undoEntry(
  journal: MutationJournal,
  id: string,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = (await journal.undoable()).find((candidate) => candidate.id === id)
  if (!entry?.inverse) return false
  try {
    await callTool(entry.inverse.tool, entry.inverse.args)
    await journal.setStatus(entry.id, 'undone')
    return true
  } catch (error) {
    throw error
  }
}
