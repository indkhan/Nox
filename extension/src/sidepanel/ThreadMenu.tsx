import { useEffect, useRef, useState } from 'react'
import type { ThreadRow } from '../lib/history/schema'
import { historyRepo } from '../lib/history/panel'
import { useNoxStore } from './store'
import { ChevronDownIcon } from './Icons'

export function ThreadMenu({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchGenerationRef = useRef(0)
  const requestOpenThread = useNoxStore((state) => state.requestOpenThread)
  const activeThreadId = useNoxStore((state) => state.activeThreadId)
  const requestNewChat = useNoxStore((state) => state.requestNewChat)

  useEffect(() => {
    if (!open) return
    const generation = ++searchGenerationRef.current
    const load = query.trim() ? historyRepo.searchThreads(query).then((rows) => rows.map((row) => row.thread)) : historyRepo.listThreads()
    void load.then((rows) => { if (generation === searchGenerationRef.current) setThreads(rows) }).catch((cause) => {
      if (generation === searchGenerationRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [open, query])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('pointerdown', close) }
  }, [open])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  async function remove(thread: ThreadRow) {
    if (!window.confirm(`Delete “${thread.title}”?`)) return
    setPendingId(thread.id)
    setError(null)
    try {
      await historyRepo.deleteThread(thread.id)
      setThreads((all) => all.filter((candidate) => candidate.id !== thread.id))
      if (thread.id === activeThreadId) requestNewChat()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPendingId(null) }
  }

  async function exportThread(thread: ThreadRow) {
    setPendingId(thread.id)
    setError(null)
    try {
      const markdown = await historyRepo.exportThread(thread.id, 'markdown')
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${thread.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'nox-chat'}.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPendingId(null) }
  }

  function trapFocus(event: React.KeyboardEvent) {
    if (event.key !== 'Tab') return
    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
    if (controls.length === 0) return
    const first = controls[0]
    const last = controls.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return (
    <div ref={rootRef} className="relative">
      <button ref={triggerRef} disabled={disabled} onClick={() => setOpen((value) => !value)} aria-label="Open chat history" aria-expanded={open} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40">
        <ChevronDownIcon />
      </button>
      {open && (
        <div ref={panelRef} onKeyDown={trapFocus} className="absolute left-0 top-7 z-40 w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl" role="dialog" aria-label="Chat history">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {threads.map((thread) => (
              <div key={thread.id} className="flex items-center gap-1 rounded-md hover:bg-zinc-800">
                <button onClick={() => { requestOpenThread(thread.id); setOpen(false); triggerRef.current?.focus() }} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs">{thread.title}</button>
                <button disabled={pendingId != null} onClick={() => void exportThread(thread)} aria-label={`Export ${thread.title}`} className="px-1 text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40">Export</button>
                <button disabled={pendingId != null} onClick={() => void remove(thread)} aria-label={`Delete ${thread.title}`} className="px-1 text-[10px] text-zinc-500 hover:text-red-400 disabled:opacity-40">Delete</button>
              </div>
            ))}
            {threads.length === 0 && <p className="px-2 py-3 text-center text-xs text-zinc-500">No chats found</p>}
            {error && <p className="nox-danger px-2 py-2 text-xs" role="alert">{error}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
