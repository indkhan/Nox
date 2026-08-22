import { describe, expect, it } from 'vitest'
import { restoreTurns } from '../src/lib/history/restore'
import type { MessageRow } from '../src/lib/history/schema'

const row = (partial: Partial<MessageRow>): MessageRow => ({
  id: crypto.randomUUID(), threadId: 'thread-1', role: 'user', text: '', ts: Date.now(), ...partial,
})

describe('restoreTurns', () => {
  it('restores assistant text and structured activity', () => {
    const turns = restoreTurns([
      row({ role: 'user', text: 'Find the plan', ts: 1 }),
      row({ role: 'assistant', text: 'Found it', ts: 2, activity: [{ kind: 'tool', id: 'c1', tool: 'notion-fetch', args: {}, status: 'completed' }] }),
    ])
    expect(turns).toEqual([expect.objectContaining({
      userText: 'Find the plan',
      view: expect.objectContaining({ answer: 'Found it', activity: [expect.objectContaining({ id: 'c1' })] }),
    })])
  })

  it('marks a user message without an assistant response as interrupted', () => {
    expect(restoreTurns([row({ role: 'user', text: 'Do work' })])[0].view.error).toMatch(/interrupted/i)
  })

  it('restores applied changes from the interrupted turn with targeted undo', () => {
    const turns = restoreTurns([row({ role: 'user', text: 'Update it', ts: 1 })], [{
      id: 'journal-1', ts: 2, threadId: 'thread-1', turnId: 'turn-latest', status: 'applied',
      tool: 'notion-update-page', args: { page_id: 'p1' }, kind: 'content-update',
      inverse: { tool: 'notion-update-page', args: { page_id: 'p1', status: 'old' } },
    }])
    expect(turns[0].view.activity).toEqual([expect.objectContaining({
      journalId: 'journal-1', status: 'completed', undoable: true,
    })])
  })

  it('does not mistake a streamed partial assistant row for a completed turn', () => {
    const turns = restoreTurns([
      row({ role: 'user', text: 'Long task', ts: 1 }),
      row({ role: 'assistant', text: 'Partial answer', turnStatus: 'streaming', ts: 2 }),
    ])
    expect(turns[0].view.answer).toBe('Partial answer')
    expect(turns[0].view.error).toMatch(/interrupted/i)
  })
})
