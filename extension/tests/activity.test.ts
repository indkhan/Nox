import { describe, expect, it } from 'vitest'
import { applyActivityEvent, toolActivityLabel, type ActivityItem } from '../src/lib/agent/activity'

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

describe('tool activity labels', () => {
  it('describes known Notion tools using their target', () => {
    expect(toolActivityLabel('notion-fetch', { title: 'Launch plan' })).toBe('Reading “Launch plan”')
    expect(toolActivityLabel('notion-search', { query: 'roadmap' })).toBe('Searching for “roadmap”')
    expect(toolActivityLabel('notion-update-page', { page_id: 'p1' })).toBe('Updating a page')
  })

  it('turns unknown tool names into readable labels', () => {
    expect(toolActivityLabel('custom_sync_records', {})).toBe('Custom sync records')
  })
})
