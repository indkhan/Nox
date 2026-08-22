import { describe, expect, it } from 'vitest'
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
})
