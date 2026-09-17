import type { CallClassification } from './classify'
import { normalizeId } from '../../shared/notion-page'
import type { ToolCallRequest } from '../codex/client'
import { isDestructiveKind } from './effects'

export type Mode = 'ask' | 'auto'

/**
 * Explicit per-turn small-edit grant captured from the composer at Send.
 * Available only in Auto, off by default, never set by model tools: silent
 * edits may only touch listed pages, and only for fixture-verified
 * non-destructive property updates and targeted text additions.
 */
export interface SmallEditGrant {
  allowed: boolean
  pages: string[]
}

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

export interface ApprovalCall extends CallClassification {
  name: string
  args: Record<string, unknown>
  provenance?: ToolCallRequest['provenance']
  /** Pre-parsed affected targets from the validated effect — never re-derived from raw args. */
  targets: string[]
  /** Pre-parsed parent/destination ids, also consent-relevant for creations and moves. */
  parents: string[]
  /** Affected-object count from the validated effect (creations count even with no existing targets). */
  affectedCount: number
  /** Explicit per-turn grant; Auto without it requests ordinary consent. */
  grant: SmallEditGrant
}

/**
 * Decides whether a mutation may run immediately (MVP §6.3). Auto is the
 * default. In Auto, silence requires the explicit per-turn small-edit
 * grant for an eligible effect — anything else takes the ordinary action card.
 * The grant never waives other escalations: schema, moves, out-of-context
 * targets, and untrusted exposure still need review. Ask mode gates every
 * mutation behind an approval card.
 */
export function evaluateApproval(call: ApprovalCall, ctx: ApprovalContext): ApprovalVerdict {
  if (!call.mutates) return { action: 'allow' }

  const reasons: string[] = []

  if (ctx.mode === 'ask') {
    reasons.push('ask-before-changes mode is on')
  } else if (!isGrantEligible(call)) {
    reasons.push(grantRefusalReason(call))
  }

  const scoped = [...ctx.contextSet].map((id) => normalizeId(id) ?? id)
  const outOfContext = [...call.targets, ...call.parents].some(
    (target) => !scoped.includes(normalizeId(target) ?? target),
  )
  if (outOfContext) {
    reasons.push('the target page is outside this conversation’s context')
  }

  if (call.kind === 'move') reasons.push('moving pages is always confirmed')
  if (call.kind === 'schema' || call.kind === 'view') reasons.push('schema and view changes are always confirmed')
  if (call.kind === 'unknown') reasons.push('unknown tools are always confirmed')
  if (call.provenance === 'untrusted-context') reasons.push('the turn includes untrusted Notion content')
  if (typeof ctx.rowCount === 'number' && ctx.rowCount > BULK_CONFIRM_ROWS) {
    reasons.push(`bulk runs over ${BULK_CONFIRM_ROWS} rows are always confirmed`)
  }
  if (reasons.length > 0) return { action: 'require-approval', reasons }
  return { action: 'allow' }
}

/**
 * Grant-eligible effects: fixture-verified non-destructive single-object
 * property updates and targeted text additions on listed pages only.
 * Excludes replacement, deletion, creation, moves, schema/view changes,
 * upload, unknown effects, and out-of-grant targets.
 */
function isGrantEligible(call: ApprovalCall): boolean {
  if (!call.grant.allowed) return false
  if (call.kind !== 'properties' && call.kind !== 'content-update') return false
  const pages = new Set(call.grant.pages.map((id) => normalizeId(id) ?? id))
  const scopeIds = [...call.targets, ...call.parents].map((id) => normalizeId(id) ?? id)
  if (scopeIds.length === 0) return false
  return scopeIds.every((id) => pages.has(id))
}

function grantRefusalReason(call: ApprovalCall): string {
  if (!call.grant.allowed) {
    return 'Auto mode needs the “Allow small edits this turn” grant for silent edits — approve each change instead'
  }
  if (call.kind !== 'properties' && call.kind !== 'content-update') {
    return 'the small-edit grant covers only property updates and small text additions on the listed pages'
  }
  return 'the change targets pages outside the granted small-edit pages'
}

/**
 * Display data for one pending approval card. Components receive exactly
 * this — never the frozen execution snapshot and never promise authority.
 */
export interface ApprovalDisplay {
  id: number
  tool: string
  summary: string
  /** Complete bounded canonical JSON — never sliced. */
  payloadJson: string
  reasons: string[]
  targetUrl?: string
  reversibility: string
  targets: string[]
  affectedCount: number
  destructive: boolean
}

/** What an answered card resolves: the decision plus the frozen execution payload. */
export interface ApprovalDecision {
  approved: boolean
  frozenArgs: Record<string, unknown>
}

interface PendingEntry {
  display: ApprovalDisplay
  frozenArgs: Record<string, unknown>
  resolve: (decision: ApprovalDecision) => void
}

let nextApprovalId = 1

export class ApprovalEngine {
  private pending = new Map<number, PendingEntry>()

  constructor(
    private readonly notify?: (approval: ApprovalDisplay) => void,
  ) {}

  get pendingCount(): number {
    return this.pending.size
  }

  get pendingIds(): number[] {
    return [...this.pending.keys()]
  }

  /**
   * Blocks until the user answers the card. The execution payload is frozen
   * privately at request time; later edits of the caller's object cannot
   * change what an approval dispatches.
   */
  async request(
    call: ApprovalCall,
    verdict: Extract<ApprovalVerdict, { action: 'require-approval' }>,
  ): Promise<ApprovalDecision> {
    const frozenArgs: Record<string, unknown> = structuredClone(call.args)
    return new Promise<ApprovalDecision>((resolve) => {
      const display: ApprovalDisplay = {
        id: nextApprovalId++,
        tool: call.name,
        summary: summarizeCall(call),
        payloadJson: JSON.stringify(frozenArgs, null, 2),
        reasons: verdict.reasons,
        targetUrl: approvalTargetUrl(call.targets),
        reversibility: approvalReversibility(call.kind),
        targets: [...call.targets],
        affectedCount: call.affectedCount,
        destructive: isDestructiveKind(call.kind),
      }
      this.pending.set(display.id, { display, frozenArgs, resolve })
      this.notify?.(display)
    })
  }

  /**
   * Answer one pending card. Returns false for stale or already-resolved
   * ids — a late decision never approves anything.
   */
  answer(id: number, decision: 'approve' | 'reject'): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.resolve({ approved: decision === 'approve', frozenArgs: entry.frozenArgs })
    return true
  }

  rejectAllPending(): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.display.id)
      entry.resolve({ approved: false, frozenArgs: entry.frozenArgs })
    }
  }
}

function approvalTargetUrl(targets: string[]): string | undefined {
  const pageId = targets[0]
  return pageId ? `https://www.notion.so/${pageId.replace(/-/g, '')}` : undefined
}

function approvalReversibility(kind: CallClassification['kind']): string {
  if (kind === 'create-page' || kind === 'create-database' || kind === 'create-folder' || kind === 'create-comment' || kind === 'duplicate') {
    return 'Cannot be undone automatically'
  }
  if (kind === 'content-replace' || kind === 'content-update' || kind === 'properties') {
    return 'Undo availability is checked after the change'
  }
  return 'This change may not be reversible'
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
