// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => ({})) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  })
  return { answer: vi.fn() }
})
void mocks

vi.mock('../src/lib/agent/panel', () => ({
  agentLoop: { setOverrides: vi.fn() },
  writeGate: {
    approvals: { answer: mocks.answer },
    journal: { undoable: vi.fn(async () => []) },
  },
}))
vi.mock('../src/lib/notion/panel', () => ({ notion: { scheduleCallTool: vi.fn() } }))

import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ApprovalCards } from '../src/sidepanel/ApprovalCards'
import { useNoxStore } from '../src/sidepanel/store'

const LONG_CONTENT = `${'A'.repeat(1900)}-TAIL-FLAG`
const FULL_PAYLOAD = JSON.stringify({
  data: { page_id: 'p1' },
  command: { type: 'replace_content', content: LONG_CONTENT, extra: 'late-target' },
}, null, 2)

function showCard(over: Record<string, unknown> = {}) {
  useNoxStore.setState({
    pendingApprovals: [{
      id: 7,
      tool: 'notion-update-page',
      summary: 'Replace page content',
      payloadJson: FULL_PAYLOAD,
      reasons: ['ask-before-changes mode is on'],
      targetUrl: 'https://www.notion.so/p1',
      reversibility: 'Undo availability is checked after the change',
      targets: ['p1'],
      affectedCount: 1,
      destructive: true,
      ...over,
    }],
  })
}

beforeEach(() => {
  mocks.answer.mockClear()
  useNoxStore.setState({ pendingApprovals: [] })
})

async function renderCards(): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<ApprovalCards />))
  return { container, root }
}

async function teardown(container: HTMLDivElement, root: ReturnType<typeof createRoot>) {
  await act(async () => root.unmount())
  container.remove()
  useNoxStore.setState({ pendingApprovals: [] })
}

describe('ApprovalCards (Epoch 05)', () => {
  it('shows the complete canonical payload with late fields intact', async () => {
    showCard()
    const { container, root } = await renderCards()
    try {
      expect(container.innerHTML.length).toBeGreaterThan(2000)
      expect(container.textContent).toContain('-TAIL-FLAG')
      expect(container.textContent).toContain('late-target')
      expect(container.textContent).toContain('Technical details')
    } finally {
      await teardown(container, root)
    }
  })

  it('presents targets, count, and destructive flags outside the content preview', async () => {
    showCard()
    const { container, root } = await renderCards()
    try {
      const text = container.textContent ?? ''
      expect(text).toContain('1 object')
      expect(text).toContain('p1')
      expect(text).toContain('Destructive')
      const previewIndex = text.indexOf('1 object')
      const detailsIndex = text.indexOf('Technical details')
      expect(previewIndex).toBeGreaterThan(-1)
      expect(detailsIndex).toBeGreaterThan(-1)
      expect(previewIndex).toBeLessThan(detailsIndex)
    } finally {
      await teardown(container, root)
    }
  })

  it('offers Approve and Reject but no approve-all', async () => {
    showCard()
    const { container, root } = await renderCards()
    try {
      expect(container.querySelector('[data-testid=approve-7]')).not.toBeNull()
      expect(container.querySelector('[data-testid=reject-7]')).not.toBeNull()
      expect(container.textContent).not.toContain('Approve all this turn')
    } finally {
      await teardown(container, root)
    }
  })

  it('keeps reversibility and undo availability visible', async () => {
    showCard()
    const { container, root } = await renderCards()
    try {
      expect(container.textContent).toContain('Undo availability is checked after the change')
    } finally {
      await teardown(container, root)
    }
  })

  it('approve answers the gate and clears the card', async () => {
    showCard()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ApprovalCards />))
    await act(async () => {
      ;(container.querySelector('[data-testid=approve-7]') as HTMLButtonElement).click()
    })
    expect(mocks.answer).toHaveBeenCalledWith(7, 'approve')
    expect(useNoxStore.getState().pendingApprovals).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('reject answers the gate and clears the card', async () => {
    showCard()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ApprovalCards />))
    await act(async () => {
      ;(container.querySelector('[data-testid=reject-7]') as HTMLButtonElement).click()
    })
    expect(mocks.answer).toHaveBeenCalledWith(7, 'reject')
    expect(useNoxStore.getState().pendingApprovals).toHaveLength(0)
    await act(async () => root.unmount())
  })
})
