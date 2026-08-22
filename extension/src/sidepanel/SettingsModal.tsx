import { useEffect, useState } from 'react'
import { useNoxStore } from './store'
import { codex } from '../lib/codex/panel'
import type { ModelInfo } from '../lib/codex/client'
import { loadSettings, saveSettings, type NoxSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settings, setSettings] = useState<NoxSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const stored = await loadSettings()
      setSettings(stored)
      if (codexStatus === 'connected') {
        try {
          setModels(await codex.listModels())
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
      setLoaded(true)
    })()
  }, [codexStatus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function apply(next: NoxSettings) {
    setSettings(next)
    agentLoop.setOverrides({ model: next.model, effort: next.effort })
    void saveSettings(next)
  }

  const selectedModel = models.find((m) => m.id === settings.model) ?? models.find((m) => m.isDefault)
  const efforts = selectedModel?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh']

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings-modal">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" data-testid="settings-close" className="text-zinc-500 hover:text-zinc-300">×</button>
        </div>

        <section>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Model</h3>
          {!loaded ? (
            <p className="text-xs text-zinc-500">Loading…</p>
          ) : models.length === 0 ? (
            <p className="text-xs text-zinc-500">
              {error ? `Could not load models: ${error}` : 'Connect Codex to see the models your account exposes.'}
            </p>
          ) : (
            <select
              value={selectedModel?.id}
              onChange={(e) => apply({ ...settings, model: e.target.value })}
              aria-label="Model"
              data-testid="model-select"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName ?? m.id}{m.isDefault ? ' — account default' : ''}
                </option>
              ))}
            </select>
          )}
          {selectedModel?.description && <p className="mt-1 text-[11px] leading-snug text-zinc-500">{selectedModel.description}</p>}
        </section>

        <section>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Reasoning effort</h3>
          <select
            value={settings.effort ?? 'low'}
            onChange={(e) => apply({ ...settings, effort: e.target.value })}
            aria-label="Reasoning effort"
            data-testid="effort-select"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
          >
            {efforts.map((effort) => (
              <option key={effort} value={effort}>{effort}</option>
            ))}
          </select>
        </section>

        <section className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-[11px] text-zinc-500">
          <p>Codex stores its own conversation history under <code>~/.codex</code> on this machine.</p>
          <p className="mt-1">Nox keeps chat history in your browser only.</p>
        </section>
      </div>
    </div>
  )
}
