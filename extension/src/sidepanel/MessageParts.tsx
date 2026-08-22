import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { ChevronDownIcon } from './Icons'
import { failedToolActivityLabel, toolActivityLabel, type ActivityItem } from '../lib/agent/activity'

export function ActivityTimeline({ items, active }: { items: ActivityItem[]; active?: boolean }) {
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
          {items.map((item) => <ActivityRow key={item.id} item={item} />)}
        </ol>
      )}
    </div>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.kind === 'reasoning') return <li className="py-1 text-xs text-zinc-500">{item.text}</li>
  if (item.kind === 'search') return <li className="py-1 text-xs text-sky-300">Searching the web…</li>
  const completed = item.status === 'completed'
  const base = toolActivityLabel(item.tool, item.args, completed)
  const label = item.status === 'failed' ? failedToolActivityLabel(item.tool) : base
  return (
    <li className="flex items-start gap-2 py-1 text-xs">
      <span className={item.status === 'failed' ? 'text-rose-400' : completed ? 'text-emerald-400' : 'text-indigo-400'}>
        {item.status === 'failed' ? '×' : completed ? '✓' : '●'}
      </span>
      <span className="min-w-0 flex-1 text-zinc-300">
        <span>{label}</span>
        {item.error && <span className="ml-1 text-rose-400">— {item.error}</span>}
        {item.resultText && (
          <span className="mt-1 block max-h-16 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-500">
            {item.resultText}
          </span>
        )}
      </span>
      {item.durationMs != null && <span className="tabular-nums text-zinc-600">{formatDuration(item.durationMs)}</span>}
    </li>
  )
}

function formatDuration(ms: number): string {
  return ms < 100 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** One collapsible progress block per assistant turn (MVP §7). */
export interface ProgressStep {
  kind: 'reasoning' | 'tool' | 'web-search'
  label: string
  detail?: string
}

/**
 * Notion-style progress: a plain-text status row while working ("Brewing…"),
 * collapsing to "N steps ›" / "Thought ›" once the turn finishes.
 */
export function ProgressBlock({ steps, active }: { steps: ProgressStep[]; active?: boolean }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0 && !active) return null

  const hasActions = steps.some((s) => s.kind !== 'reasoning')
  const summary = active ? activeLabel(steps) : hasActions ? `${steps.filter((s) => s.kind !== 'reasoning').length} steps` : 'Thought'

  return (
    <div data-testid="progress-block">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-2 py-1 text-left text-sm text-zinc-400 hover:text-zinc-200"
      >
        {active && (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-500 border-t-transparent motion-reduce:animate-none"
          />
        )}
        {!active && (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true">
            <circle cx="8" cy="8" r="6" strokeDasharray="28 9" strokeLinecap="round" />
          </svg>
        )}
        <span>{summary}</span>
        {steps.length > 0 && (
          <span className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
            <ChevronDownIcon />
          </span>
        )}
      </button>
      {open && steps.length > 0 && (
        <ul className="space-y-1 py-1 pl-5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-baseline gap-2 text-xs">
              <span className={s.kind === 'tool' ? 'text-emerald-400' : s.kind === 'web-search' ? 'text-sky-400' : 'text-zinc-500'}>
                {s.kind === 'tool' ? '⚙' : s.kind === 'web-search' ? '🌐' : '·'}
              </span>
              <span className="text-zinc-300">{s.label}</span>
              {s.detail && <span className="truncate font-mono text-[10px] text-zinc-600">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function activeLabel(steps: ProgressStep[]): string {
  const last = steps[steps.length - 1]
  if (!last) return 'Brewing…'
  if (last.kind === 'web-search') return 'Searching the web…'
  if (last.kind === 'reasoning') return 'Thinking…'
  return 'Working…'
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
