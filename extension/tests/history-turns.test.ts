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

it('restores failure with partial output and the original error', () => {
  const turns = restoreTurns([row({ role: 'user' }), row({ role: 'assistant', text: 'Partial', turnStatus: 'failed', error: 'Quota exhausted' })])
  expect(turns[0].view).toMatchObject({ answer: 'Partial', error: 'Quota exhausted', pending: false })
})


it('preserves research and commentary while recovering journal outcomes', () => {
  const turns = restoreTurns([
    row({ role: 'user', ts: 1 }),
    row({ role: 'assistant', ts: 2, turnStatus: 'failed', activity: [
      { kind: 'commentary', id: 'progress', text: 'Checking' },
      { kind: 'tool', id: 'call-1', tool: 'notion-update-page', args: {}, status: 'running' },
    ] }),
  ], [{ id: 'j1', callId: 'call-1', ts: 3, threadId: 'thread-1', turnId: 't1',
    status: 'applied', tool: 'notion-update-page', args: {}, kind: 'content-update' }])
  expect(turns[0].view.activity).toEqual([
    { kind: 'commentary', id: 'progress', text: 'Checking' },
    expect.objectContaining({ id: 'call-1', journalId: 'j1', status: 'completed' }),
  ])
})

it('restores pending operations as prominent unresolved activity', () => {
  const turns = restoreTurns([
    row({ role: 'user', text: 'Update it', ts: 1 }),
    row({ role: 'assistant', text: 'Working…', ts: 2, turnStatus: 'complete', activity: [
      { kind: 'commentary', id: 'c1', text: 'Applying the edit' },
      { kind: 'tool', id: 'call-1', tool: 'notion-update-page', args: { page_id: 'p1' }, status: 'running' },
    ] }),
  ], [{
    id: 'op-1', callId: 'call-1', ts: 2, threadId: 'thread-1', turnId: 't1',
    status: 'pending', tool: 'notion-update-page', args: { page_id: 'p1' },
    kind: 'content-update', targetPageId: 'p1',
  }])
  expect(turns[0].view.answer).toBe('Working…')
  const item = turns[0].view.activity.find((entry) => entry.kind === 'tool')
  expect(item).toMatchObject({ status: 'unknown', journalId: 'op-1', undoable: false })
  expect(item).toHaveProperty('unresolvedDetail', expect.stringMatching(/may or may not have applied/i))
  expect(item).toHaveProperty('inspectUrl', expect.stringContaining('notion.so'))
  expect(turns[0].view.activity).toContainEqual({ kind: 'commentary', id: 'c1', text: 'Applying the edit' })
})

it('restores unknown outcomes with their recorded detail and no replayable undo', () => {
  const turns = restoreTurns([row({ role: 'user', text: 'Create it', ts: 1 })], [{
    id: 'op-2', callId: 'call-9', ts: 2, threadId: 'thread-1', turnId: 't1',
    status: 'unknown', tool: 'notion-create-pages', args: {},
    kind: 'create-page', outcomeDetail: 'mcp http 503: committed before failing',
  }])
  const item = turns[0].view.activity.find((entry) => entry.kind === 'tool')
  expect(item).toMatchObject({ status: 'unknown', journalId: 'op-2', undoable: false })
  expect(item).toHaveProperty('unresolvedDetail', expect.stringMatching(/503/))
})

it('locks reserved originals instead of offering undo', () => {
  const turns = restoreTurns([row({ role: 'user', text: 'Edit', ts: 1 })], [{
    id: 'op-3', callId: 'call-3', ts: 2, threadId: 'thread-1', turnId: 't1',
    status: 'applied', tool: 'notion-update-page', args: {},
    kind: 'properties', inverse: { tool: 'u', args: {} }, reservedByUndoOpId: 'undo-9',
  }])
  const item = turns[0].view.activity.find((entry) => entry.kind === 'tool')
  expect(item).toMatchObject({ status: 'unknown', undoable: false })
  expect(item).toHaveProperty('unresolvedDetail', expect.stringMatching(/locked until reviewed|interrupted/i))
})

it('restores legacy rows without invented scope or inverses', () => {
  const turns = restoreTurns([row({ role: 'user', text: 'Update it', ts: 1 })], [{
    id: 'journal-1', ts: 2, threadId: 'thread-1', turnId: 'turn-latest', status: 'applied',
    tool: 'notion-update-page', args: { page_id: 'p1' }, kind: 'content-update',
    inverse: { tool: 'notion-update-page', args: { page_id: 'p1', status: 'old' } },
  }])
  expect(turns[0].view.activity).toEqual([expect.objectContaining({
    journalId: 'journal-1', status: 'completed', undoable: true,
  })])
})

it('marks reviewed unknowns as reviewed without changing their status', () => {
  const turns = restoreTurns([row({ role: 'user', text: 'Edit', ts: 1 })], [{
    id: 'op-4', callId: 'call-4', ts: 2, threadId: 'thread-1', turnId: 't1',
    status: 'unknown', tool: 'notion-update-page', args: {},
    kind: 'content-update', reviewedAt: 1700000000000, reviewNote: 'inspected',
  }])
  const item = turns[0].view.activity.find((entry) => entry.kind === 'tool')
  expect(item).toMatchObject({ status: 'unknown', reviewed: true })
  expect(item).toHaveProperty('unresolvedDetail', expect.stringMatching(/reviewed/i))
})
