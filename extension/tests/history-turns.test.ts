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
})
