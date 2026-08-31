import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { ChevronDownIcon, NoxMark } from './Icons'
import { deriveActivitySummary, failedToolActivityLabel, toolActivityLabel, toolResultCategory, type ActivityItem } from '../lib/agent/activity'
import { toResultTable } from '../lib/db/query'
import { ResultsTable } from './ResultsTable'

export function ActivityTimeline({ items, active = false, answerStarted = false, initiallyExpanded = false, onUndo }: { items: ActivityItem[]; active?: boolean; answerStarted?: boolean; initiallyExpanded?: boolean; onUndo?: (journalId: string) => void }) {
  const [open, setOpen] = useState(initiallyExpanded)
  if (items.length === 0 && !active) return null
  const summary = deriveActivitySummary(items, { active, answerStarted })
  const meta = !active && summary.actionCount > 0
    ? `${summary.actionCount} action${summary.actionCount === 1 ? '' : 's'}${summary.durationMs ? ` · ${formatDuration(summary.durationMs)}` : ''}`
    : null

  return (
    <div className="px-1 py-1" data-testid="activity-timeline">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-lg py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--nox-accent)]">
        <NoxMark className={`h-4 w-4 shrink-0 ${summary.status === 'failed' ? 'nox-danger' : active ? 'nox-active' : 'nox-success'}`} />
        <span className="min-w-0 flex-1 truncate">{summary.label}</span>
        {meta && <span className="shrink-0 tabular-nums text-zinc-600">{meta}</span>}
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
  if (item.kind === 'search') return <li className="nox-info py-1 text-xs">{item.status === 'completed' ? 'Searched the web' : 'Searching the web…'}</li>
  const completed = item.status === 'completed'
  const base = toolActivityLabel(item.tool, item.args, completed)
  const label = item.undone ? 'Change undone' : item.status === 'failed' ? failedToolActivityLabel(item.tool) : base
  return (
    <li className={`flex items-start gap-2 py-1 text-xs ${completed ? 'nox-resolve' : ''}`}>
      <span className={item.status === 'failed' ? 'nox-danger' : completed ? 'nox-success' : 'nox-active'}>
        {item.status === 'failed' ? '×' : completed ? '✓' : '●'}
      </span>
      <div className="min-w-0 flex-1 text-zinc-300">
        <span>{label}</span>
        {item.error && <span className="nox-danger ml-1">— {item.error}</span>}
        <ActivityResult item={item} />
        <details className="mt-1 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">Technical details</summary>
          <div className="mt-1 font-mono">{item.tool}</div>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{JSON.stringify(item.args)}</pre>
        </details>
        {(item.undoable || item.undone || item.undoError) && item.journalId && onUndo && (
          <button disabled={!item.undoable} onClick={() => onUndo(item.journalId!)} className="nox-active mt-1 text-[11px] underline-offset-2 hover:underline disabled:no-underline">
            {item.undone ? 'Undone' : 'Undo this change'}
          </button>
        )}
        {item.undoError && <p className="nox-danger mt-1 text-[11px]" role="alert">Undo failed: {item.undoError}</p>}
      </div>
      {item.durationMs != null && <span className="tabular-nums text-zinc-600">{formatDuration(item.durationMs)}</span>}
    </li>
  )
}

function ActivityResult({ item }: { item: Extract<ActivityItem, { kind: 'tool' }> }) {
  if (item.status !== 'completed') return null
  if (item.undone) return <div className="nox-success mt-1 text-[11px]" role="status">Change undone</div>
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
      <div data-testid="change-result" className="nox-change-result mt-1 rounded-md border px-2 py-1.5 text-[11px] text-zinc-400">
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
      className="nox-markdown space-y-2 text-sm leading-relaxed [&_a]:text-[var(--nox-info)] [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-950 [&_pre]:p-2 [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
