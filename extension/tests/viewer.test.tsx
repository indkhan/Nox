// @vitest-environment jsdom
import { vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => ({ pages: [] })) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  })
})

vi.mock('../src/lib/agent/panel', () => ({
  agentLoop: { setOverrides: vi.fn() },
  writeGate: {
    approvals: { answer: vi.fn() },
    journal: { undoable: vi.fn(async () => []) },
  },
}))
vi.mock('../src/lib/codex/panel', () => ({
  codex: { listModels: vi.fn(async () => [{
    id: 'gpt-fast',
    displayName: 'GPT Fast',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses' }],
  }]) },
}))
vi.mock('../src/lib/notion/panel', () => ({ notion: { scheduleCallTool: vi.fn() } }))

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { Composer } from '../src/sidepanel/Composer'
import { ApprovalCards } from '../src/sidepanel/ApprovalCards'
import { EmptyState } from '../src/sidepanel/EmptyState'
import { useNoxStore } from '../src/sidepanel/store'
import { notion } from '../src/lib/notion/panel'

describe('viewer mode', () => {
  it('disables the composer for read-only windows', () => {
    const html = renderToStaticMarkup(
      <Composer busy={false} readOnly onSend={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(html).toContain('data-testid="composer"')
    expect(html).toMatch(/<div[^>]*contenteditable="false"/i)
  })

  it('disables empty-state actions for read-only windows', () => {
    const html = renderToStaticMarkup(<EmptyState readOnly onSend={vi.fn()} />)
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })

  it('shows model controls inline and keeps unfinished controls out of the composer', () => {
    useNoxStore.setState({ codexStatus: 'disconnected' })
    const html = renderToStaticMarkup(
      <Composer busy={false} onSend={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(html).not.toContain('Attach images (coming soon)')
    expect(html).not.toContain('Voice input (coming soon)')
    expect(html).not.toContain('Model settings')
    expect(html).toContain('data-testid="chat-model-controls"')
    expect(html).toContain('Codex not connected')
  })

  it('shows speed tiers offered by the selected model', async () => {
    useNoxStore.setState({ codexStatus: 'connected' })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<Composer busy={false} onSend={vi.fn()} onCancel={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const speed = container.querySelector('[data-testid=speed-select]') as HTMLSelectElement
    expect([...speed.options].map((option) => option.text)).toEqual(['Standard', 'Fast'])
    await act(async () => root.unmount())
  })

  it('cancels a busy turn with Escape', async () => {
    const onCancel = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<Composer busy onSend={vi.fn()} onCancel={onCancel} />))
    await act(async () => {
      container.querySelector('[data-testid=composer]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })

  it('attaches the current page as a mention via quick-add and passes it on send', async () => {
    const onSend = vi.fn()
    useNoxStore.setState({
      currentPage: { pageId: 'p1', url: 'https://app.notion.com/p/Second-Brain-p1', title: 'Second Brain', iconEmoji: '🧠' },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<Composer busy={false} onSend={onSend} onCancel={vi.fn()} />))

    await act(async () => {
      ;(container.querySelector('[data-testid=add-current-page]') as HTMLButtonElement).click()
    })
    // The pill is rendered inline in the editor.
    const chip = container.querySelector('[data-mention-id="p1"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('Second Brain')

    await act(async () => {
      ;(container.querySelector('[data-testid=send]') as HTMLButtonElement).click()
    })
    expect(onSend).toHaveBeenCalledOnce()
    const [text, mentions] = onSend.mock.calls[0]
    expect(text).toContain('@Second Brain')
    expect(mentions).toEqual([{ pageId: 'p1', title: 'Second Brain', iconEmoji: '🧠', iconUrl: undefined }])

    await act(async () => root.unmount())
    useNoxStore.setState({ currentPage: null })
  })

  it('loads MCP JSON results after typing a mention query', async () => {
    vi.mocked(notion.scheduleCallTool).mockClear().mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({ results: [{
          id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
          title: 'Projects',
          url: 'https://www.notion.so/Projects-a1b2c3d4e5f64789abcdef0123456789',
          type: 'page',
        }] }),
      }],
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<Composer busy={false} onSend={vi.fn()} onCancel={vi.fn()} />))

    const editor = container.querySelector('[data-testid=composer]') as HTMLDivElement
    editor.textContent = '@Proj'
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    await act(async () => editor.dispatchEvent(new InputEvent('input', { bubbles: true })))

    expect(notion.scheduleCallTool).toHaveBeenCalledWith('notion-search', { query: 'Proj' })
    expect(container.querySelector('[data-testid=mention-option-0]')?.textContent).toContain('Projects')
    await act(async () => root.unmount())
    container.remove()
  })

  it('reuses cached MCP matches for later mentions', async () => {
    vi.mocked(notion.scheduleCallTool).mockClear().mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({ results: [{
          id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
          title: 'Projects',
          url: 'https://www.notion.so/Projects-a1b2c3d4e5f64789abcdef0123456789',
          type: 'page',
        }] }),
      }],
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<Composer busy={false} onSend={vi.fn()} onCancel={vi.fn()} />))

    const editor = container.querySelector('[data-testid=composer]') as HTMLDivElement
    const type = async (text: string) => {
      editor.textContent = text
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      await act(async () => editor.dispatchEvent(new InputEvent('input', { bubbles: true })))
    }
    await type('@Proj')
    await type('@Projects')

    expect(notion.scheduleCallTool).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid=mention-option-0]')?.textContent).toContain('Projects')
    await act(async () => root.unmount())
    container.remove()
  })

  it('hides mutation approvals in read-only windows', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<ApprovalCards readOnly />)
      useNoxStore.getState().addApproval({ id: 1, tool: 'write', summary: 'Write', payloadJson: '{}', reasons: [], reversibility: 'Unknown' })
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
        targetUrl: 'https://www.notion.so/p1',
        reversibility: 'Undo availability is checked after the change',
      })
      root.render(<ApprovalCards />)
    })
    expect(container.textContent).toContain('Make this change?')
    expect(container.textContent).toContain('Change Status to In review')
    expect(container.textContent).toContain('Technical details')
    expect(container.textContent).toContain('Approve all this turn')
    expect(container.textContent).toContain('Open target')
    expect(container.textContent).toContain('Undo availability')
    await act(async () => {
      root.unmount()
      useNoxStore.getState().removeApproval(2)
    })
  })
})
