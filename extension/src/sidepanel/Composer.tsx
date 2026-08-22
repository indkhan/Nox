import { useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'
import { codex } from '../lib/codex/panel'
import type { ModelInfo } from '../lib/codex/client'
import { loadSettings, saveSettings, type NoxSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'
import { ChevronDownIcon, PageIcon, PlusIcon, SignalBarsIcon, StopIcon } from './Icons'

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
    <div className="bg-page p-2.5" data-testid="composer-root">
      <div className="relative flex flex-col gap-1.5 overflow-hidden rounded-window border border-line bg-surface p-2 shadow-card transition-colors duration-150 focus-within:border-line-strong">
        {currentPage && (
          <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">
            <span
              className="flex h-6.5 max-w-full items-center gap-1.5 rounded-chip bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline"
              style={{ animation: 'pop-in 200ms cubic-bezier(0.23,1,0.32,1) both' }}
              data-testid="context-pill"
            >
              <PageIcon className="h-3 w-3 shrink-0 text-ink-3" />
              <span className="truncate">{currentPage.title ?? currentPage.pageId}</span>
              <button
                onClick={() => setCurrentPage(null)}
                aria-label="Remove current page context"
                className="-my-1 flex size-6 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"
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
          className="min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-[13px] leading-[18px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3"
        />
        <div className="grid grid-cols-[28px_minmax(0,1fr)_auto_28px_28px] items-end gap-x-1">
          <button
            disabled
            title="Attach images (coming soon)"
            aria-label="Attach"
            className="col-start-1 row-start-1 flex size-7 shrink-0 items-center justify-center justify-self-start rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94]"
          >
            <PlusIcon />
          </button>

          <ModelControls disabled={readOnly} />

          {busy && (
            <span aria-hidden="true" className="col-start-3 row-start-1 mr-1 self-center text-ink-3">
              <SignalBarsIcon />
            </span>
          )}
          {!busy && (
            <label
              className="col-start-3 row-start-1 relative flex h-7 shrink-0 items-center px-1"
              title="Auto runs writes immediately; Ask approves each one"
            >
              <span className="sr-only">Change mode</span>
              <select
                disabled={readOnly}
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
                aria-label="Change mode"
                data-testid="mode-selector"
                className="cursor-pointer appearance-none rounded-[8px] py-0 pl-1.5 pr-4 text-[12px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                <option value="ask">Ask</option>
                <option value="auto">Auto</option>
              </select>
              <span className="pointer-events-none absolute right-1 inline-flex text-ink-3">
                <ChevronDownIcon className="h-2.5 w-2.5" />
              </span>
            </label>
          )}
          {busy ? (
            <button
              onClick={onCancel}
              aria-label="Stop"
              data-testid="stop"
              className="col-start-4 row-start-1 col-span-2 flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-ink text-surface transition-transform duration-200 active:scale-[0.94]"
            >
              <StopIcon className="h-2.5 w-2.5" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={readOnly || !value.trim()}
              aria-label="Send"
              data-testid="send"
              className="col-start-5 row-start-1 col-span-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
              style={{
                background: value.trim() && !readOnly ? 'var(--ink)' : 'var(--line-strong)',
                color: value.trim() && !readOnly ? 'var(--surface)' : 'var(--ink-2)',
              }}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ArrowUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
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

  return (
    <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-self-start" data-testid="chat-model-controls">
      <label className="relative flex h-7 min-w-0 shrink-0 items-center px-1" title="Model">
        <span className="sr-only">Model</span>
        <select
          value={selected?.id ?? ''}
          onChange={(event) => apply({ ...settings, model: event.target.value })}
          disabled={disabled || models.length === 0}
          aria-label="Model"
          data-testid="model-select"
          className="max-w-28 cursor-pointer appearance-none truncate rounded-[8px] py-0 pl-1.5 pr-4 text-[12px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          {models.length === 0 && <option value="">Codex</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName ?? model.id}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-1 inline-flex text-ink-3">
          <ChevronDownIcon className="h-2.5 w-2.5" />
        </span>
      </label>
      <label className="relative flex h-7 shrink-0 items-center px-1" title="Reasoning effort">
        <span className="sr-only">Reasoning effort</span>
        <select
          value={settings.effort ?? 'low'}
          onChange={(event) => apply({ ...settings, effort: event.target.value })}
          disabled={disabled}
          aria-label="Reasoning effort"
          data-testid="effort-select"
          className="cursor-pointer appearance-none rounded-[8px] py-0 pl-1.5 pr-4 text-[12px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-1 inline-flex text-ink-3">
          <ChevronDownIcon className="h-2.5 w-2.5" />
        </span>
      </label>
    </div>
  )
}
