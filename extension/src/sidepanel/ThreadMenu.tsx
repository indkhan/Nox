import { useEffect, useState } from 'react'
import type { ThreadRow } from '../lib/history/schema'
import { historyRepo } from '../lib/history/panel'
import { useNoxStore } from './store'
import { ChevronDownIcon } from './Icons'

export function ThreadMenu() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const requestOpenThread = useNoxStore((state) => state.requestOpenThread)

  useEffect(() => {
    if (!open) return
    const load = query.trim() ? historyRepo.searchThreads(query).then((rows) => rows.map((row) => row.thread)) : historyRepo.listThreads()
    void load.then(setThreads).catch(() => setThreads([]))
  }, [open, query])

  async function remove(thread: ThreadRow) {
    if (!window.confirm(`Delete “${thread.title}”?`)) return
    await historyRepo.deleteThread(thread.id)
    setThreads((all) => all.filter((candidate) => candidate.id !== thread.id))
  }

  async function exportThread(thread: ThreadRow) {
    const markdown = await historyRepo.exportThread(thread.id, 'markdown')
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${thread.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'nox-chat'}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((value) => !value)} aria-label="Open chat history" aria-expanded={open} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-40 w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl" role="dialog" aria-label="Chat history">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {threads.map((thread) => (
              <div key={thread.id} className="flex items-center gap-1 rounded-md hover:bg-zinc-800">
                <button onClick={() => { requestOpenThread(thread.id); setOpen(false) }} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs">{thread.title}</button>
                <button onClick={() => void exportThread(thread)} aria-label={`Export ${thread.title}`} className="px-1 text-[10px] text-zinc-500 hover:text-zinc-200">Export</button>
                <button onClick={() => void remove(thread)} aria-label={`Delete ${thread.title}`} className="px-1 text-[10px] text-zinc-500 hover:text-red-400">Delete</button>
              </div>
            ))}
            {threads.length === 0 && <p className="px-2 py-3 text-center text-xs text-zinc-500">No chats found</p>}
          </div>
        </div>
      )}
    </div>
  )
}
