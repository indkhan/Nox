import { useState } from 'react'
import { useNoxStore } from './store'
import { launchConsentFlow, notion } from '../lib/notion/panel'
import { logError, logInfo } from '../lib/log'
import { agentLoop, expireAgentGrants, planEngine, writeGate } from '../lib/agent/panel'

/** Dev-only: paste a token JSON (from spikes/.notion-token.json) to skip consent. */
async function importDevToken(): Promise<void> {
  const raw = window.prompt('Paste token JSON {access_token, refresh_token, expires_in}')
  if (!raw) return
  await notion.importToken(JSON.parse(raw))
}

export function ConnectionCard() {
  const { connectionStatus, identity, limitations, connectionError } = useNoxStore((s) => s)
  const setConnection = useNoxStore((s) => s.setConnection)
  const [busy, setBusy] = useState(false)

  async function connect() {
    setConnection({ connectionStatus: 'connecting', connectionError: null })
    setBusy(true)
    logInfo('Notion connect: starting')
    try {
      // Load-bearing precondition (RESEARCH §2.1): the narrow origin-strip
      // rule must be installed. This is endpoint compatibility preparation,
      // not header observation: installed/unverified pre-OAuth, with
      // authenticated acceptance established by the authorized initialize
      // after credential acquisition. Lookup failure blocks (M13).
      try {
        const status = (await chrome.runtime.sendMessage({ type: 'nox/get-dnr-status' })) as
          | { installed?: boolean; verified?: boolean; reason?: string }
          | undefined
        if (status?.installed !== true) {
          throw new Error(
            `Notion endpoint compatibility not established (installed=${String(status?.installed ?? 'unknown')}, reason=${status?.reason ?? 'none'}). ` +
              'Reload the extension at chrome://extensions and retry; the narrow rule will be reinstalled.',
          )
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('endpoint compatibility')) throw e
        throw new Error(
          `Endpoint compatibility check unavailable (${e instanceof Error ? e.message : String(e)}). ` +
            'Reload the extension at chrome://extensions and retry.',
        )
      }

      let info: Awaited<ReturnType<typeof notion.connect>>
      try {
        info = await notion.connect(launchConsentFlow)
      } catch (e) {
        // Failed acceptance (including 401/403/429/5xx/redirect/malformed/
        // missing): clear the rule so retry reinstalls narrowly. No tokens sent.
        try {
          await chrome.runtime.sendMessage({ type: 'nox/clear-dnr' })
        } catch {
          // Best effort; the error below already blocks workspace operation.
        }
        throw e
      }
      logInfo(`Notion connected: ${info.identity.workspaceName ?? info.identity.userName ?? 'workspace'}`)
      setConnection({
        connectionStatus: 'connected',
        identity: info.identity,
        limitations: collectLimitations(notion),
      })
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      console.error('[nox] Notion connect failed:', e)
      logError(`Notion connect failed: ${raw}`)
      const explained = notion.explain(e)
      // Friendly line + raw hop-level detail ([discovery]/[register]/[consent]/…)
      const detail = explained.userMessage === raw ? raw : `${explained.userMessage} (${raw})`
      setConnection({ connectionStatus: 'error', connectionError: detail })
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    logInfo('Notion disconnect')
    // Cancel active turns/grants first so no new mutation can dispatch while
    // credentials are being invalidated (Epoch 11 / M8).
    try {
      agentLoop.cancel()
    } catch {
      /* best effort */
    }
    try {
      planEngine.invalidateApproval()
      planEngine.rejectPending()
      writeGate.approvals.rejectAllPending()
      writeGate.expireBaselines()
      expireAgentGrants()
    } catch {
      /* best effort — sign-out hygiene still proceeds */
    }
    try {
      await notion.signOut()
      setConnection({ connectionStatus: 'disconnected', identity: null, limitations: [], connectionError: null })
    } catch (e) {
      // Storage-clear failure is visible, never reported as complete (M8).
      const message = e instanceof Error ? e.message : String(e)
      logError(`Notion disconnect failed: ${message}`)
      setConnection({
        connectionStatus: 'error',
        identity: null,
        limitations: [],
        connectionError: `Sign-out did not complete: ${message}`,
      })
    } finally {
      setBusy(false)
    }
  }

  if (connectionStatus === 'connected' && identity) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3" data-testid="connection-card">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Connected</p>
            <p className="truncate text-sm font-medium">
              {identity.workspaceName ?? 'Notion workspace'}
            </p>
            <p className="truncate text-xs text-zinc-500">
              {[identity.userName, identity.email].filter(Boolean).join(' · ') || ' '}
            </p>
          </div>
          <button
            onClick={disconnect}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
        {limitations.length > 0 && (
          <details className="mt-2 text-xs text-zinc-400">
            <summary className="cursor-pointer select-none">Plan limitations ({limitations.length})</summary>
            <ul className="mt-1 list-disc pl-4">
              {limitations.map((l) => (
                <li key={l.tool}>
                  <span className="font-mono">{l.tool}</span> — {l.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3" data-testid="connection-card">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Notion</p>
      {connectionError ? (
        <p className="nox-warning mb-2 text-xs" data-testid="connection-error">{connectionError}</p>
      ) : (
        <p className="mb-2 text-sm text-zinc-400">
          Connect your workspace so Nox can read and act on it.
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={connect}
          disabled={busy || connectionStatus === 'connecting'}
          data-testid="connect-button"
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {connectionStatus === 'connecting' ? 'Connecting…' : connectionStatus === 'error' ? 'Retry connect' : 'Connect Notion'}
        </button>
        {import.meta.env.DEV && (
          <button onClick={() => void importDevToken()} className="text-xs text-zinc-500 underline hover:text-zinc-300">
            dev: import token
          </button>
        )}
      </div>
    </section>
  )
}

function collectLimitations(instance: typeof notion): Array<{ tool: string; reason: string }> {
  const out: Array<{ tool: string; reason: string }> = []
  for (const state of ['upgrade_required', 'not_enabled'] as const) {
    for (const tool of instance.capabilities.toolsWith(state)) out.push({ tool, reason: state.replaceAll('_', ' ') })
  }
  for (const tool of instance.capabilities.toolsWith('available_with_limit')) {
    out.push({ tool, reason: 'limited by plan' })
  }
  return out
}
