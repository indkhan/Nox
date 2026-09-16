// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ActivityTimeline, AssistantMarkdown, FollowUpActions } from '../src/sidepanel/MessageParts'

describe('ActivityTimeline', () => {
  it('provides polished activity motion with an accessible fallback', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[]} />)
    expect(html).toContain('nox-activity-mark')
    expect(html).toContain('data-active="true"')
    const css = readFileSync('src/sidepanel/index.css', 'utf8')
    expect(css).toContain('@keyframes nox-activity-breathe')
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*nox-activity-mark/)
  })

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

  it('explains unavailable undo instead of rendering an enabled button', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      { kind: 'tool', id: 'u', tool: 'notion-update-page', args: {}, status: 'completed', journalId: 'journal-1', undoable: true },
    ]} initiallyExpanded undoUnavailableReason="Undo unavailable in read-only mode" />)
    expect(html).not.toContain('Undo this change')
    expect(html).toContain('Undo unavailable in read-only mode')
  })

  it('renders unresolved operations as prominent reviewable rows', () => {
    const onMarkReviewed = vi.fn()
    const onCheckState = vi.fn()
    const html = renderToStaticMarkup(<ActivityTimeline active items={[
      {
        kind: 'tool', id: 'u', tool: 'notion-update-page', args: { page_id: 'p1' },
        status: 'unknown', journalId: 'op-1',
        unresolvedDetail: 'Outcome unknown — it may or may not have applied.',
        inspectUrl: 'https://www.notion.so/p1',
      },
    ]} initiallyExpanded onMarkReviewed={onMarkReviewed} onCheckState={onCheckState} />)
    expect(html).toContain('Needs review')
    expect(html).toContain('Outcome unknown')
    expect(html).toContain('href="https://www.notion.so/p1"')
    expect(html).toContain('Mark reviewed')
    expect(html).toContain('Check current state')
    expect(html).not.toContain('Undo this change')
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

it('shows commentary and expandable evidence details', () => {
  const html = renderToStaticMarkup(<ActivityTimeline initiallyExpanded items={[
    { kind: 'commentary', id: 'c1', text: 'Checking the official release notes.' },
    { kind: 'search', id: 's1', status: 'completed', query: 'node release', action: { type: 'openPage', url: 'https://nodejs.org/' } },
  ]} />)
  expect(html).toContain('Checking the official release notes.')
  expect(html).toContain('node release')
  expect(html).toContain('https://nodejs.org/')
  expect(html).toContain('<details')
})

it('keeps restored assistant media as a non-loading source link', () => {
  const html = renderToStaticMarkup(<AssistantMarkdown markdown="![receipt](https://attacker.invalid/history.png)" />)
  expect(html).not.toContain('<img')
  expect(html).not.toContain('src=')
  expect(html).toContain('href="https://attacker.invalid/history.png"')
})
