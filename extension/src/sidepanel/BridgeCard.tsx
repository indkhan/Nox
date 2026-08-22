import { useState } from 'react'
import { useNoxStore } from './store'
import { connectCodexAction } from './codex-connect'

export function BridgeCard() {
  const { codexStatus, codexVersion, codexModelCount, codexHint } = useNoxStore((s) => s)
  const [busy, setBusy] = useState(false)

  async function connect() {
    setBusy(true)
    try {
      await connectCodexAction()
    } finally {
      setBusy(false)
    }
  }

  if (codexStatus === 'connected') {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3" data-testid="bridge-card">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Codex</p>
        <p className="nox-success text-sm font-medium" data-testid="bridge-status">
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
        <p className="nox-warning mb-2 text-xs" data-testid="bridge-hint">{codexHint}</p>
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
