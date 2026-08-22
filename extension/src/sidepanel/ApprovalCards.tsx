import { useEffect, useState } from 'react'
import { useNoxStore } from './store'
import { writeGate } from '../lib/agent/panel'
import { notion } from '../lib/notion/panel'
import { undoNewest } from '../lib/writes/undo'

type CardApproval = { id: number; tool: string; summary: string; payloadJson: string; reasons: string[] }

/**
 * Approval cards (MVP §7): tool, plain-language summary, exact payload,
 * Approve / Approve all this turn / Reject. Renders above the composer and
 * blocks the turn until answered.
 */
export function ApprovalCards({ readOnly = false }: { readOnly?: boolean }) {
  const pending = useNoxStore((s) => s.pendingApprovals)
  const removeApproval = useNoxStore((s) => s.removeApproval)

  if (readOnly || pending.length === 0) return null

  return (
    <div className="space-y-2 border-t border-amber-900/50 bg-amber-950/20 p-3" data-testid="approval-cards">
      {pending.map((approval: CardApproval) => (
        <div key={approval.id} className="rounded-lg border border-amber-800/60 bg-zinc-900 p-3" role="alert">
          <p className="text-xs uppercase tracking-wide text-amber-400">Approval needed</p>
          <p className="mt-0.5 text-sm font-medium" data-testid={`approval-summary-${approval.id}`}>{approval.summary}</p>
          <ul className="mt-1 list-disc pl-4 text-[11px] text-zinc-500">
            {approval.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <details className="mt-1.5">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-500">Exact payload</summary>
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400">{approval.payloadJson}</pre>
          </details>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'approve')
                removeApproval(approval.id)
              }}
              data-testid={`approve-${approval.id}`}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold hover:bg-emerald-500"
            >
              Approve
            </button>
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'approve-all')
                useNoxStore.getState().pendingApprovals.forEach((a) => removeApproval(a.id))
              }}
              className="rounded-md border border-emerald-700 px-3 py-1 text-xs text-emerald-400 hover:bg-emerald-900/40"
            >
              Approve all this turn
            </button>
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'reject')
                removeApproval(approval.id)
              }}
              data-testid={`reject-${approval.id}`}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-semibold hover:bg-red-500"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** One-click undo of the latest reversible mutation (MVP §6.5). */
export function UndoBar({ readOnly = false }: { readOnly?: boolean }) {
  const [undoableCount, setUndoableCount] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => void writeGate.journal.undoable().then((entries) => setUndoableCount(entries.length))
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [])

  if (readOnly || (undoableCount === 0 && !status)) return null

  return (
    <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1.5" data-testid="undo-bar">
      <span className="text-[11px] text-zinc-500">
        {status ?? `${undoableCount} reversible change${undoableCount === 1 ? '' : 's'}`}
      </span>
      {!status && (
        <button
          onClick={() => void runUndo(setStatus, readOnly)}
          data-testid="undo-latest"
          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          Undo latest
        </button>
      )}
    </div>
  )
}

async function runUndo(setStatus: (s: string) => void, readOnly: boolean): Promise<void> {
  if (readOnly) return
  try {
    await undoNewest(writeGate.journal, (tool, args) => notion.scheduleCallTool(tool, args))
    setStatus('Undone — note block ids change on content restores')
  } catch (e) {
    setStatus(`Partial failure: ${e instanceof Error ? e.message : String(e)}`)
  }
}
