import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { ChevronDownIcon } from './Icons'
import { failedToolActivityLabel, toolActivityLabel, toolResultCategory, type ActivityItem } from '../lib/agent/activity'
import { toResultTable } from '../lib/db/query'
import { ResultsTable } from './ResultsTable'

export function ActivityTimeline({ items, active, onUndo }: { items: ActivityItem[]; active?: boolean; onUndo?: (journalId: string) => void }) {
  const [open, setOpen] = useState(active === true)
  if (items.length === 0 && !active) return null
  const tools = items.filter((item) => item.kind === 'tool')
  const running = [...items].reverse().find((item) => item.kind === 'tool' && item.status === 'running')
  const summary = running?.kind === 'tool'
    ? toolActivityLabel(running.tool, running.args)
    : active ? 'Thinking…' : `${tools.length} action${tools.length === 1 ? '' : 's'}`

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/45 px-2.5 py-1.5" data-testid="activity-timeline">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 py-1 text-left text-xs text-zinc-400 hover:text-zinc-200">
        <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'animate-pulse bg-indigo-400 motion-reduce:animate-none' : 'bg-zinc-600'}`} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDownIcon className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && items.length > 0 && (
        <ol className="ml-1 border-l border-zinc-800 py-1 pl-3">
          {items.map((item) => <ActivityRow key={item.id} item={item} onUndo={onUndo} />)}
        </ol>
      )}
    </div>
  )
}

function ActivityRow({ item, onUndo }: { item: ActivityItem; onUndo?: (journalId: string) => void }) {
  if (item.kind === 'reasoning') return <li className="py-1 text-xs text-zinc-500">{item.text}</li>
  if (item.kind === 'search') return <li className="py-1 text-xs text-sky-300">{item.status === 'completed' ? 'Searched the web' : 'Searching the web…'}</li>
  const completed = item.status === 'completed'
  const base = toolActivityLabel(item.tool, item.args, completed)
  const label = item.status === 'failed' ? failedToolActivityLabel(item.tool) : base
  return (
    <li className={`flex items-start gap-2 py-1 text-xs ${completed ? 'nox-resolve' : ''}`}>
      <span className={item.status === 'failed' ? 'text-rose-400' : completed ? 'text-emerald-400' : 'text-indigo-400'}>
        {item.status === 'failed' ? '×' : completed ? '✓' : '●'}
      </span>
      <div className="min-w-0 flex-1 text-zinc-300">
        <span>{label}</span>
        {item.error && <span className="ml-1 text-rose-400">— {item.error}</span>}
        <ActivityResult item={item} />
        <details className="mt-1 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">Technical details</summary>
          <div className="mt-1 font-mono">{item.tool}</div>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{JSON.stringify(item.args)}</pre>
        </details>
        {item.undoable && item.journalId && onUndo && (
          <button onClick={() => onUndo(item.journalId!)} className="mt-1 text-[11px] text-indigo-300 hover:text-indigo-200">
            Undo this change
          </button>
        )}
      </div>
      {item.durationMs != null && <span className="tabular-nums text-zinc-600">{formatDuration(item.durationMs)}</span>}
    </li>
  )
}

function ActivityResult({ item }: { item: Extract<ActivityItem, { kind: 'tool' }> }) {
  if (item.status !== 'completed') return null
  const category = toolResultCategory(item.tool)
  if (category === 'table' && item.resultText) {
    return <div className="mt-1"><ResultsTable table={toResultTable({ content: [{ type: 'text', text: item.resultText }] })} /></div>
  }
  if (category === 'context' && item.resultText) {
    return (
      <div data-testid="context-result" className="mt-1 max-h-20 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-500">
        {item.resultText}
      </div>
    )
  }
  if (category === 'change') {
    const changes = Object.entries(item.args).filter(([key]) => !/^(id|page_id|data_source_id)$/.test(key)).slice(0, 4)
    return (
      <div data-testid="change-result" className="mt-1 rounded-md border border-emerald-900/50 bg-emerald-950/20 px-2 py-1.5 text-[11px] text-zinc-400">
        {changes.length ? changes.map(([key, value]) => `${key.replace(/_/g, ' ')}: ${compactValue(value)}`).join(' · ') : 'Change applied'}
      </div>
    )
  }
  if (!item.resultText) return null
  return <div className="mt-1 max-h-16 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-500">{item.resultText}</div>
}

function compactValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value).slice(0, 80)
}

export function FollowUpActions({ suggestions, onSelect }: { suggestions: string[]; onSelect: (suggestion: string) => void }) {
  if (suggestions.length === 0) return null
  return (
    <div className="mt-2 space-y-1" data-testid="follow-up-actions">
      <p className="text-[11px] font-medium text-zinc-600">Follow-ups</p>
      {suggestions.map((suggestion) => (
        <button key={suggestion} onClick={() => onSelect(suggestion)} className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
          {suggestion}
        </button>
      ))}
    </div>
  )
}

function formatDuration(ms: number): string {
  return ms < 100 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Assistant answer body: sanitized markdown with clickable source chips. */
export function AssistantMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown])
  return (
    <div
      className="nox-markdown space-y-2 text-sm leading-relaxed [&_a]:text-sky-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-950 [&_pre]:p-2 [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
