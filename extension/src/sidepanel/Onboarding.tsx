import { useEffect, useState } from 'react'
import { useNoxStore } from './store'
import { claimWindowRole, historyRepo, storageUsageBytes, deleteAllData, type WindowRole } from '../lib/history/panel'

/** Onboarding checklist + data controls (MVP §8). */
export function OnboardingPanel() {
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const [usage, setUsage] = useState<string | null>(null)

  useEffect(() => {
    void storageUsageBytes().then((u) => {
      if (u) setUsage(`${(u.usage / 1024 / 1024).toFixed(1)} MB used`)
    })
  }, [])

  const steps = [
    { done: connectionStatus === 'connected', label: 'Connect your Notion workspace' },
    { done: codexStatus === 'connected', label: 'Connect Codex (local bridge)' },
  ]

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs" data-testid="onboarding">
      <p className="mb-1.5 uppercase tracking-wide text-zinc-500">Setup</p>
      <ol className="space-y-1">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'text-emerald-400' : 'text-zinc-400'}>
            {s.done ? '✓' : '○'} {s.label}
          </li>
        ))}
        <li className="text-zinc-400">○ Ask your first question below</li>
      </ol>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-600">
        <span>{usage ?? ''}</span>
        <button
          onClick={() => {
            if (window.confirm('Delete ALL Nox data — threads, journal, tokens?')) void deleteAllData()
          }}
          className="underline hover:text-red-400"
        >
          Delete all data
        </button>
      </div>
    </section>
  )
}

/** Second-window state: read-only viewer (MVP §8). */
export function ViewerBanner({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300" role="status">
      Nox is open in another window. This one is read-only.
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="ml-2 underline">dismiss</button>
      )}
    </div>
  )
}

/** Header overflow: thread search, export, delete (compact for the panel width). */
export function ThreadTools() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; title: string; snippet: string }>>([])
  const [role, setRole] = useState<WindowRole>('pending')

  useEffect(() => {
    void claimWindowRole().then(setRole)
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      void historyRepo.searchThreads(query).then((found) =>
        setResults(found.map((f) => ({ id: f.thread.id, title: f.thread.title, snippet: f.snippet }))),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  async function exportThread(id: string, format: 'json' | 'markdown') {
    const content = await historyRepo.exportThread(id, format)
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' })
    const url = URL.createObjectURL(blob)
    chrome.downloads?.download
      ? chrome.downloads.download({ url, filename: `nox-thread.${format === 'json' ? 'json' : 'md'}` })
      : window.open(url)
  }

  return (
    <div className="space-y-1.5" data-testid="thread-tools">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search chats…"
        aria-label="Search chat history"
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs outline-none focus:border-emerald-500"
      />
      {results.map((r) => (
        <div key={r.id} className="rounded-md bg-zinc-950/70 p-1.5 text-[11px]">
          <p className="font-medium text-zinc-300">{r.title}</p>
          <p className="truncate text-zinc-600">{r.snippet}</p>
          <div className="mt-0.5 flex gap-2 text-zinc-500">
            <button onClick={() => void exportThread(r.id, 'markdown')} className="hover:text-zinc-300">export .md</button>
            <button onClick={() => void exportThread(r.id, 'json')} className="hover:text-zinc-300">.json</button>
            <button
              onClick={() => window.confirm('Delete this chat?') && void historyRepo.deleteThread(r.id)}
              className="hover:text-red-400"
            >
              delete
            </button>
          </div>
        </div>
      ))}
      {role === 'viewer' && <p className="text-[10px] text-amber-500">Read-only window.</p>}
    </div>
  )
}

export { OnboardingPanel as default }
