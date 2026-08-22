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
import { applyTheme, loadSettings, saveSettings, type ThemePreference } from '../lib/settings'

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
      className="absolute inset-0 z-50 flex flex-col bg-zinc-950"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="settings-modal"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-semibold">Settings</h2>
        <button onClick={close} aria-label="Close settings" data-testid="settings-close" className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <section aria-label="Connections">
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Connections</h3>
          <div className="space-y-2">
            <ConnectionCard />
            <BridgeCard />
          </div>
        </section>

        <ThemeSection />

        <LogsSection />

        <DataSection />
      </div>
    </div>
  )
}

function ThemeSection() {
  const [theme, setTheme] = useState<ThemePreference>('system')
  useEffect(() => { void loadSettings().then((settings) => setTheme(settings.theme ?? 'system')) }, [])

  function change(next: ThemePreference) {
    setTheme(next)
    applyTheme(next)
    void loadSettings().then((settings) => saveSettings({ ...settings, theme: next }))
  }

  return (
    <section aria-label="Appearance">
      <h3 className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Appearance</h3>
      <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5 text-xs">
        Theme
        <select value={theme} onChange={(event) => change(event.target.value as ThemePreference)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <p className="mt-1 text-[10px] text-zinc-600">Choose Light or Dark to match a Notion theme that differs from your system.</p>
    </section>
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
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
          >
            {copied ? 'Copied ✓' : 'Copy log'}
          </button>
          <button
            onClick={() => clearLogs()}
            data-testid="logs-clear"
            className="text-zinc-500 underline hover:text-zinc-300"
          >
            Clear
          </button>
        </div>
      </div>
      <pre
        ref={preRef}
        className="max-h-44 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400"
        data-testid="logs-output"
      >
        {entries.length === 0
          ? '(no log entries)'
          : entries
              .map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.msg}`)
              .join('\n')}
      </pre>
      <p className="mt-1 text-[10px] text-zinc-600">Facing a problem? Copy this log and attach it to your bug report.</p>
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
    <section aria-label="Data" className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
      <span className="text-[11px] text-zinc-600">{usage ?? 'Local browser data'}</span>
      <button
        onClick={() => {
          if (window.confirm('Delete ALL Nox data — threads, journal, tokens?')) void deleteAllData()
        }}
        className="rounded-md px-2 py-1 text-[11px] text-red-400 underline hover:text-red-300"
      >
        Delete all data
      </button>
    </section>
  )
}
