import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { ChevronDownIcon } from './Icons'

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
