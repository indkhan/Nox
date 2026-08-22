// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: 'unknown',
  connect: vi.fn(async () => ({ userAgent: 'codex/test', models: [{ id: 'm1' }] })),
  disconnect: vi.fn(),
  setCodex: vi.fn((update: { codexStatus?: string }) => { if (update.codexStatus) state.status = update.codexStatus }),
}))

vi.mock('../src/sidepanel/store', () => ({
  useNoxStore: { getState: () => ({ codexStatus: state.status, setCodex: state.setCodex }) },
}))
vi.mock('../src/lib/codex/panel', () => ({ connectCodex: state.connect, bridge: { disconnect: state.disconnect } }))
vi.mock('../src/lib/codex/health', () => ({ classifyBridgeFailure: () => 'unknown', healthHint: () => '' }))
vi.mock('../src/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

describe('connectCodexAction', () => {
  beforeEach(() => {
    state.status = 'unknown'
    state.connect.mockClear()
    state.disconnect.mockClear()
    state.setCodex.mockClear()
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
