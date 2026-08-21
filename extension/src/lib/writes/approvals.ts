import type { CallClassification } from './classify'

export type Mode = 'ask' | 'auto'

export interface ApprovalContext {
  mode: Mode
  /** Page ids the user explicitly referenced this turn. */
  contextSet: Set<string>
  rowCount?: number
}

export type ApprovalVerdict =
  | { action: 'allow' }
  | { action: 'require-approval'; reasons: string[] }
  | { action: 'refuse'; reasons: string[] }

export const BULK_CONFIRM_ROWS = 25

/**
 * Decides whether a mutation may run immediately (MVP §6.3). Ask-before-changes
 * is the default; Auto still gates the escalation list.
 */
export function evaluateApproval(call: CallClassification & { name: string; args: Record<string, unknown> }, ctx: ApprovalContext): ApprovalVerdict {
  if (!call.mutates) return { action: 'allow' }

  const reasons: string[] = []

  if (ctx.mode === 'ask') {
    reasons.push('ask-before-changes mode is on')
  }

  const targetPageId = extractTargetPageId(call.args)
  if (targetPageId && !ctx.contextSet.has(targetPageId)) {
    reasons.push('the target page is outside this conversation’s context')
  }

  if (call.kind === 'move') reasons.push('moving pages is always confirmed')
  if ((call.kind === 'schema' || call.kind === 'view') && targetPageId) reasons.push('schema and view changes are always confirmed')
  if (typeof ctx.rowCount === 'number' && ctx.rowCount > BULK_CONFIRM_ROWS) {
    reasons.push(`bulk runs over ${BULK_CONFIRM_ROWS} rows are always confirmed`)
  }
  if (call.args.injected_request === true) {
    return { action: 'refuse', reasons: ['this request came from page content, not from you'] }
  }

  if (reasons.length > 0) return { action: 'require-approval', reasons }
  return { action: 'allow' }
}

function extractTargetPageId(args: Record<string, unknown>): string | null {
  const candidates = [args.page_id, args.parent, args.data, args.command]
  for (const c of candidates) {
    if (typeof c === 'string' && /^[0-9a-f-]{32}$/i.test(c)) return c
    if (c && typeof c === 'object') {
      const nested = c as Record<string, unknown>
      const id = nested.page_id ?? nested.id
      if (typeof id === 'string') return id
    }
  }
  return null
}

/** One pending approval card; resolves when the user answers. */
export interface PendingApproval {
  id: number
  tool: string
  summary: string
  payloadJson: string
  reasons: string[]
  resolve: (approved: boolean) => void
}

let nextApprovalId = 1

export class ApprovalEngine {
  private pending = new Map<number, PendingApproval>()
  private approveAllUntilTurnEnd = false

  constructor(
    private readonly notify?: (approval: PendingApproval) => void,
  ) {}

  beginTurn(): void {
    this.approveAllUntilTurnEnd = false
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Blocks until the user answers the card. Resolves true when approved
   * directly or via approve-all-this-turn.
   */
  async request(
    call: CallClassification & { name: string; args: Record<string, unknown> },
    verdict: Extract<ApprovalVerdict, { action: 'require-approval' }>,
  ): Promise<boolean> {
    if (this.approveAllUntilTurnEnd) return true
    return new Promise<boolean>((resolve) => {
      const approval: PendingApproval = {
        id: nextApprovalId++,
        tool: call.name,
        summary: summarizeCall(call),
        payloadJson: JSON.stringify(call.args, null, 2).slice(0, 2000),
        reasons: verdict.reasons,
        resolve: (approved) => {
          this.pending.delete(approval.id)
          resolve(approved)
        },
      }
      this.pending.set(approval.id, approval)
      this.notify?.(approval)
    })
  }

  answer(id: number, decision: 'approve' | 'reject' | 'approve-all'): void {
    if (decision === 'approve-all') this.approveAllUntilTurnEnd = true
    // Resolve every waiting card on approve-all; just this one otherwise.
    if (decision === 'approve-all') {
      for (const approval of [...this.pending.values()]) approval.resolve(true)
    } else {
      this.pending.get(id)?.resolve(decision === 'approve')
    }
  }

  rejectAllPending(): void {
    for (const approval of [...this.pending.values()]) approval.resolve(false)
  }
}

function summarizeCall(call: CallClassification & { name: string }): string {
  switch (call.kind) {
    case 'content-replace': return 'Replace page content'
    case 'content-update': return 'Edit page content'
    case 'properties': return 'Change page properties'
    case 'move': return 'Move pages'
    case 'duplicate': return 'Duplicate a page'
    case 'create-page': return 'Create new page(s)'
    case 'create-database': return 'Create a database'
    case 'create-folder': return 'Create a folder'
    case 'create-comment': return 'Post a comment'
    case 'schema': return 'Change database schema'
    case 'view': return 'Create or change a view'
    default: return call.name
  }
}
