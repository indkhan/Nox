import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTimeline } from '../src/sidepanel/MessageParts'

describe('ActivityTimeline', () => {
  it('renders meaningful tool status and duration', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: '1', tool: 'notion-fetch', args: { title: 'Launch plan' }, status: 'completed', durationMs: 820, resultText: 'Milestones and launch risks' },
      { kind: 'tool', id: '2', tool: 'notion-update-page', args: {}, status: 'failed', error: 'conflict' },
    ]} />)

    expect(html).toContain('Read “Launch plan”')
    expect(html).toContain('0.8s')
    expect(html).toContain('Failed to update a page')
    expect(html).toContain('conflict')
    expect(html).toContain('Milestones and launch risks')
  })

  it('selects table, context, and change previews by tool type', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: 'q', tool: 'notion-query-data-sources', args: {}, status: 'completed', resultText: '{"columns":["Name"],"rows":[["Alpha"]]}' },
      { kind: 'tool', id: 'p', tool: 'notion-fetch', args: { title: 'Brief' }, status: 'completed', resultText: 'Page body' },
      { kind: 'tool', id: 'u', tool: 'notion-update-page', args: { page_id: 'p1', status: 'In review' }, status: 'completed' },
    ]} />)

    expect(html).toContain('data-testid="results-table"')
    expect(html).toContain('data-testid="context-result"')
    expect(html).toContain('data-testid="change-result"')
  })

  it('offers undo on the matching reversible action', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: 'u', tool: 'notion-update-page', args: {}, status: 'completed', journalId: 'journal-1', undoable: true },
    ]} onUndo={vi.fn()} />)
    expect(html).toContain('Undo this change')
  })
})
