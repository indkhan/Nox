import { useState } from 'react'
import { useNoxStore } from './store'
import { launchConsentFlow, notion } from '../lib/notion/panel'
import { logError, logInfo } from '../lib/log'
import { Button } from './ui/Button'

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
    try {
      await notion.signOut()
      setConnection({ connectionStatus: 'disconnected', identity: null, limitations: [], connectionError: null })
    } finally {
      setBusy(false)
    }
  }

  if (connectionStatus === 'connected' && identity) {
    return (
      <section className="rounded-card bg-surface p-3 shadow-card" data-testid="connection-card">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-wide text-green">Connected</p>
            <p className="truncate text-sm font-medium text-ink">
              {identity.workspaceName ?? 'Notion workspace'}
            </p>
            <p className="truncate text-xs text-ink-3">
              {[identity.userName, identity.email].filter(Boolean).join(' · ') || ' '}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
        {limitations.length > 0 && (
          <details className="mt-2 text-xs text-ink-2">
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
    <section className="rounded-card bg-surface p-3 shadow-card" data-testid="connection-card">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Notion</p>
      {connectionError ? (
        <p className="mb-2 text-xs leading-relaxed text-orange" data-testid="connection-error">{connectionError}</p>
      ) : (
        <p className="mb-2 text-[13px] text-ink-2">
          Connect your workspace so Nox can read and act on it.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button variant="accent" size="sm" onClick={() => void connect()} disabled={busy || connectionStatus === 'connecting'} data-testid="connect-button">
          {connectionStatus === 'connecting' ? 'Connecting…' : connectionStatus === 'error' ? 'Retry connect' : 'Connect Notion'}
        </Button>
        {import.meta.env.DEV && (
          <button onClick={() => void importDevToken()} className="text-xs text-ink-3 underline hover:text-ink">
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
