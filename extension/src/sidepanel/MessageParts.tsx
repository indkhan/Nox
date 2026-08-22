import { useEffect, useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { ChevronDownIcon } from './Icons'
import { Shimmer } from './ui/Shimmer'

/** One collapsible progress block per assistant turn (MVP §7). */
export interface ProgressStep {
  kind: 'reasoning' | 'tool' | 'web-search'
  label: string
  detail?: string
}

/**
 * Beautiful-UI-style thinking trace: a shimmering status row with an elapsed
 * timer while working, collapsing to "N steps" once the turn finishes, and an
 * expandable timeline of steps underneath.
 */
export function ProgressBlock({ steps, active }: { steps: ProgressStep[]; active?: boolean }) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Elapsed timer; keeps its final value once the turn settles.
  useEffect(() => {
    if (!active) return
    const started = Date.now()
    setElapsed(0)
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 100)
    return () => clearInterval(t)
  }, [active])

  const autoExpanded = Boolean(active) && steps.length > 0
  const expanded = manualExpanded ?? autoExpanded
  if (steps.length === 0 && !active) return null

  const actionCount = steps.filter((s) => s.kind !== 'reasoning').length
  const summary = active
    ? activeLabel(steps)
    : actionCount > 0
      ? `${actionCount} step${actionCount === 1 ? '' : 's'}`
      : 'Thought'

  return (
    <div data-testid="progress-block">
      <button
        type="button"
        onClick={() => setManualExpanded((current) => !(current ?? autoExpanded))}
        aria-expanded={expanded}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill={active ? 'var(--ink-2)' : 'var(--ink-3)'}>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {active ? (
          <Shimmer className="text-[13px] font-medium whitespace-nowrap">{summary}</Shimmer>
        ) : (
          <span
            role="status"
            className="text-[13px] font-medium whitespace-nowrap text-ink-2"
            style={{ animation: 'fade-in 350ms ease-out both' }}
          >
            {summary}
          </span>
        )}
        <span aria-hidden className="text-[11px] tabular-nums text-ink-3">
          {elapsed.toFixed(1)}s
        </span>
        {steps.length > 0 && (
          <span
            className="transition-transform duration-300"
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', color: 'var(--ink-3)', display: 'inline-flex' }}
          >
            <ChevronDownIcon />
          </span>
        )}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-[400ms]"
        style={{
          gridTemplateRows: expanded ? '1fr' : '0fr',
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          <ul className="relative mt-1 ml-[5px] flex flex-col gap-1 py-1 pl-4">
            <span aria-hidden className="absolute top-[-4px] bottom-1 left-[3px] w-px bg-line" />
            {steps.map((s, i) => {
              const done = i < steps.length - 1 || !active
              return (
                <li
                  key={i}
                  className="flex min-h-6 items-center gap-2 rounded-[6px] px-1.5 py-0.5"
                  style={{ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 6) * 90}ms both` }}
                >
                  {done ? (
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--ink-3)"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <span
                      className="size-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2 motion-reduce:animate-none"
                      style={{ animation: 'spin 700ms linear infinite' }}
                    />
                  )}
                  <span
                    className={`min-w-0 truncate text-[12.5px] ${
                      s.kind === 'reasoning' || s.kind === 'web-search'
                        ? 'font-normal text-ink-2'
                        : 'font-medium text-ink'
                    }`}
                  >
                    {s.label}
                  </span>
                  {s.detail && (
                    <span className="ml-auto shrink-0 truncate font-mono text-[10.5px] text-ink-3">{s.detail}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
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
      className="nox-markdown space-y-2 text-sm leading-relaxed [&_a]:text-accent-ink [&_a]:underline [&_a]:decoration-line-strong [&_a]:underline-offset-2 [&_code]:rounded-md [&_code]:bg-inset [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:text-base [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-control [&_pre]:border [&_pre]:border-line [&_pre]:bg-inset [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12px] [&_strong]:font-semibold [&_ul]:list-disc [&_ul>li::marker]:text-ink-3"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
