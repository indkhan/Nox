// @vitest-environment jsdom
import { vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn() } },
  })
})

vi.mock('../src/lib/agent/panel', () => ({
  writeGate: {
    approvals: { answer: vi.fn() },
    journal: { undoable: vi.fn(async () => []) },
  },
}))
vi.mock('../src/lib/notion/panel', () => ({ notion: { scheduleCallTool: vi.fn() } }))

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { Composer } from '../src/sidepanel/Composer'
import { ApprovalCards } from '../src/sidepanel/ApprovalCards'
import { useNoxStore } from '../src/sidepanel/store'

describe('viewer mode', () => {
  it('disables the composer for read-only windows', () => {
    const html = renderToStaticMarkup(
      <Composer busy={false} readOnly onSend={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('hides mutation approvals in read-only windows', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<ApprovalCards readOnly />)
      useNoxStore.getState().addApproval({ id: 1, tool: 'write', summary: 'Write', payloadJson: '{}', reasons: [] })
    })
    expect(container.textContent).toBe('')
    await act(async () => {
      root.unmount()
      useNoxStore.getState().removeApproval(1)
    })
  })

  it('presents approvals as clear decisions with technical details secondary', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      useNoxStore.getState().addApproval({
        id: 2,
        tool: 'notion-update-page',
        summary: 'Change Status to In review',
        payloadJson: '{"page_id":"p1"}',
        reasons: ['This changes a Notion page'],
      })
      root.render(<ApprovalCards />)
    })
    expect(container.textContent).toContain('Make this change?')
    expect(container.textContent).toContain('Change Status to In review')
    expect(container.textContent).toContain('Technical details')
    expect(container.textContent).toContain('Approve similar this turn')
    await act(async () => {
      root.unmount()
      useNoxStore.getState().removeApproval(2)
    })
  })
})
