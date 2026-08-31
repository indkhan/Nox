import { useEffect, useRef } from 'react'
import { useNoxStore } from './store'

export function PlanCards({ readOnly = false }: { readOnly?: boolean }) {
  const plans = useNoxStore((state) => state.pendingPlans)
  const removePlan = useNoxStore((state) => state.removePlan)
  const first = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (plans.length && !readOnly) first.current?.focus()
  }, [plans.length, readOnly])

  if (readOnly || plans.length === 0) return null
  return (
    <div className="space-y-2 border-t border-zinc-800 bg-zinc-950/80 p-3" data-testid="plan-cards">
      {plans.map((pending, index) => (
        <div key={pending.id} ref={index === 0 ? first : undefined} tabIndex={-1} role="alertdialog" aria-label="Workspace plan approval" className="rounded-xl border border-sky-800/70 bg-zinc-900 p-3 shadow-lg shadow-black/20">
          <p className="nox-active text-xs font-medium">Proposed workspace plan</p>
          <p className="mt-1 text-sm font-semibold">{pending.plan.recommendation}</p>
          {pending.plan.evidence.length > 0 && <section className="mt-2 text-[11px] text-zinc-400"><p className="font-medium text-zinc-300">Inspected</p><ul className="list-disc pl-4">{pending.plan.evidence.map((evidence) => <li key={`${evidence.kind}-${evidence.id}`}>{evidence.title}: {evidence.reason}</li>)}</ul></section>}
          <section className="mt-2 text-[11px] text-zinc-400"><p className="font-medium text-zinc-300">Changes</p><ul className="list-disc pl-4">{pending.plan.operations.map((operation, operationIndex) => <li key={`${operation.tool}-${operationIndex}`}>{operation.summary}</li>)}</ul></section>
          {pending.plan.consequences.length > 0 && <p className="mt-2 text-[11px] text-amber-300/80">{pending.plan.consequences.join(' · ')}</p>}
          <div className="mt-3 flex gap-2">
            <button data-testid={`approve-${pending.id}`} onClick={() => { pending.resolve('approved'); removePlan(pending.id) }} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900">Apply plan</button>
            <button data-testid={`reject-${pending.id}`} onClick={() => { pending.resolve('rejected'); removePlan(pending.id) }} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">Reject</button>
          </div>
        </div>
      ))}
    </div>
  )
}
