import { useEffect, useRef } from 'react'
import { useNoxStore } from './store'
import type { PlannedOperation } from '../lib/architect/plan'

export function PlanCards({ readOnly = false }: { readOnly?: boolean }) {
  const plans = useNoxStore((state) => state.pendingPlans)
  const removePlan = useNoxStore((state) => state.removePlan)
  const first = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (plans.length && !readOnly) first.current?.focus()
  }, [plans.length, readOnly])

  if (readOnly || plans.length === 0) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-page" data-testid="plan-cards">
      {plans.map((pending, index) => {
        const decide = (decision: 'approved' | 'rejected') => {
          pending.resolve(decision)
          removePlan(pending.id)
        }
        const stepOf = new Map(
          pending.plan.operations.map((operation, operationIndex) => [operation.opId, operationIndex + 1]),
        )

        return (
          <div
            key={pending.id}
            ref={index === 0 ? first : undefined}
            tabIndex={-1}
            role="alertdialog"
            aria-label="Review workspace plan"
            className="flex min-h-0 flex-1 flex-col"
            data-testid="plan-review"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
              <button
                type="button"
                onClick={() => decide('rejected')}
                className="-ml-1 rounded-control px-1.5 py-1 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink"
                aria-label="Dismiss plan and return to chat"
              >
                ← Back
              </button>
              <p className="text-xs font-semibold text-accent-ink">Plan ready</p>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
              <h2 className="text-lg font-semibold leading-snug tracking-tight text-ink">{pending.plan.recommendation}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{pending.plan.goal}</p>

              <section className="mt-7" aria-labelledby={`plan-operations-${pending.id}`}>
                <h3 id={`plan-operations-${pending.id}`} className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-3">
                  What Nox will do
                </h3>
                <ol className="relative mt-3 space-y-4 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line-strong">
                  {pending.plan.operations.map((operation, operationIndex) => (
                    <li key={`${operation.tool}-${operationIndex}`} className="relative flex gap-3">
                      <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-tint text-[11px] font-semibold text-accent-ink">
                        {operationIndex + 1}
                      </span>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className="text-sm leading-relaxed text-ink">{operation.summary}</p>
                        <OperationTarget operation={operation} stepOf={stepOf} />
                        {operation.args != null && (
                          <details className="mt-1">
                            <summary className="cursor-pointer select-none text-[11px] text-ink-3">Operation details</summary>
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400">{JSON.stringify(operation.args, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              {pending.plan.consequences.length > 0 && (
                <section className="mt-7 rounded-card border border-orange/25 bg-orange-tint px-3 py-2.5" aria-labelledby={`plan-impact-${pending.id}`}>
                  <h3 id={`plan-impact-${pending.id}`} className="text-[10px] font-semibold uppercase tracking-[0.13em] text-orange">Impact</h3>
                  <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-2">
                    {pending.plan.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
                  </ul>
                </section>
              )}

              <details className="group mt-5 border-t border-line pt-3">
                <summary className="cursor-pointer select-none list-none text-xs font-medium text-ink-2 hover:text-ink">
                  <span className="mr-1.5 inline-block text-ink-3 transition-transform group-open:rotate-90">›</span>
                  Why Nox chose this
                  <span className="ml-1.5 font-normal text-ink-3">Inspected {pending.plan.evidence.length} workspace item{pending.plan.evidence.length === 1 ? '' : 's'}</span>
                </summary>
                <ul className="mt-3 space-y-2 pl-4 text-xs leading-relaxed text-ink-2">
                  {pending.plan.evidence.map((evidence) => (
                    <li key={`${evidence.kind}-${evidence.id}`}>
                      <span className="font-medium text-ink">{evidence.title}</span>
                      <span className="text-ink-3"> — {evidence.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>

            <footer className="shrink-0 border-t border-line bg-surface p-3 shadow-[0_-8px_24px_oklch(0_0_0/0.04)]">
              <button
                type="button"
                data-testid={`approve-${pending.id}`}
                onClick={() => decide('approved')}
                className="w-full rounded-control bg-accent px-3 py-2.5 text-sm font-semibold text-white shadow-btn hover:brightness-105"
              >
                Approve and continue
              </button>
              <button
                type="button"
                data-testid={`reject-${pending.id}`}
                onClick={() => decide('rejected')}
                className="mt-1.5 w-full rounded-control px-3 py-2 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink"
              >
                Not now
              </button>
            </footer>
          </div>
        )
      })}
    </div>
  )
}

/** Target line for one planned operation, including creation references. */
function OperationTarget({ operation, stepOf }: { operation: PlannedOperation; stepOf: Map<string | undefined, number> }) {
  const target = operation.targetId
  if (target == null) return null
  const text = typeof target === 'string'
    ? `→ ${target}`
    : (() => {
        const step = stepOf.get(target.ref)
        return step == null ? `← uses the new object from “${target.ref}”` : `← uses the new object from step ${step}`
      })()
  return <p className="mt-0.5 truncate text-[11px] text-ink-3">{text}</p>
}
