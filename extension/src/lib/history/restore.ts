import type { ActivityItem } from '../agent/activity'
import type { MessageRow } from './schema'
import type { JournalEntry } from '../writes/journal'

export interface RestoredTurn {
  id: string
  startedAt: number
  userText: string
  view: {
    activity: ActivityItem[]
    answer: string
    error: string | null
    pending: boolean
  }
}

export function restoreTurns(messages: MessageRow[], journal: JournalEntry[] = []): RestoredTurn[] {
  const turns: RestoredTurn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        id: message.id,
        startedAt: message.ts,
        userText: message.text,
        view: { activity: [], answer: '', error: 'This turn was interrupted before Nox responded.', pending: false },
      })
    } else if (message.role === 'assistant' && turns.length > 0) {
      const turn = turns[turns.length - 1]
      turn.view = { activity: message.activity ?? [], answer: message.text, error: null, pending: false }
    }
  }
  const interrupted = turns.at(-1)
  const relevantJournal = interrupted ? journal.filter((entry) => entry.ts >= interrupted.startedAt) : []
  if (interrupted?.view.error && relevantJournal.length > 0) {
    const latestTurnId = relevantJournal[0].turnId
    interrupted.view.activity = relevantJournal
      .filter((entry) => entry.turnId === latestTurnId)
      .map((entry) => ({
        kind: 'tool' as const,
        id: entry.callId ?? entry.id,
        tool: entry.tool,
        args: entry.args,
        status: entry.status === 'failed' ? 'failed' as const : 'completed' as const,
        journalId: entry.id,
        undoable: entry.status === 'applied' && entry.inverse != null,
      }))
  }
  return turns
}
