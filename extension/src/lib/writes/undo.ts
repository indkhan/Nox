import type { MutationJournal } from './journal'

export async function undoNewest(
  journal: MutationJournal,
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const entry = (await journal.undoable())[0]
  if (!entry?.inverse) return false
  await callTool(entry.inverse.tool, entry.inverse.args)
  await journal.drop(entry.id)
  return true
}
