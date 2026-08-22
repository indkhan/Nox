import { useState } from 'react'
import { useNoxStore } from './store'
import { launchConsentFlow, notion } from '../lib/notion/panel'

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
    try {
      // Load-bearing precondition (RESEARCH §2.1): a working origin-strip rule.
      // The SW self-probes rule variants; failure detail flows into the error.
      try {
        const status = (await chrome.runtime.sendMessage({ type: 'nox/get-dnr-status' })) as
          | { active?: boolean; variant?: string; probe?: string }
          | undefined
        if (status?.active === false) {
          throw new Error(
            `Origin-strip rule could not be verified (probe=${status.probe ?? 'none'}, variant=${status.variant ?? 'none'}). ` +
              'Reload the extension at chrome://extensions and retry.',
          )
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Origin-strip')) throw e
        console.warn('[nox] DNR status check failed; continuing anyway', e)
      }

      const info = await notion.connect(launchConsentFlow)
      setConnection({
        connectionStatus: 'connected',
        identity: info.identity,
        limitations: collectLimitations(notion),
      })
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      console.error('[nox] Notion connect failed:', e)
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
    try {
      await notion.signOut()
      setConnection({ connectionStatus: 'disconnected', identity: null, limitations: [], connectionError: null })
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
        <p className="mb-2 text-xs text-amber-400" data-testid="connection-error">{connectionError}</p>
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
