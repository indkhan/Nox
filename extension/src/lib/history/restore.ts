import type { ActivityItem } from '../agent/activity'
import { describeUnresolvedEntry, inspectUrlForPage } from '../agent/activity'
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
    outcome?: 'failed' | 'interrupted'
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
      const interrupted = message.turnStatus === 'streaming' || message.turnStatus === 'interrupted'
      turn.view = {
        activity: message.activity ?? [],
        answer: message.text,
        outcome: message.turnStatus === 'failed' ? 'failed' : interrupted ? 'interrupted' : undefined,
        error: message.turnStatus === 'failed' ? message.error ?? 'This turn failed before Nox finished responding.' : interrupted ? 'This turn was interrupted before Nox finished responding.' : null,
        pending: false,
      }
    }
  }
  const interrupted = turns.at(-1)
  const relevantJournal = interrupted ? journal.filter((entry) => entry.ts >= interrupted.startedAt) : []
  if (interrupted?.view.error && relevantJournal.length > 0) {
    const latestTurnId = relevantJournal[0].turnId
    const recovered = relevantJournal
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
    const activity = [...interrupted.view.activity]
    for (const item of recovered) {
      const index = activity.findIndex(existing => existing.kind === 'tool' && (existing.id === item.id || existing.journalId === item.journalId))
      if (index < 0) activity.push(item)
      else activity[index] = { ...activity[index], ...item }
    }
    interrupted.view.activity = activity
  }
  // Unresolved operations (pending, unknown, or undo-locked) surface as
  // prominent review rows wherever their activity lives — never replayed,
  // never silently dropped. Partial text and commentary are preserved.
  const lastTurn = turns.at(-1)
  for (const entry of journal) {
    if (!needsReviewRow(entry)) continue
    const item: Extract<ActivityItem, { kind: 'tool' }> = {
      kind: 'tool',
      id: entry.callId ?? entry.id,
      tool: entry.tool,
      args: entry.args,
      status: 'unknown',
      journalId: entry.id,
      undoable: false,
      unresolvedDetail: describeUnresolvedEntry(entry),
      inspectUrl: entry.targetPageId ? inspectUrlForPage(entry.targetPageId) : undefined,
      reviewed: entry.reviewedAt != null ? true : undefined,
    }
    let placed = false
    for (const turn of turns) {
      const index = turn.view.activity.findIndex((existing) =>
        existing.kind === 'tool' && (existing.id === item.id || (existing.journalId != null && existing.journalId === item.journalId)))
      if (index >= 0) {
        turn.view.activity[index] = { ...turn.view.activity[index], ...item }
        placed = true
      }
    }
    if (!placed && lastTurn) {
      const duplicate = lastTurn.view.activity.some((existing) =>
        existing.kind === 'tool' && (existing.id === item.id || (existing.journalId != null && existing.journalId === item.journalId)))
      if (!duplicate) lastTurn.view = { ...lastTurn.view, activity: [...lastTurn.view.activity, item] }
    }
  }
  return turns
}

function needsReviewRow(entry: JournalEntry): boolean {
  if (entry.status === 'pending' || entry.status === 'unknown') return true
  return entry.status === 'applied' && entry.reservedByUndoOpId != null
}
