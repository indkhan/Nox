import { useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'
import { codex } from '../lib/codex/panel'
import type { ModelInfo } from '../lib/codex/client'
import { loadSettings, saveSettings, type NoxSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'
import { ArrowUpIcon, ChevronDownIcon, PageIcon, SignalBarsIcon, StopIcon } from './Icons'

export type Mode = 'ask' | 'auto'

export function Composer({
  busy,
  readOnly = false,
  onSend,
  onCancel,
}: {
  busy: boolean
  readOnly?: boolean
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const currentPage = useNoxStore((s) => s.currentPage)
  const setCurrentPage = useNoxStore((s) => s.setCurrentPage)
  const mode = useNoxStore((s) => s.mode)
  const setMode = useNoxStore((s) => s.setMode)

  // Autosize to content up to a max height.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [value])

  function submit() {
    const text = value.trim()
    if (!text || busy || readOnly) return
    onSend(text)
    setValue('')
  }

  return (
    <div className="p-2.5" data-testid="composer-root">
      <div className="rounded-2xl border border-zinc-700 bg-zinc-900 px-3 pb-2 pt-2.5 transition-colors focus-within:border-sky-500">
        {currentPage && (
          <div className="mb-1">
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
              data-testid="context-pill"
            >
              <PageIcon className="h-3 w-3 shrink-0 text-zinc-400" />
              <span className="truncate">{currentPage.title ?? currentPage.pageId}</span>
              <button
                onClick={() => setCurrentPage(null)}
                aria-label="Remove current page context"
                className="ml-0.5 text-zinc-500 hover:text-zinc-200"
              >
                ×
              </button>
            </span>
          </div>
        )}
        <textarea
          disabled={readOnly}
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder="Do anything with AI..."
          aria-label="Message Nox"
          data-testid="composer"
          className="w-full resize-none bg-transparent px-0.5 text-sm leading-relaxed outline-none placeholder:text-zinc-600"
        />
        <div className="mt-1 flex items-center gap-0.5">
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
              Model settings
            </summary>
            <div className="absolute bottom-8 left-0 z-10 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
              <ModelControls disabled={readOnly} />
            </div>
          </details>
          <span className="flex-1" />
          {busy && (
            <span aria-hidden="true" className="mr-1 text-zinc-500">
              <SignalBarsIcon />
            </span>
          )}
          <select
            disabled={readOnly}
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            aria-label="Change mode"
            data-testid="mode-selector"
            className="cursor-pointer appearance-none rounded-md px-1 py-0.5 text-xs text-zinc-300 outline-none hover:bg-zinc-800"
          >
            <option value="ask">Ask before changes</option>
            <option value="auto">Auto</option>
          </select>
          {busy ? (
            <button
              onClick={onCancel}
              aria-label="Stop"
              data-testid="stop"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
            >
              <StopIcon className="h-2.5 w-2.5" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={readOnly || !value.trim()}
              aria-label="Send"
              data-testid="send"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-200 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ModelControls({ disabled }: { disabled: boolean }) {
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settings, setSettings] = useState<NoxSettings>({})

  useEffect(() => {
    void loadSettings().then(setSettings)
  }, [])

  useEffect(() => {
    if (codexStatus !== 'connected') return
    void codex.listModels().then(setModels).catch(() => setModels([]))
  }, [codexStatus])

  function apply(next: NoxSettings) {
    setSettings(next)
    agentLoop.setOverrides({ model: next.model, effort: next.effort })
    void saveSettings(next)
  }

  const selected = models.find((model) => model.id === settings.model) ?? models.find((model) => model.isDefault) ?? models[0]
  const efforts = selected?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh']
  const selectClass = 'max-w-28 cursor-pointer appearance-none bg-transparent py-1 pl-1 pr-3 text-[11px] text-zinc-400 outline-none hover:text-zinc-200'

  return (
    <div className="flex min-w-0 items-center text-zinc-500" data-testid="chat-model-controls">
      <label className="relative flex min-w-0 items-center" title="Model">
        <span className="sr-only">Model</span>
        <select
          value={selected?.id ?? ''}
          onChange={(event) => apply({ ...settings, model: event.target.value })}
          disabled={disabled || models.length === 0}
          aria-label="Model"
          data-testid="model-select"
          className={selectClass}
        >
          {models.length === 0 && <option value="">Codex</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-0 h-2.5 w-2.5" />
      </label>
      <span aria-hidden="true" className="mx-1 h-3 w-px bg-zinc-700" />
      <label className="relative flex items-center" title="Reasoning effort">
        <span className="sr-only">Reasoning effort</span>
        <select
          disabled={disabled}
          value={settings.effort ?? 'low'}
          onChange={(event) => apply({ ...settings, effort: event.target.value })}
          aria-label="Reasoning effort"
          data-testid="effort-select"
          className={selectClass}
        >
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-0 h-2.5 w-2.5" />
      </label>
    </div>
  )
}
