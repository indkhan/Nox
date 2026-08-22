import { useEffect, useState } from 'react'
import { useNoxStore } from './store'
import { writeGate } from '../lib/agent/panel'
import { undoNewest } from '../lib/writes/undo'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { StatusPill } from './ui/StatusPill'

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
    <div className="space-y-2 p-3" data-testid="approval-cards">
      {pending.map((approval: CardApproval) => (
        <div
          key={approval.id}
          role="alert"
          className="overflow-hidden rounded-card bg-surface shadow-card"
          style={{ animation: 'fade-up 350ms cubic-bezier(0.23,1,0.32,1) both' }}
        >
          <div className="p-3">
            <div className="flex items-center gap-2">
              <StatusPill tone="orange">Approval needed</StatusPill>
              <Chip className="ml-auto">{approval.tool}</Chip>
            </div>
            <p className="mt-2 text-[13px] font-medium text-ink" data-testid={`approval-summary-${approval.id}`}>
              {approval.summary}
            </p>
            {approval.reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-[11.5px] leading-relaxed text-ink-3">
                {approval.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <details className="group mt-2">
              <summary className="cursor-pointer select-none text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink">
                Exact payload
              </summary>
              <pre className="mt-1.5 max-h-32 overflow-auto rounded-control bg-inset p-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
                {approval.payloadJson}
              </pre>
            </details>
            <div className="mt-3 flex items-center gap-1.5">
              <Button
                variant="success"
                size="sm"
                onClick={() => {
                  writeGate.approvals.answer(approval.id, 'approve')
                  removeApproval(approval.id)
                }}
                data-testid={`approve-${approval.id}`}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  writeGate.approvals.answer(approval.id, 'approve-all')
                  useNoxStore.getState().pendingApprovals.forEach((a) => removeApproval(a.id))
                }}
              >
                Approve all this turn
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red hover:bg-red-tint hover:text-red"
                onClick={() => {
                  writeGate.approvals.answer(approval.id, 'reject')
                  removeApproval(approval.id)
                }}
                data-testid={`reject-${approval.id}`}
              >
                Reject
              </Button>
            </div>
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
    <div className="flex items-center justify-between gap-2 px-4 py-1.5" data-testid="undo-bar">
      <span className="truncate text-[11.5px] text-ink-3">
        {status ?? `${undoableCount} reversible change${undoableCount === 1 ? '' : 's'}`}
      </span>
      {!status && (
        <button
          onClick={() => void runUndo(setStatus, readOnly)}
          data-testid="undo-latest"
          className="shrink-0 rounded-chip bg-field px-2 py-1 text-[11px] font-medium text-ink-2 shadow-hairline transition-colors duration-100 hover:text-ink"
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
    await undoNewest(writeGate.journal, (tool, args) => writeGate.handleUndo(tool, args))
    setStatus('Undone — note block ids change on content restores')
  } catch (e) {
    setStatus(`Partial failure: ${e instanceof Error ? e.message : String(e)}`)
  }
}
