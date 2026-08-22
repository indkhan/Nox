import { describe, expect, it } from 'vitest'
import { applyActivityEvent, type ActivityItem } from '../src/lib/agent/activity'

describe('agent activity', () => {
  it('correlates a completed tool with its running activity', () => {
    let items: ActivityItem[] = []
    items = applyActivityEvent(items, {
      kind: 'tool-call', tool: 'notion-fetch', args: { id: 'page-1' }, callId: 'call-1',
    })
    items = applyActivityEvent(items, {
      kind: 'tool-completed', tool: 'notion-fetch', callId: 'call-1', success: true, durationMs: 42,
    })

    expect(items).toEqual([expect.objectContaining({
      kind: 'tool', id: 'call-1', tool: 'notion-fetch', status: 'completed', durationMs: 42,
    })])
  })

  it('keeps reasoning, search, and failed tools as ordered activities', () => {
    let items: ActivityItem[] = []
    items = applyActivityEvent(items, { kind: 'reasoning', text: 'Checking the workspace' })
    items = applyActivityEvent(items, { kind: 'web-search' })
    items = applyActivityEvent(items, { kind: 'tool-call', tool: 'notion-search', args: {}, callId: 'call-2' })
    items = applyActivityEvent(items, {
      kind: 'tool-completed', tool: 'notion-search', callId: 'call-2', success: false, error: 'rate limited', durationMs: 8,
    })

    expect(items.map((item) => item.kind)).toEqual(['reasoning', 'search', 'tool'])
    expect(items[2]).toMatchObject({ status: 'failed', error: 'rate limited' })
  })
})
