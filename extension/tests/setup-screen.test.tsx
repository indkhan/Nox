// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  connectionStatus: 'disconnected',
  codexStatus: 'disconnected',
  threadTitle: 'New chat',
  settingsOpen: false,
  agentBusy: false,
  setSettingsOpen: vi.fn(),
  requestNewChat: vi.fn(),
}))

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})) } },
  })
})

vi.mock('../src/sidepanel/store', () => ({
  hydrateCurrentPage: vi.fn(async () => undefined),
  useNoxStore: (select: (value: typeof state) => unknown) => select(state),
}))
vi.mock('../src/sidepanel/ChatPanel', () => ({ ChatPanel: () => <div>Chat ready</div> }))
vi.mock('../src/sidepanel/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('../src/sidepanel/ConnectionCard', () => ({ ConnectionCard: () => <div>Notion connection</div> }))
vi.mock('../src/sidepanel/BridgeCard', () => ({ BridgeCard: () => <div>Codex connection</div> }))
vi.mock('../src/sidepanel/ThreadMenu', () => ({ ThreadMenu: () => null }))
vi.mock('../src/sidepanel/Icons', () => ({
  GearIcon: () => null,
  NoxMark: () => null,
  PageIcon: () => null,
  PencilIcon: () => null,
  PlusCircleIcon: () => null,
  SearchIcon: () => null,
  SparkleIcon: () => null,
}))
vi.mock('../src/lib/agent/panel', () => ({ agentLoop: { setOverrides: vi.fn() } }))
vi.mock('../src/lib/history/panel', () => ({ claimWindowRole: vi.fn(async () => 'owner') }))
vi.mock('../src/lib/log', () => ({ installLogCapture: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/sidepanel/codex-connect', () => ({ connectCodexAction: vi.fn(async () => undefined) }))
vi.mock('../src/lib/settings', () => ({
  applyTheme: vi.fn(),
  loadSettings: vi.fn(async () => ({})),
}))

import { App } from '../src/sidepanel/App'
import { EmptyState } from '../src/sidepanel/EmptyState'

describe('first-run setup', () => {
  beforeEach(() => {
    state.connectionStatus = 'disconnected'
    state.codexStatus = 'disconnected'
  })

  it('keeps chat behind the connection setup until both services are ready', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Welcome to Nox')
    expect(container.textContent).toContain('Notion connection')
    expect(container.textContent).toContain('Codex connection')
    expect(container.textContent).not.toContain('Chat ready')

    state.connectionStatus = 'connected'
    state.codexStatus = 'connected'
    await act(async () => root.render(<App />))

    expect(container.textContent).toContain('Chat ready')
    await act(async () => root.unmount())
  })

  it('offers summarizing the current page as the first chat action', () => {
    const html = renderToStaticMarkup(<EmptyState />)

    expect(html).toContain('aria-label="Summarize this page"')
  })
})
