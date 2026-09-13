import { notion } from '../lib/notion/panel'
import { logError, logInfo } from '../lib/log'
import { useNoxStore } from './store'

/** Restores an existing Notion authorization without opening the OAuth UI. */
export async function restoreNotionAction(): Promise<void> {
  const setConnection = useNoxStore.getState().setConnection

  try {
    if (!(await notion.tokens.hasRefreshToken())) return

    setConnection({ connectionStatus: 'connecting', connectionError: null })
    logInfo('Notion restore: starting')

    let status: { active?: boolean; variant?: string; probe?: string } | undefined
    try {
      status = (await chrome.runtime.sendMessage({ type: 'nox/get-dnr-status' })) as typeof status
    } catch {
      logInfo('Notion restore: DNR status check unavailable; continuing')
    }
    if (status?.active === false) {
      throw new Error(
        `Origin-strip rule could not be verified (probe=${status.probe ?? 'none'}, variant=${status.variant ?? 'none'}). ` +
          'Reload the extension at chrome://extensions and retry.',
      )
    }

    const info = await notion.refreshIdentity()
    logInfo(`Notion restored: ${info.identity.workspaceName ?? info.identity.userName ?? 'workspace'}`)
    setConnection({
      connectionStatus: 'connected',
      identity: info.identity,
      limitations: collectLimitations(),
      connectionError: null,
    })
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const explained = notion.explain(error)
    const detail = explained.userMessage === raw ? raw : `${explained.userMessage} (${raw})`
    logError(`Notion restore failed: ${raw}`)
    setConnection({ connectionStatus: 'error', identity: null, limitations: [], connectionError: detail })
  }
}

/**
 * Wire token-store re-auth signals to connection UI (Epoch 11 / M8): rotation
 * that succeeded remotely but could not be persisted, or a terminal
 * invalid_grant, surfaces as a visible re-authentication error instead of a
 * silent connected state. Safe to call repeatedly; only the latest handler
 * stays wired.
 */
export function wireNotionReauthHandler(): void {
  const setHandler = (notion.tokens as { setReauthHandler?: (h: () => void) => void }).setReauthHandler
  if (typeof setHandler !== 'function') return
  setHandler.call(notion.tokens, () => {
    const state = useNoxStore.getState()
    state.setConnection({
      connectionStatus: 'error',
      identity: null,
      limitations: [],
      connectionError: 'Notion authorization needs to be reconnected — please connect again.',
    })
    void expireStaleNotionGrants()
  })
}

/** Drop stale plan/approval/baseline state after sign-out or re-auth (M8). */
async function expireStaleNotionGrants(): Promise<void> {
  try {
    const agent = await import('../lib/agent/panel')
    try {
      agent.agentLoop.cancel()
    } catch {
      /* best effort */
    }
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

/**
 * Cross-panel sign-out propagation (Epoch 11 / M8): when another panel clears
 * the durable refresh credential, this panel drops to disconnected, cancels
 * turns, and expires grants instead of silently retaining a stale session.
 * Uses chrome.storage events (extension contexts only); returns unsubscribe.
 */
export function watchCredentialSignout(): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => undefined
  const listener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return
    if (!('notion.refresh' in changes)) return
    if (changes['notion.refresh']?.newValue !== undefined) return
    // Durable credential cleared elsewhere — treat as sign-out.
    const state = useNoxStore.getState()
    if (state.connectionStatus === 'disconnected' && state.identity == null) return
    state.setConnection({ connectionStatus: 'disconnected', identity: null, limitations: [], connectionError: null })
    void expireStaleNotionGrants()
    logInfo('Notion sign-out observed in another panel — this panel disconnected')
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

function collectLimitations(): Array<{ tool: string; reason: string }> {
  const out: Array<{ tool: string; reason: string }> = []
  for (const state of ['upgrade_required', 'not_enabled'] as const) {
    for (const tool of notion.capabilities.toolsWith(state)) out.push({ tool, reason: state.replaceAll('_', ' ') })
  }
  for (const tool of notion.capabilities.toolsWith('available_with_limit')) {
    out.push({ tool, reason: 'limited by plan' })
  }
  return out
}
