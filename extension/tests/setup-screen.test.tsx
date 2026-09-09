// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  connectionStatus: 'disconnected',
  connectionError: null as string | null,
  identity: null as { workspaceName?: string; userName?: string } | null,
  limitations: [] as Array<{ tool: string; reason: string }>,
  codexStatus: 'disconnected',
  threadTitle: 'New chat',
  settingsOpen: false,
  agentBusy: false,
  setSettingsOpen: vi.fn(),
  requestNewChat: vi.fn(),
  setConnection: vi.fn((update: Record<string, unknown>) => Object.assign(state, update)),
  hasRefreshToken: vi.fn(async () => true),
  refreshIdentity: vi.fn(async () => ({
    identity: { workspaceName: 'Acme', userName: 'Dana' },
    access: {},
    upgradeUrls: {},
  })),
  getDnrStatus: vi.fn(async () => ({ active: true })),
}))

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})) } },
    runtime: { sendMessage: state.getDnrStatus },
  })
})

vi.mock('../src/sidepanel/store', () => ({
  hydrateCurrentPage: vi.fn(async () => undefined),
  useNoxStore: Object.assign(
    (select: (value: typeof state) => unknown) => select(state),
    { getState: () => state },
  ),
}))
vi.mock('../src/lib/notion/panel', () => ({
  notion: {
    tokens: { hasRefreshToken: state.hasRefreshToken },
    refreshIdentity: state.refreshIdentity,
    capabilities: { toolsWith: vi.fn(() => []) },
    explain: vi.fn((error: Error) => ({ userMessage: error.message })),
  },
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
vi.mock('../src/lib/log', () => ({ installLogCapture: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
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
    state.connectionError = null
    state.identity = null
    state.limitations = []
    state.codexStatus = 'disconnected'
    state.setConnection.mockClear()
    state.hasRefreshToken.mockReset().mockResolvedValue(true)
    state.refreshIdentity.mockReset().mockResolvedValue({
      identity: { workspaceName: 'Acme', userName: 'Dana' },
      access: {},
      upgradeUrls: {},
    })
    state.getDnrStatus.mockReset().mockResolvedValue({ active: true })
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

  it('restores a saved Notion connection when the owner panel starts', async () => {
    state.codexStatus = 'connected'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.hasRefreshToken).toHaveBeenCalledOnce()
    expect(state.refreshIdentity).toHaveBeenCalledOnce()
    expect(state.connectionStatus).toBe('connected')
    expect(state.identity).toEqual({ workspaceName: 'Acme', userName: 'Dana' })
    await act(async () => root.unmount())
  })

  it('stays disconnected without a saved Notion connection', async () => {
    state.codexStatus = 'connected'
    state.hasRefreshToken.mockResolvedValueOnce(false)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.hasRefreshToken).toHaveBeenCalledOnce()
    expect(state.refreshIdentity).not.toHaveBeenCalled()
    expect(state.connectionStatus).toBe('disconnected')
    await act(async () => root.unmount())
  })

  it('shows a retryable error when silent Notion restoration fails', async () => {
    state.codexStatus = 'connected'
    state.refreshIdentity.mockRejectedValueOnce(new Error('invalid_grant'))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.connectionStatus).toBe('error')
    expect(state.connectionError).toContain('invalid_grant')
    await act(async () => root.unmount())
  })

  it('continues restoration while the background status check is waking up', async () => {
    state.codexStatus = 'connected'
    state.getDnrStatus.mockRejectedValueOnce(new Error('message port unavailable'))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.refreshIdentity).toHaveBeenCalledOnce()
    expect(state.connectionStatus).toBe('connected')
    await act(async () => root.unmount())
  })
})
