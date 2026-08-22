import { useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'
import { writeGate } from '../lib/agent/panel'
import { undoNewest } from '../lib/writes/undo'

type CardApproval = { id: number; tool: string; summary: string; payloadJson: string; reasons: string[]; targetUrl?: string; reversibility: string }

/**
 * Approval cards (MVP §7): tool, plain-language summary, exact payload,
 * Approve / Approve all this turn / Reject. Renders above the composer and
 * blocks the turn until answered.
 */
export function ApprovalCards({ readOnly = false }: { readOnly?: boolean }) {
  const pending = useNoxStore((s) => s.pendingApprovals)
  const removeApproval = useNoxStore((s) => s.removeApproval)
  const firstCardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pending.length > 0 && !readOnly) firstCardRef.current?.focus()
  }, [pending.length, readOnly])

  if (readOnly || pending.length === 0) return null

  return (
    <div className="space-y-2 border-t border-zinc-800 bg-zinc-950/80 p-3" data-testid="approval-cards">
      {pending.map((approval: CardApproval) => (
        <div ref={approval === pending[0] ? firstCardRef : undefined} tabIndex={-1} key={approval.id} className="rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-lg shadow-black/20" role="alertdialog" aria-label="Approval required">
          <p className="nox-active text-xs font-medium">Make this change?</p>
          <p className="mt-1 text-sm font-medium leading-snug" data-testid={`approval-summary-${approval.id}`}>{approval.summary}</p>
          <ul className="mt-1.5 list-disc pl-4 text-[11px] text-zinc-500">
            {approval.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
            {approval.targetUrl && <a href={approval.targetUrl} target="_blank" rel="noreferrer" className="nox-active underline-offset-2 hover:underline">Open target</a>}
            <span>{approval.reversibility}</span>
          </div>
          <details className="mt-1.5">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-500">Technical details</summary>
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400">{approval.payloadJson}</pre>
          </details>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'approve')
                removeApproval(approval.id)
              }}
              data-testid={`approve-${approval.id}`}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white"
            >
              Approve
            </button>
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'approve-all')
                useNoxStore.getState().pendingApprovals.forEach((a) => removeApproval(a.id))
              }}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Approve all this turn
            </button>
            <button
              onClick={() => {
                writeGate.approvals.answer(approval.id, 'reject')
                removeApproval(approval.id)
              }}
              data-testid={`reject-${approval.id}`}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
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
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const refresh = () => void writeGate.journal.undoable().then((entries) => setUndoableCount(entries.length))
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [])

  if (readOnly || (undoableCount === 0 && !status && !running)) return null

  const run = async () => {
    if (running) return
    setRunning(true)
    const message = await runUndo(readOnly)
    setStatus(message)
    setUndoableCount((await writeGate.journal.undoable()).length)
    setRunning(false)
    window.setTimeout(() => setStatus(null), 2500)
  }

  return (
    <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1.5" data-testid="undo-bar">
      <span className="text-[11px] text-zinc-500">
        {status ?? `${undoableCount} reversible change${undoableCount === 1 ? '' : 's'}`}
      </span>
      {undoableCount > 0 && (
        <button
          onClick={() => void run()}
          disabled={running}
          data-testid="undo-latest"
          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          {running ? 'Undoing…' : 'Undo latest'}
        </button>
      )}
    </div>
  )
}

async function runUndo(readOnly: boolean): Promise<string> {
  if (readOnly) return 'Undo unavailable in read-only mode'
  try {
    const undone = await undoNewest(writeGate.journal, (tool, args) => writeGate.handleUndo(tool, args))
    return undone ? 'Undone — note block ids change on content restores' : 'Nothing available to undo'
  } catch (e) {
    return `Partial failure: ${e instanceof Error ? e.message : String(e)}`
  }
}
