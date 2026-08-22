import { useState } from 'react'
import { useNoxStore } from './store'
import { connectCodex, bridge, codex, type CodexSession } from '../lib/codex/panel'
import { classifyBridgeFailure, healthHint } from '../lib/codex/health'
import { logError, logInfo } from '../lib/log'

export function BridgeCard() {
  const setCodex = useNoxStore((s) => s.setCodex)
  const { codexStatus, codexVersion, codexModelCount, codexHint } = useNoxStore((s) => s)
  const [busy, setBusy] = useState(false)

  async function connect() {
    setBusy(true)
    logInfo('Codex connect: starting bridge')
    setCodex({ codexStatus: 'connecting', codexHint: null })
    try {
      const session: CodexSession = await connectCodex()
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
      logError(`Codex connect failed: ${message}`)
      // Leave the port clean for the next attempt.
      try {
        bridge.disconnect()
      } catch {
        /* already gone */
      }
      void codex
      setCodex({
        codexStatus: 'error',
        codexHint: healthHint(health) || message,
      })
    } finally {
      setBusy(false)
    }
  }

  if (codexStatus === 'connected') {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3" data-testid="bridge-card">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Codex</p>
        <p className="text-sm font-medium text-emerald-400" data-testid="bridge-status">
          Connected — {codexVersion}
        </p>
        <p className="text-xs text-zinc-500">{codexModelCount} models available</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3" data-testid="bridge-card">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Codex</p>
      {codexHint ? (
        <p className="mb-2 text-xs text-amber-400" data-testid="bridge-hint">{codexHint}</p>
      ) : (
        <p className="mb-2 text-sm text-zinc-400">Connect to your local Codex install.</p>
      )}
      <button
        onClick={connect}
        disabled={busy || codexStatus === 'connecting'}
        data-testid="bridge-connect"
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {codexStatus === 'connecting' ? 'Connecting…' : codexStatus === 'error' ? 'Retry' : 'Connect Codex'}
      </button>
    </section>
  )
}
