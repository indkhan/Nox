import { useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'
import { ConnectionCard } from './ConnectionCard'
import { BridgeCard } from './BridgeCard'
import { storageUsageBytes, deleteAllData } from '../lib/history/panel'
import {
  clearLogs,
  copyLogs,
  getLogs,
  subscribeLogs,
  type LogEntry,
} from '../lib/log'

/** Full-panel settings: connections, diagnostics, and local data controls. */
export function SettingsModal() {
  const setSettingsOpen = useNoxStore((s) => s.setSettingsOpen)
  const close = () => setSettingsOpen(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-page"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="settings-modal"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-[13px] font-semibold text-ink">Settings</h2>
        <button
          onClick={close}
          aria-label="Close settings"
          data-testid="settings-close"
          className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <section aria-label="Connections">
          <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Connections</h3>
          <div className="space-y-2">
            <ConnectionCard />
            <BridgeCard />
          </div>
        </section>

        <LogsSection />

        <DataSection />
      </div>
    </div>
  )
}

function LogsSection() {
  const [entries, setEntries] = useState<readonly LogEntry[]>(getLogs())
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => subscribeLogs(() => setEntries(getLogs())), [])
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <section aria-label="Logs" data-testid="logs-section">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Logs</h3>
        <div className="flex items-center gap-2 text-[11px]">
          <button
            onClick={() =>
              void copyLogs().then((ok) => {
                if (!ok) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }
            data-testid="logs-copy"
            className="rounded-chip bg-field px-2 py-0.5 text-[11px] font-medium text-ink-2 shadow-hairline transition-colors duration-100 hover:text-ink"
          >
            {copied ? 'Copied ✓' : 'Copy log'}
          </button>
          <button
            onClick={() => clearLogs()}
            data-testid="logs-clear"
            className="text-[11px] text-ink-3 underline hover:text-ink"
          >
            Clear
          </button>
        </div>
      </div>
      <pre
        ref={preRef}
        className="max-h-44 overflow-y-auto rounded-control border border-line bg-inset p-2 font-mono text-[10.5px] leading-relaxed text-ink-2"
        data-testid="logs-output"
      >
        {entries.length === 0
          ? '(no log entries)'
          : entries
              .map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.msg}`)
              .join('\n')}
      </pre>
      <p className="mt-1 text-[10.5px] text-ink-3">Facing a problem? Copy this log and attach it to your bug report.</p>
    </section>
  )
}

function DataSection() {
  const [usage, setUsage] = useState<string | null>(null)

  useEffect(() => {
    void storageUsageBytes().then((u) => {
      if (u) setUsage(`${(u.usage / 1024 / 1024).toFixed(1)} MB used`)
    })
  }, [])

  return (
    <section aria-label="Data" className="flex items-center justify-between rounded-card bg-surface p-2.5 shadow-hairline">
      <span className="text-[11px] text-ink-3">{usage ?? 'Local browser data'}</span>
      <button
        onClick={() => {
          if (window.confirm('Delete ALL Nox data — threads, journal, tokens?')) void deleteAllData()
        }}
        className="rounded-chip px-2 py-1 text-[11px] text-red underline hover:brightness-110"
      >
        Delete all data
      </button>
    </section>
  )
}
