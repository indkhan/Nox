// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: 'unknown' as string,
  version: null as string | null,
  modelCount: 0,
  hint: null as string | null,
  pendingApprovals: [] as Array<{ id: number }>,
  pendingPlans: [] as Array<{ id: string }>,
  connect: vi.fn(async () => ({ userAgent: 'codex/test', models: [{ id: 'm1' }] })),
  bridge: {
    disconnect: vi.fn(),
    onBridgeDisconnected: null as (() => void) | null,
    onStatus: null as ((e: { state: string }) => void) | null,
  },
  setCodex: vi.fn((update: Record<string, unknown>) => {
    if (update.codexStatus) state.status = update.codexStatus as string
    if ('codexVersion' in update) state.version = update.codexVersion as string | null
    if ('codexModelCount' in update) state.modelCount = update.codexModelCount as number
    if ('codexHint' in update) state.hint = update.codexHint as string | null
  }),
  removeApproval: vi.fn(),
  removePlan: vi.fn(),
  setOverrides: vi.fn(),
  loadSettings: vi.fn(async () => ({ webSearchEnabled: false, model: undefined, effort: undefined, serviceTier: undefined })),
  invalidateApproval: vi.fn(),
  rejectPending: vi.fn(),
  rejectAllPending: vi.fn(),
  expireBaselines: vi.fn(),
  expireGrants: vi.fn(),
}))

vi.mock('../src/sidepanel/store', () => ({
  useNoxStore: {
    getState: () => ({
      codexStatus: state.status,
      codexVersion: state.version,
      codexModelCount: state.modelCount,
      codexHint: state.hint,
      pendingApprovals: state.pendingApprovals,
      pendingPlans: state.pendingPlans,
      setCodex: state.setCodex,
      removeApproval: state.removeApproval,
      removePlan: state.removePlan,
    }),
  },
}))
vi.mock('../src/lib/codex/panel', () => ({ connectCodex: state.connect, bridge: state.bridge }))
vi.mock('../src/lib/codex/health', () => ({ classifyBridgeFailure: () => 'unknown', healthHint: () => '' }))
vi.mock('../src/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn(), safeErrorDetail: vi.fn(() => 'mock-error') }))
vi.mock('../src/lib/settings', () => ({ loadSettings: state.loadSettings }))
vi.mock('../src/lib/agent/panel', () => ({
  agentLoop: { setOverrides: state.setOverrides },
  planEngine: { invalidateApproval: state.invalidateApproval, rejectPending: state.rejectPending },
  writeGate: { approvals: { rejectAllPending: state.rejectAllPending }, expireBaselines: state.expireBaselines },
  expireAgentGrants: state.expireGrants,
}))

describe('connectCodexAction', () => {
  beforeEach(async () => {
    state.status = 'unknown'
    state.version = null
    state.modelCount = 0
    state.hint = null
    state.pendingApprovals = []
    state.pendingPlans = []
    state.connect.mockClear()
    state.bridge.disconnect.mockClear()
    state.bridge.onBridgeDisconnected = null
    state.bridge.onStatus = null
    state.setCodex.mockClear()
    state.removeApproval.mockClear()
    state.removePlan.mockClear()
    state.setOverrides.mockClear()
    state.loadSettings.mockClear()
    state.invalidateApproval.mockClear()
    state.rejectPending.mockClear()
    state.rejectAllPending.mockClear()
    state.expireBaselines.mockClear()
    state.expireGrants.mockClear()
    const mod = await import('../src/sidepanel/codex-connect')
    mod.__resetCodexConnectForTests()
  })

  it('deduplicates concurrent connection attempts', async () => {
    const { connectCodexAction } = await import('../src/sidepanel/codex-connect')
    await Promise.all([connectCodexAction(), connectCodexAction()])
    expect(state.connect).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect an already connected session', async () => {
    state.status = 'connected'
    const { connectCodexAction } = await import('../src/sidepanel/codex-connect')
    await connectCodexAction()
    expect(state.connect).not.toHaveBeenCalled()
  })
})

describe('codex lifecycle (Epoch 11 / L6)', () => {
  beforeEach(async () => {
    state.status = 'unknown'
    state.version = null
    state.hint = null
    state.connect.mockClear()
    state.bridge.disconnect.mockClear()
    state.bridge.onBridgeDisconnected = null
    state.bridge.onStatus = null
    state.setCodex.mockClear()
    state.setOverrides.mockClear()
    state.loadSettings.mockClear()
    state.invalidateApproval.mockClear()
    state.expireBaselines.mockClear()
    state.expireGrants.mockClear()
    const mod = await import('../src/sidepanel/codex-connect')
    mod.__resetCodexConnectForTests()
  })

  it('a native disconnect downgrades a connected panel to disconnected with history preserved', async () => {
    const mod = await import('../src/sidepanel/codex-connect')
    state.status = 'connected'
    state.version = 'codex/test'
    mod.ensureCodexLifecycleSubscribed()
    state.bridge.onBridgeDisconnected?.()
    expect(state.status).toBe('disconnected')
    // History identity (version) is preserved for the reconnect banner.
    expect(state.version).toBe('codex/test')
    expect(state.hint).toMatch(/history is preserved/i)
  })

  it('ignores stale disconnects when already disconnected', async () => {
    const mod = await import('../src/sidepanel/codex-connect')
    state.status = 'disconnected'
    state.hint = 'old-hint'
    mod.ensureCodexLifecycleSubscribed()
    state.setCodex.mockClear()
    state.bridge.onBridgeDisconnected?.()
    // No redundant store write for a stale/duplicate event.
    expect(state.setCodex).not.toHaveBeenCalled()
    expect(state.status).toBe('disconnected')
  })

  it('reconnect forces a fresh transport + model list even when the UI still says connected', async () => {
    const mod = await import('../src/sidepanel/codex-connect')
    state.status = 'connected'
    state.version = 'codex/old'
    await mod.reconnectCodexAction()
    expect(state.bridge.disconnect).toHaveBeenCalled()
    expect(state.connect).toHaveBeenCalledTimes(1)
    expect(state.status).toBe('connected')
    expect(state.version).toBe('codex/test')
  })

  it('reconnect reapplies research-off settings and expires old grants/baselines without replay', async () => {
    const mod = await import('../src/sidepanel/codex-connect')
    state.status = 'connected'
    await mod.reconnectCodexAction()
    expect(state.loadSettings).toHaveBeenCalled()
    expect(state.setOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ webSearchEnabled: false }),
    )
    expect(state.invalidateApproval).toHaveBeenCalled()
    expect(state.expireBaselines).toHaveBeenCalled()
    expect(state.expireGrants).toHaveBeenCalled()
    // Reconnect only lists models; it never starts a turn (no replay).
    expect(state.connect).toHaveBeenCalledTimes(1)
  })
})
