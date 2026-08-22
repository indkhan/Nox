import { useState } from 'react'
import { useNoxStore } from './store'
import { connectCodex, bridge, codex, type CodexSession } from '../lib/codex/panel'
import { classifyBridgeFailure, healthHint } from '../lib/codex/health'
import { logError, logInfo } from '../lib/log'
import { Button } from './ui/Button'

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
      <section className="rounded-card bg-surface p-3 shadow-card" data-testid="bridge-card">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Codex</p>
        <p className="text-sm font-medium text-green" data-testid="bridge-status">
          Connected — {codexVersion}
        </p>
        <p className="text-xs text-ink-3">{codexModelCount} models available</p>
      </section>
    )
  }

  return (
    <section className="rounded-card bg-surface p-3 shadow-card" data-testid="bridge-card">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Codex</p>
      {codexHint ? (
        <p className="mb-2 text-xs leading-relaxed text-orange" data-testid="bridge-hint">{codexHint}</p>
      ) : (
        <p className="mb-2 text-[13px] text-ink-2">Connect to your local Codex install.</p>
      )}
      <Button variant="accent" size="sm" onClick={() => void connect()} disabled={busy || codexStatus === 'connecting'} data-testid="bridge-connect">
        {codexStatus === 'connecting' ? 'Connecting…' : codexStatus === 'error' ? 'Retry' : 'Connect Codex'}
      </Button>
    </section>
  )
}
