import { useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'

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
    <div className="border-t border-zinc-800 p-2" data-testid="composer-root">
      {currentPage && (
        <div className="mb-1.5 inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300" data-testid="context-pill">
          <span className="text-emerald-400">⬡</span>
          <span className="truncate">{currentPage.title ?? currentPage.pageId}</span>
          <button
            onClick={() => setCurrentPage(null)}
            aria-label="Remove current page context"
            className="ml-0.5 text-zinc-500 hover:text-zinc-300"
          >
            ×
          </button>
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
        className="w-full resize-none rounded-lg border border-zinc-700 bg-transparent p-2 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-500"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          disabled
          title="Attach images (coming soon)"
          aria-label="Attach"
          className="rounded-md px-2 py-1 text-xs text-zinc-600"
        >
          +
        </button>
        <select
          disabled={readOnly}
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          aria-label="Change mode"
          data-testid="mode-selector"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs"
        >
          <option value="ask">Ask before changes</option>
          <option value="auto">Auto</option>
        </select>
        <span className="flex-1" />
        {busy ? (
          <button onClick={onCancel} data-testid="stop" className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold">
            ■ Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={readOnly || !value.trim()}
            data-testid="send"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
