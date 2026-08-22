import type { ActivityItem } from '../agent/activity'
import type { MessageRow } from './schema'

export interface RestoredTurn {
  id: string
  userText: string
  view: {
    activity: ActivityItem[]
    answer: string
    error: string | null
    pending: boolean
  }
}

export function restoreTurns(messages: MessageRow[]): RestoredTurn[] {
  const turns: RestoredTurn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        id: message.id,
        userText: message.text,
        view: { activity: [], answer: '', error: 'This turn was interrupted before Nox responded.', pending: false },
      })
    } else if (message.role === 'assistant' && turns.length > 0) {
      const turn = turns[turns.length - 1]
      turn.view = { activity: message.activity ?? [], answer: message.text, error: null, pending: false }
    }
  }
  return turns
}
