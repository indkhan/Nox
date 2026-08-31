import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTimeline, FollowUpActions } from '../src/sidepanel/MessageParts'

describe('ActivityTimeline', () => {
  it('keeps reasoning private and presents an ordered readable work log', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active initiallyExpanded items={[
      { kind: 'reasoning', id: 'r', text: 'Maybe inspect private implementation details' },
      { kind: 'search', id: 's', status: 'completed' },
      { kind: 'tool', id: 't', tool: 'notion-fetch', args: { title: 'Brief' }, status: 'running' },
    ]} />)
    expect(html).toContain('What Nox did')
    expect(html).not.toContain('Maybe inspect private implementation details')
    const log = html.slice(html.indexOf('What Nox did'))
    expect(log.indexOf('Searched the web')).toBeLessThan(log.indexOf('Reading “Brief”'))
  })

  it('starts with a compact human-readable status', () => {
    const initial = renderToStaticMarkup(<ActivityTimeline active items={[]} />)
    expect(initial).toContain('Understanding your request…')
    expect(initial).toContain('aria-expanded="false"')

    const running = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: 't', tool: 'notion-fetch', args: { title: 'Launch plan' }, status: 'running' },
    ]} />)
    expect(running).toContain('Reading “Launch plan”…')
    expect(running).not.toContain('notion-fetch')
    expect(running).not.toContain('Technical details')
  })

  it('shows composing and completed summaries', () => {
    expect(renderToStaticMarkup(<ActivityTimeline active answerStarted items={[]} />)).toContain('Writing the answer…')
    const completed = renderToStaticMarkup(<ActivityTimeline items={[
      { kind: 'tool', id: 't', tool: 'notion-fetch', args: {}, status: 'completed', durationMs: 820 },
    ]} initiallyExpanded />)
    expect(completed).toContain('Answer ready')
    expect(completed).toContain('1 action')
    expect(completed).toContain('0.8s')
  })

  it('renders meaningful tool status and duration', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: '1', tool: 'notion-fetch', args: { title: 'Launch plan' }, status: 'completed', durationMs: 820, resultText: 'Milestones and launch risks' },
      { kind: 'tool', id: '2', tool: 'notion-update-page', args: {}, status: 'failed', error: 'conflict' },
    ]} initiallyExpanded />)

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
    ]} initiallyExpanded />)

    expect(html).toContain('data-testid="results-table"')
    expect(html).toContain('data-testid="context-result"')
    expect(html).toContain('data-testid="change-result"')
  })

  it('offers undo on the matching reversible action', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: 'u', tool: 'notion-update-page', args: {}, status: 'completed', journalId: 'journal-1', undoable: true },
    ]} initiallyExpanded onUndo={vi.fn()} />)
    expect(html).toContain('Undo this change')
  })

  it('renders follow-up actions as buttons', () => {
    const html = renderToStaticMarkup(<FollowUpActions suggestions={['Summarize these results']} onSelect={vi.fn()} />)
    expect(html).toContain('Follow-ups')
    expect(html).toContain('Summarize these results')
  })

  it('shows completed searches and technical tool details', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'search', id: 's', status: 'completed' },
      { kind: 'tool', id: 't', tool: 'notion-fetch', args: { id: 'p1' }, status: 'completed' },
    ]} initiallyExpanded />)
    expect(html).toContain('Searched the web')
    expect(html).toContain('notion-fetch')
    expect(html).toContain('&quot;id&quot;:&quot;p1&quot;')
  })

  it('safely formats unusual technical arguments', () => {
    const circular: Record<string, unknown> = { query: '<script>alert(1)</script>' }
    circular.self = circular
    const html = renderToStaticMarkup(<ActivityTimeline active initiallyExpanded items={[
      { kind: 'tool', id: 't', tool: 'custom-tool', args: circular, status: 'running' },
    ]} />)
    expect(html).toContain('custom-tool')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('[Circular]')
    expect(html).not.toContain('<script>')
  })
})
