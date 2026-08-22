import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'

/** One collapsible progress block per assistant turn (MVP §7). */
export interface ProgressStep {
  kind: 'reasoning' | 'tool' | 'web-search'
  label: string
  detail?: string
}

export function ProgressBlock({ steps }: { steps: ProgressStep[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const summary = summarize(steps)
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60" data-testid="progress-block">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none`} />
        {summary}
        <span className="ml-auto">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <ul className="space-y-1 border-t border-zinc-800 px-3 py-2">
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

function summarize(steps: ProgressStep[]): string {
  const tools = steps.filter((s) => s.kind === 'tool').length
  const searches = steps.filter((s) => s.kind === 'web-search').length
  if (tools > 0 && searches > 0) return `${tools} step${tools === 1 ? '' : 's'} · ${searches} web search${searches === 1 ? '' : 'es'}`
  if (tools > 0) return `${tools} step${tools === 1 ? '' : 's'}`
  if (searches > 0) return 'Searching the web…'
  return 'Thinking…'
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
