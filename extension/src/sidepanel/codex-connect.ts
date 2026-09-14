import { useNoxStore } from './store'
import { connectCodex, bridge } from '../lib/codex/panel'
import { classifyBridgeFailure, healthHint } from '../lib/codex/health'
import { logError, logInfo, safeErrorDetail } from '../lib/log'

let connecting: Promise<void> | null = null
let lifecycleSubscribed = false
let lifecycleGeneration = 0
let activeLifecycleGeneration = 0
let reconnectGeneration = 0
let activeReconnectGeneration = 0

/**
 * Subscribe once to native lifecycle events (Epoch 11 / L6): bridge
 * disconnects and exited/dead statuses downgrade the store from transport
 * reality instead of leaving a stale "Connected". Stale-generation events
 * (from a previous connect attempt) are ignored. Returns an unsubscribe that
 * restores previous handlers and allows a fresh subscription.
 */
export function ensureCodexLifecycleSubscribed(): () => void {
  if (lifecycleSubscribed) return () => undefined
  lifecycleSubscribed = true
  const gen = ++lifecycleGeneration
  activeLifecycleGeneration = gen
  const prevDisconnected = bridge.onBridgeDisconnected
  const prevStatus = bridge.onStatus
  const markDisconnected = () => {
    if (gen !== activeLifecycleGeneration) return
    const state = useNoxStore.getState()
    if (state.codexStatus === 'connected' || state.codexStatus === 'connecting') {
      state.setCodex({
        codexStatus: 'disconnected',
        codexHint: 'Codex disconnected. Reconnect to continue — your history is preserved and no turn was replayed.',
      })
    }
  }
  bridge.onBridgeDisconnected = () => {
    try {
      prevDisconnected?.()
    } finally {
      markDisconnected()
    }
  }
  bridge.onStatus = (event) => {
    try {
      prevStatus?.(event)
    } finally {
      if (event.state === 'exited' || event.state === 'dead') markDisconnected()
    }
  }
  return () => {
    if (gen !== activeLifecycleGeneration) return
    bridge.onBridgeDisconnected = prevDisconnected
    bridge.onStatus = prevStatus
    lifecycleSubscribed = false
  }
}

/** Test-only reset for lifecycle subscription state (no transport touched). */
export function __resetCodexConnectForTests(): void {
  lifecycleSubscribed = false
  connecting = null
  lifecycleGeneration = 0
  activeLifecycleGeneration = 0
  reconnectGeneration = 0
  activeReconnectGeneration = 0
}

/** Single-flight connection to the Codex bridge, mirrored into the store. */
export function connectCodexAction(): Promise<void> {
  if (useNoxStore.getState().codexStatus === 'connected') return Promise.resolve()
  if (connecting) return connecting
  connecting = connect().finally(() => { connecting = null })
  return connecting
}

/**
 * Explicit reconnect (Epoch 11 / L6): clears stale transport/client state and
 * lists models again even when the UI still says connected. Preserves visible
 * history and the stored Codex thread ID, never resubmits the failed turn,
 * reapplies effective research/model settings, and expires old
 * plan/Auto/upload grants and baselines.
 */
export async function reconnectCodexAction(): Promise<void> {
  if (connecting) {
    await connecting.catch(() => undefined)
  }
  if (connecting) return connecting
  // Separate generation for stale reconnect completions; the lifecycle
  // subscription stays valid across reconnects (old-port disconnects are
  // filtered by the bridge's own port identity, not by invalidating UI).
  const gen = ++reconnectGeneration
  activeReconnectGeneration = gen
  connecting = reconnect(gen).finally(() => { connecting = null })
  return connecting
}

async function connect(): Promise<void> {
  ensureCodexLifecycleSubscribed()
  const setCodex = useNoxStore.getState().setCodex
  logInfo('Codex connect: starting bridge')
  setCodex({ codexStatus: 'connecting', codexHint: null })
  try {
    const session = await connectCodex()
    logInfo(`Codex connected: ${session.userAgent} (${session.models.length} models)`)
    setCodex({
      codexStatus: 'connected',
      codexVersion: session.userAgent,
      codexModelCount: session.models.length,
      codexHint: null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const health = classifyBridgeFailure(message)
    logError(`Codex connect failed: ${safeErrorDetail(e)}`)
    // Leave the port clean for the next attempt.
    try {
      bridge.disconnect()
    } catch {
      /* already gone */
    }
    setCodex({
      codexStatus: 'error',
      codexHint: healthHint(health) || message,
    })
  }
}

async function reconnect(generation: number): Promise<void> {
  ensureCodexLifecycleSubscribed()
  const setCodex = useNoxStore.getState().setCodex
  logInfo('Codex reconnect: clearing stale transport state')
  setCodex({ codexStatus: 'connecting', codexHint: null })
  try {
    try {
      bridge.disconnect()
    } catch {
      /* already gone — listing models again still re-establishes reality */
    }
    const session = await connectCodex()
    if (generation !== activeReconnectGeneration) return
    logInfo(`Codex reconnected: ${session.userAgent} (${session.models.length} models)`)
    // Reapply effective research/model settings so a reconnect does not
    // silently re-enable web research (C02/C14). Dynamic imports keep this
    // assembly module free of agent/settings cycles in unit tests.
    try {
      const [{ loadSettings }, agent] = await Promise.all([import('../lib/settings'), import('../lib/agent/panel')])
      const settings = await loadSettings()
      agent.agentLoop.setOverrides({
        webSearchEnabled: settings.webSearchEnabled,
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
      })
    } catch {
      /* settings reapply is best-effort; connection itself succeeded */
    }
    await expireStaleGrants()
    setCodex({
      codexStatus: 'connected',
      codexVersion: session.userAgent,
      codexModelCount: session.models.length,
      codexHint: null,
    })
  } catch (e) {
    if (generation !== activeReconnectGeneration) return
    const message = e instanceof Error ? e.message : String(e)
    const health = classifyBridgeFailure(message)
    logError(`Codex reconnect failed: ${safeErrorDetail(e)}`)
    try {
      bridge.disconnect()
    } catch {
      /* already gone */
    }
    setCodex({
      codexStatus: 'error',
      codexHint: healthHint(health) || message,
    })
  }
}

/** Drop stale plan/Auto/upload approvals and read baselines after reconnect. */
async function expireStaleGrants(): Promise<void> {
  try {
    const agent = await import('../lib/agent/panel')
    try {
      agent.planEngine.invalidateApproval()
    } catch {
      /* best effort */
    }
    try {
      agent.planEngine.rejectPending()
    } catch {
      /* best effort */
    }
    try {
      agent.writeGate.approvals.rejectAllPending()
    } catch {
      /* best effort */
    }
    try {
      agent.writeGate.expireBaselines()
    } catch {
      /* best effort */
    }
    try {
      agent.expireAgentGrants()
    } catch {
      /* best effort */
    }
  } catch {
    /* agent assembly unavailable in isolated unit tests */
  }
  try {
    const state = useNoxStore.getState()
    for (const approval of [...state.pendingApprovals]) state.removeApproval(approval.id)
    for (const plan of [...state.pendingPlans]) state.removePlan(plan.id)
  } catch {
    /* UI cleanup is best-effort */
  }
}
