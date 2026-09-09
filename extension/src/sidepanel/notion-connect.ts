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
