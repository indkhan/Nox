// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { deleteDB } from 'idb'

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => ({})) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  })
})

vi.mock('../src/lib/agent/panel', () => ({
  agentLoop: { setOverrides: vi.fn() },
}))

vi.mock('../src/lib/notion/panel', () => ({
  notion: { scheduleCallTool: vi.fn(async () => ({ content: [] })) },
}))

vi.mock('../src/lib/codex/panel', () => ({
  codex: { listModels: vi.fn(async () => []) },
}))

import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useNoxStore } from '../src/sidepanel/store'
import { Composer } from '../src/sidepanel/Composer'
import { createTurnAccessState } from '../src/lib/agent/turn-access'
import { evaluateApproval } from '../src/lib/writes/approvals'
import { openNoxDB, closeNoxDBConnections, __resetConnectionCacheForTests } from '../src/lib/history/schema'
import { __resetDeletionStateForTests } from '../src/lib/history/deletion'
import { threadRepository } from '../src/lib/history/repository'

beforeEach(() => {
  __resetConnectionCacheForTests()
  __resetDeletionStateForTests()
})

afterEach(async () => {
  closeNoxDBConnections()
  await deleteDB('nox').catch(() => undefined)
  __resetConnectionCacheForTests()
})

describe('Auto is the default mode', () => {
  it('starts the composer store in Auto', () => {
    expect(useNoxStore.getInitialState().mode).toBe('auto')
    expect(useNoxStore.getState().mode).toBe('auto')
  })

  it('starts turn access in Auto before the first Send', () => {
    expect(createTurnAccessState().mode()).toBe('auto')
  })

  it('creates new threads in Auto', async () => {
    const repo = threadRepository(() => openNoxDB())
    const thread = await repo.createThread('New chat')
    expect(thread.mode).toBe('auto')
  })

  it('starts implicit threads from beginTurn in Auto', async () => {
    const repo = threadRepository(() => openNoxDB())
    const { threadId } = await repo.beginTurn(null, 'hello')
    const thread = await repo.getThread(threadId)
    expect(thread?.mode).toBe('auto')
  })

  it('asks for every mutation only when Ask is explicitly selected', () => {
    const write = {
      name: 'notion-update-page',
      mutates: true,
      kind: 'content-replace' as const,
      args: { data: { page_id: 'p1' } },
      targets: ['p1'],
      parents: [] as string[],
      affectedCount: 1,
      grant: { allowed: false, pages: [] as string[] },
    }
    expect(evaluateApproval(write, { mode: 'ask', contextSet: new Set(['p1']) }).action).toBe('require-approval')
    // Auto without the per-turn small-edit grant still asks — the default
    // change must not silently authorize anything by itself.
    expect(evaluateApproval(write, { mode: 'auto', contextSet: new Set(['p1']) }).action).toBe('require-approval')
  })

  it('selects Auto first in the composer with the small-edit grant visible', async () => {
    useNoxStore.setState({ mode: 'auto', currentPage: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<Composer busy={false} onSend={vi.fn()} onCancel={vi.fn()} />)
      })
      const selector = container.querySelector('[data-testid=mode-selector]') as HTMLSelectElement
      expect(selector.value).toBe('auto')
      expect([...selector.options].map((option) => option.value)[0]).toBe('auto')
      expect(container.querySelector('[data-testid=allow-small-edits]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      useNoxStore.setState({ mode: 'auto', currentPage: null })
    }
  })
})
