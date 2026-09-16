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
  codexStatus: 'disconnected' as string,
  codexVersion: null as string | null,
  codexHint: null as string | null,
  activeThreadId: null as string | null,
  threadTitle: 'New chat',
  settingsOpen: false,
  agentBusy: false,
  currentPage: null as { pageId: string; title?: string; iconEmoji?: string; iconUrl?: string } | null,
  setSettingsOpen: vi.fn(),
  requestNewChat: vi.fn(),
  setOverrides: vi.fn(),
  loadSettings: vi.fn(async () => ({})),
  setConnection: vi.fn((update: Record<string, unknown>) => Object.assign(state, update)),
  hasRefreshToken: vi.fn(async () => true),
  refreshIdentity: vi.fn(async () => ({
    identity: { workspaceName: 'Acme', userName: 'Dana' },
    access: {},
    upgradeUrls: {},
  })),
  getDnrStatus: vi.fn(
    async (): Promise<{ installed: boolean; verified: boolean; active: boolean; reason?: string }> => ({
      installed: true,
      verified: false,
      active: true,
    }),
  ),
  clearDnr: vi.fn(async () => ({ cleared: true })),
}))

vi.hoisted(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})) } },
    runtime: {
      sendMessage: (message: unknown) => {
        if ((message as { type?: string })?.type === 'nox/clear-dnr') return state.clearDnr()
        return state.getDnrStatus()
      },
    },
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
    tokens: { hasRefreshToken: state.hasRefreshToken, setReauthHandler: vi.fn() },
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
vi.mock('../src/lib/agent/panel', () => ({ agentLoop: { setOverrides: state.setOverrides } }))
vi.mock('../src/lib/history/panel', () => ({ claimWindowRole: vi.fn(async () => 'owner') }))
vi.mock('../src/lib/log', () => ({ installLogCapture: vi.fn(), logError: vi.fn(), logInfo: vi.fn(), safeErrorDetail: vi.fn(() => 'mock-error') }))
vi.mock('../src/sidepanel/codex-connect', () => ({
  connectCodexAction: vi.fn(async () => undefined),
  reconnectCodexAction: vi.fn(async () => undefined),
  ensureCodexLifecycleSubscribed: vi.fn(() => () => undefined),
}))
vi.mock('../src/lib/settings', () => ({
  applyTheme: vi.fn(),
  loadSettings: state.loadSettings,
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
    state.codexVersion = null
    state.codexHint = null
    state.activeThreadId = null
    state.threadTitle = 'New chat'
    state.currentPage = null
    state.setConnection.mockClear()
    state.setOverrides.mockClear()
    state.loadSettings.mockReset().mockResolvedValue({})
    state.hasRefreshToken.mockReset().mockResolvedValue(true)
    state.refreshIdentity.mockReset().mockResolvedValue({
      identity: { workspaceName: 'Acme', userName: 'Dana' },
      access: {},
      upgradeUrls: {},
    })
    state.getDnrStatus.mockReset().mockResolvedValue({ installed: true, verified: false, active: true })
    state.clearDnr.mockReset().mockResolvedValue({ cleared: true })
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

  it('does not render a remote current-page icon', () => {
    state.currentPage = { pageId: 'page-1', title: 'Private page', iconUrl: 'https://attacker.invalid/icon.png' }
    const html = renderToStaticMarkup(<EmptyState />)

    expect(html).not.toContain('<img')
    expect(html).not.toContain('attacker.invalid')
  })

  it('waits for settings before enabling chat and applies a research-only opt-out', async () => {
    state.connectionStatus = 'connected'
    state.codexStatus = 'connected'
    let resolveSettings!: (settings: { webSearchEnabled: boolean }) => void
    state.loadSettings.mockReturnValueOnce(new Promise((resolve) => { resolveSettings = resolve }))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('Chat ready')

    await act(async () => {
      resolveSettings({ webSearchEnabled: false })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Chat ready')
    expect(state.setOverrides).toHaveBeenCalledWith({ webSearchEnabled: false, model: undefined, effort: undefined, serviceTier: undefined })
    await act(async () => root.unmount())
  })

  it('shows a retryable error instead of enabling chat when settings cannot load', async () => {
    state.connectionStatus = 'connected'
    state.codexStatus = 'connected'
    state.loadSettings.mockRejectedValueOnce(new Error('storage unavailable'))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('storage unavailable')
    expect(container.textContent).not.toContain('Chat ready')
    await act(async () => root.unmount())
  })

  it('restores a saved Notion connection when the owner panel starts', async () => {
    state.codexStatus = 'connected'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    // F3/R5 UI completion guard: pre-restore check plus post-identity
    // re-check before showing Connected.
    expect(state.hasRefreshToken).toHaveBeenCalledTimes(2)
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

  it('blocks restoration when the endpoint compatibility check is unavailable (Epoch 13 / M13)', async () => {
    // Changed contract: a failed DNR lookup no longer continues into
    // workspace operation. The reviewed behavior (continue on lookup failure)
    // is replaced by an actionable compatibility error with no identity load.
    state.codexStatus = 'connected'
    state.getDnrStatus.mockRejectedValueOnce(new Error('message port unavailable'))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.refreshIdentity).not.toHaveBeenCalled()
    expect(state.connectionStatus).toBe('error')
    expect(state.connectionError).toMatch(/compatibility check unavailable/i)
    await act(async () => root.unmount())
  })

  it('blocks restoration when the narrow rule is not installed (Epoch 13 / M13)', async () => {
    state.codexStatus = 'connected'
    state.getDnrStatus.mockResolvedValueOnce({ installed: false, verified: false, active: false, reason: 'mismatch' })
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.refreshIdentity).not.toHaveBeenCalled()
    expect(state.connectionStatus).toBe('error')
    expect(state.connectionError).toMatch(/compatibility not established/i)
    await act(async () => root.unmount())
  })

  it('restores through installed/unverified pre-OAuth status (Epoch 13 / M13)', async () => {
    state.codexStatus = 'connected'
    state.getDnrStatus.mockResolvedValueOnce({ installed: true, verified: false, active: true })
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    // Installed/unverified permits credential acquisition; the authorized
    // initialize inside refreshIdentity establishes acceptance.
    expect(state.refreshIdentity).toHaveBeenCalledOnce()
    expect(state.connectionStatus).toBe('connected')
    await act(async () => root.unmount())
  })

  it('blocks restoration when storage restriction is unavailable (Epoch 13 / L3)', async () => {
    state.codexStatus = 'connected'
    state.getDnrStatus.mockResolvedValueOnce({
      installed: true,
      verified: false,
      active: true,
      storageError: 'restriction unavailable',
    } as { installed: boolean; verified: boolean; active: boolean; storageError: string })
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(state.refreshIdentity).not.toHaveBeenCalled()
    expect(state.connectionStatus).toBe('error')
    expect(state.connectionError).toMatch(/storage restriction unavailable/i)
    await act(async () => root.unmount())
  })
})

describe('reconnect banner (Epoch 11 / L6)', () => {
  beforeEach(() => {
    state.connectionStatus = 'disconnected'
    state.connectionError = null
    state.identity = null
    state.limitations = []
    state.codexStatus = 'disconnected'
    state.codexVersion = null
    state.codexHint = 'Codex disconnected'
    state.activeThreadId = null
    state.threadTitle = 'New chat'
    state.currentPage = null
    state.loadSettings.mockReset().mockResolvedValue({})
  })

  it('keeps the interrupted conversation visible with a reconnect banner instead of a blank setup screen', async () => {
    // Prior session: Codex was connected (version preserved) with history.
    state.codexVersion = 'codex/test'
    state.activeThreadId = 'thread-1'
    state.threadTitle = 'Plain A edit'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    // Conversation stays visible; setup screen does not replace it.
    expect(container.textContent).toContain('Chat ready')
    expect(container.textContent).not.toContain('Welcome to Nox')
    const banner = container.querySelector('[data-testid="reconnect-banner"]')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toMatch(/history is preserved/i)
    expect(banner?.textContent).toMatch(/no turn was replayed/i)
    await act(async () => root.unmount())
  })

  it('still uses the setup screen for initial onboarding with no prior session', async () => {
    state.codexVersion = null
    state.activeThreadId = null
    state.threadTitle = 'New chat'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Welcome to Nox')
    expect(container.querySelector('[data-testid="reconnect-banner"]')).toBeNull()
    await act(async () => root.unmount())
  })
})
