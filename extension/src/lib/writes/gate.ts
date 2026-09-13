import type { ToolCallRequest } from '../codex/client'
import { classifyToolCall, detectRichPage, requiresWorkspacePlan, type CallClassification } from './classify'
import { buildInverse, type PreImage } from './inverse'
import { capturePageSnapshot, assertUnchanged, GuardViolation, type PageSnapshot } from './guard'
import { normalizePageFetch, normalizePageText, requireCompleteBaseline, BaselineError, type NormalizedPageFetch, type PageFetchStatus } from '../notion/page-content'
import { ApprovalEngine, evaluateApproval, type Mode, type SmallEditGrant } from './approvals'
import { MutationJournal, type IntentScope, type JournalEntry } from './journal'
import { hashMarkdown } from './guard'
import { normalizeId } from '../../shared/notion-page'
import { UncertainDispatchError } from '../mcp/scheduler'
import { isPreDispatchFailure } from '../mcp/client'
import { validateEffect, type ValidatedEffect } from './effects'
import { recordRetrievals } from '../agent/retrievals'
import type { PlanScope } from '../architect/plan-engine'

export type MutationRejectionCode =
  | 'NOT_OWNER'
  | 'LEASE_EXPIRED'
  | 'CONNECTION_CHANGED'
  | 'TURN_ACTIVE'
  | 'UNDO_IN_PROGRESS'
  | 'NOT_UNDOABLE'
  | 'NO_PERSISTED_THREAD'
  | 'NO_WORKSPACE_SCOPE'
  | 'CONFLICT_UNRESOLVED'
  | 'JOURNAL_STORAGE_ERROR'

/** Typed refusal for a mutation that must not reach the transport. */
export class MutationRejectedError extends Error {
  readonly code: MutationRejectionCode
  constructor(code: MutationRejectionCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'MutationRejectedError'
    this.code = code
  }
}

/**
 * Runtime ownership consulted by the gate before every external effect.
 * Production wires this to the `nox-agent-owner` Web Lock lease plus the
 * Notion connection generation; tests substitute fakes. There is no
 * allow-by-default: a missing lease refuses the mutation.
 */
export interface MutationOwnership {
  isOwner: () => boolean
  getOwnerGeneration: () => string | null
  getConnectionGeneration?: () => string | null
}

interface OwnershipSnapshot {
  ownerGeneration: string
  connectionGeneration: string | null
}

/**
 * A model-visible read baseline: the normalized content hash plus the scope
 * it was established in. Guard-only reads never populate this map, so a
 * guard snapshot the model never saw cannot become an edit baseline.
 */
interface BaselineRecord {
  hash: string
  status: PageFetchStatus
  workspaceId: string | null
  connectionGeneration: string | null
  threadId: string | null
  capturedAt: number
}

export interface ReadbackEvidence {
  supported: boolean
  match?: boolean
  detail: string
  targetPageId?: string
}

export interface WriteGateDeps {
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
  fetchPageMarkdown: (pageId: string, signal?: AbortSignal) => Promise<string>
  getMode: () => Mode
  getContextSet: () => Set<string>
  journal?: MutationJournal
  onApproval?: ApprovalEngine['notify']
  authorizeStructuralChange?: (effect: ValidatedEffect, scope: PlanScope) => { allowed: boolean; reason?: string; reservationId?: string }
  checkPlanReservation?: (reservationId: string, scope: PlanScope) => boolean
  consumePlanReservation?: (reservationId: string, resultText?: string) => void
  ownership?: MutationOwnership
  /** Workspace scope for intents; mutations are refused without one. */
  getWorkspaceId?: () => string | null
  /** Capability check for inverse tools, which bypass the executor pre-check. */
  assertToolAllowed?: (tool: string) => void
  /** Explicit per-turn small-edit grant captured at Send. */
  getSmallEditGrant?: () => SmallEditGrant
  /** Reserve unplanned-effect budget, counted by objects. Absent means uncapped (tests). */
  recordUnplannedEffects?: (count: number) => boolean
}

const CONTENT_WRITE_KINDS = new Set(['content-replace', 'content-update'])

/**
 * The full mutation chain (docs/plans/E6.md): classify → approve → guard →
 * execute → journal. Reads pass straight through.
 */
export class WriteGate {
  readonly approvals: ApprovalEngine
  readonly journal: MutationJournal
  /**
   * Model-visible read baselines by normalized page id. Only successful reads
   * the model actually observed are stored here — guard snapshots stay out,
   * so two fresh guard reads can never bless a stale model proposal.
   * Entries are scoped (thread/workspace/connection); stale scopes read as
   * missing, which forces a re-fetch after resume or reconnect.
   */
  private readonly baselines = new Map<string, BaselineRecord>()
  /**
   * Serial mutation runner. Forward writes, upload effects, and undo all
   * share this chain so at most one critical interval (final guard →
   * dispatch → journal update) is in flight. Reads bypass it entirely.
   * Per-panel-instance only: cross-window atomicity arrives with the durable
   * intent work, so a second owner must still reconcile before writing.
   */
  private mutationTail: Promise<void> = Promise.resolve()
  private turnActive = false
  private undoActive = false
  /**
   * Intent ids with a live critical interval in this panel. The conflict
   * check skips them so queued work is not blocked by its own in-flight
   * intent; a crash clears this set, so stale rows block until reviewed.
   */
  private readonly activeIntentIds = new Set<string>()

  constructor(private readonly deps: WriteGateDeps) {
    this.journal = deps.journal ?? new MutationJournal()
    this.approvals = new ApprovalEngine(deps.onApproval)
  }

  beginTurn(): void {
    this.turnActive = true
  }

  endTurn(): void {
    this.turnActive = false
  }

  isTurnActive(): boolean {
    return this.turnActive
  }

  isUndoActive(): boolean {
    return this.undoActive
  }

  /**
   * Record a model-visible page read as a candidate edit baseline. Partial
   * reads are stored as partial (analysis only, never replacement); failed,
   * unavailable, and unrecognized payloads establish nothing.
   */
  async rememberPageRead(pageId: string, markdown: string): Promise<void> {
    let record
    try {
      record = normalizePageText(pageId, markdown)
    } catch {
      return
    }
    this.baselines.set(record.pageId, {
      hash: await hashMarkdown(record.markdown),
      status: record.status,
      workspaceId: this.deps.getWorkspaceId?.() ?? null,
      connectionGeneration: this.deps.ownership?.getConnectionGeneration?.() ?? null,
      threadId: this.journal.captureScope().threadId,
      capturedAt: Date.now(),
    })
  }

  /**
   * Record a model-visible `notion-fetch` envelope, preserving provider
   * completeness signals. Tool-declared failures and unrecognized wrappers
   * establish no baseline; partial reads are stored as partial.
   */
  async rememberNormalizedRead(
    pageId: string,
    result: { isError?: unknown; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown },
  ): Promise<void> {
    let record
    try {
      record = normalizePageFetch(pageId, result)
    } catch {
      return
    }
    this.baselines.set(record.pageId, {
      hash: await hashMarkdown(record.markdown),
      status: record.status,
      workspaceId: this.deps.getWorkspaceId?.() ?? null,
      connectionGeneration: this.deps.ownership?.getConnectionGeneration?.() ?? null,
      threadId: this.journal.captureScope().threadId,
      capturedAt: Date.now(),
    })
  }

  /** In-scope baseline for a page, or null when no valid baseline exists. */
  private currentBaseline(pageId: string): BaselineRecord | null {
    const key = normalizeId(pageId) ?? pageId
    const record = this.baselines.get(key)
    if (!record) return null
    if (record.threadId !== this.journal.captureScope().threadId) return null
    if (record.workspaceId !== (this.deps.getWorkspaceId?.() ?? null)) return null
    if (record.connectionGeneration !== (this.deps.ownership?.getConnectionGeneration?.() ?? null)) return null
    return record
  }

  /** Retire the baseline after a write, unknown outcome, or incompatible read. */
  private retireBaseline(pageId: string): void {
    this.baselines.delete(normalizeId(pageId) ?? pageId)
  }

  /**
   * Expire all read baselines (Epoch 11): reconnect, sign-out, and workspace
   * replacement retire every model-observed baseline so the next content
   * write forces a fresh re-fetch instead of reusing a stale scope.
   */
  expireBaselines(): void {
    this.baselines.clear()
  }

  async handle(req: ToolCallRequest): Promise<unknown> {
    return this.handleRequest(req, false)
  }

  /**
   * Undo entry through the same ownership + serial boundary as forward
   * writes. Creates its own durable intent linked to the original operation,
   * reserves the original atomically, and marks it undone only when the
   * inverse is known applied. Rejects while a turn is active or unresolved
   * work conflicts (never queues for later).
   */
  async handleUndo(tool: string, args: Record<string, unknown>, opts: { journalId?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const snapshot = this.admitMutation(opts.signal)
    if (this.turnActive) {
      throw new MutationRejectedError('TURN_ACTIVE', 'Nox is working — wait for the turn to finish before undoing. No changes were made.')
    }
    const scope = this.captureIntentScope(snapshot)
    await this.requireNoConflict(scope.threadId)
    return this.runExclusive(async () => {
      this.reassertMutation(snapshot, opts.signal)
      if (this.turnActive) {
        throw new MutationRejectedError('TURN_ACTIVE', 'a turn started while this undo was queued — the undo was refused. No changes were made.')
      }
      let original: JournalEntry | undefined
      if (opts.journalId) {
        original = await this.revalidateUndoEntry(opts.journalId, tool, args)
        this.deps.assertToolAllowed?.(original.inverse!.tool)
      } else {
        this.deps.assertToolAllowed?.(tool)
      }
      const frozenArgs = { ...args }
      // Every undo dispatches an external effect, so every undo — linked or
      // not — gets its own durable intent. Linked undo additionally reserves
      // the original atomically; a lost reservation race refuses without
      // transport instead of double-dispatching.
      let undoOp: JournalEntry | undefined
      if (opts.journalId) {
        const reservation = await this.journal.beginUndoReservation(opts.journalId, {
          tool,
          args: frozenArgs,
          kind: 'undo',
          scope,
          targetPageId: original?.targetPageId,
        })
        if (!reservation) {
          throw new MutationRejectedError('NOT_UNDOABLE', 'this change is no longer available to undo.')
        }
        undoOp = reservation.undo
      } else {
        try {
          undoOp = await this.journal.beginIntent({
            tool,
            args: frozenArgs,
            kind: 'undo',
            scope,
            targetPageId: undefined,
          })
        } catch (e) {
          throw new Error(`JOURNAL_STORAGE_ERROR: the recovery record could not be persisted (${e instanceof Error ? e.message : String(e)}). No changes were made.`)
        }
      }
      const undoOpId = undoOp.id
      this.activeIntentIds.add(undoOpId)
      this.undoActive = true
      try {
        const guard = await this.runGuardPhase(
          { rid: 0, tool, args, namespace: null, provenance: 'user-only', signal: opts.signal },
          classifyToolCall(tool, args),
          trustedPageId(args),
        )
        if (!guard.ok) {
          const guardDetail = textOfResult(guard.result)
          await this.settleUndo(undoOpId, opts.journalId, 'failed', `undo guard refused: ${guardDetail}`)
          throw new Error(guardDetail)
        }
        try {
          opts.signal?.throwIfAborted()
        } catch {
          await this.settleUndo(undoOpId, opts.journalId, 'failed', 'cancelled before dispatch')
          throw new Error('TURN_CANCELLED: the undo was cancelled before dispatch. No changes were made.')
        }
        let result: unknown
        try {
          // Trusted internal fields (undo hashes) travel in the journal but
          // never reach the provider.
          result = await this.deps.callTool(tool, stripReservedArgs(frozenArgs), opts.signal)
        } catch (e) {
          const [status, detail] = classifyDispatchOutcome(e)
          await this.settleUndo(undoOpId, opts.journalId, status, detail)
          if (status === 'unknown') {
            const undoPage = trustedPageId(args)
            if (undoPage) this.retireBaseline(undoPage)
          }
          throw e
        }
        if (isErrorResult(result)) {
          const detail = result.content.map((part) => part.text ?? '').join('\n')
          await this.settleUndo(undoOpId, opts.journalId, 'failed', detail)
          throw new Error(detail || 'the undo was rejected by the provider')
        }
        {
          const undoPage = trustedPageId(args)
          if (undoPage) this.retireBaseline(undoPage)
        }
        if (undoOpId) {
          try {
            await this.journal.settleIntent(undoOpId, { status: 'applied' })
          } catch (e) {
            console.error('[nox] undo applied but journal status update failed', e)
            throw appliedRecoveryWarning(result)
          }
        }
        if (opts.journalId) {
          try {
            await this.journal.settleIntent(opts.journalId, { status: 'undone', reservedByUndoOpId: null })
          } catch (e) {
            // The undo applied and its intent is durable; the original stays
            // reserved (never safely clickable twice) with a visible warning.
            console.error('[nox] undo applied but original status update failed', e)
            throw appliedRecoveryWarning(result)
          }
        }
        return result
      } finally {
        this.undoActive = false
        if (undoOpId) this.activeIntentIds.delete(undoOpId)
      }
    })
  }

  /** Settle an undo intent and release (or retain) the original reservation. */
  private async settleUndo(
    undoOpId: string | undefined,
    originalId: string | undefined,
    status: 'applied' | 'failed' | 'unknown',
    detail?: string,
  ): Promise<void> {
    try {
      if (undoOpId) await this.journal.settleIntent(undoOpId, { status, outcomeDetail: detail })
      if (originalId && status === 'failed' && undoOpId) {
        await this.journal.releaseUndoReservation(originalId, undoOpId)
      }
    } catch (e) {
      console.error('[nox] undo outcome bookkeeping failed', e)
    }
  }

  /**
   * Shared serial boundary for external effects that do not flow through
   * handle() (currently the upload ticket + byte upload). Enforces the same
   * owner lease, scope, conflict, and undo exclusion as forward writes, and
   * persists its own pending intent so every dispatched effect has a durable
   * identity. Intent args must be metadata only — never blob bytes.
   */
  async runEffectExclusive<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    intent?: { tool: string; args: Record<string, unknown>; kind?: string; targetPageId?: string },
  ): Promise<T> {
    if (!intent) throw new Error('runEffectExclusive requires an intent description')
    if (this.undoActive) {
      throw new MutationRejectedError('UNDO_IN_PROGRESS', 'an undo is running — wait for it to finish. No changes were made.')
    }
    const snapshot = this.admitMutation(signal)
    const scope = this.captureIntentScope(snapshot)
    await this.requireNoConflict(scope.threadId)
    return this.runExclusive(async () => {
      this.reassertMutation(snapshot, signal)
      let op: JournalEntry
      try {
        op = await this.journal.beginIntent({
          tool: intent.tool,
          args: { ...intent.args },
          kind: intent.kind ?? 'upload',
          scope,
          targetPageId: intent.targetPageId,
        })
      } catch (e) {
        throw new MutationRejectedError('JOURNAL_STORAGE_ERROR', `the recovery record could not be persisted (${e instanceof Error ? e.message : String(e)}). No changes were made.`)
      }
      this.activeIntentIds.add(op.id)
      try {
        try {
          signal?.throwIfAborted()
        } catch {
          await this.settleProtected(op.id, { status: 'failed', outcomeDetail: 'cancelled before dispatch' })
          throw new Error('TURN_CANCELLED: the effect was cancelled before dispatch. No changes were made.')
        }
        try {
          const value = await fn()
          try {
            await this.journal.settleIntent(op.id, { status: 'applied' })
          } catch (e) {
            console.error('[nox] effect succeeded but journal persistence failed', e)
            throw appliedRecoveryWarning(value)
          }
          return value
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('APPLIED_WITH_RECOVERY_WARNING')) throw e
          const [status, detail] = classifyDispatchOutcome(e)
          await this.settleProtected(op.id, { status, outcomeDetail: detail })
          throw e
        }
      } finally {
        this.activeIntentIds.delete(op.id)
      }
    })
  }

  /**
   * Narrow readback for an unresolved operation: only a content replacement
   * with a known page and exact intended content can be compared. Evidence
   * never proves authorship — a match means the current state looks like
   * what Nox attempted, nothing more.
   */
  async readbackForReview(journalId: string): Promise<ReadbackEvidence> {
    const entry = (await this.journal.newestFirst()).find((candidate) => candidate.id === journalId)
    if (!entry) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'this change is no longer available to review.')
    }
    if (entry.status !== 'pending' && entry.status !== 'unknown') {
      throw new MutationRejectedError('NOT_UNDOABLE', 'only unresolved operations can be checked this way.')
    }
    const intended = intendedReplaceContent(entry)
    if (!intended) {
      return {
        supported: false,
        targetPageId: entry.targetPageId,
        detail: 'This change cannot be verified by readback — inspect it in Notion before marking it reviewed.',
      }
    }
    let current: NormalizedPageFetch
    try {
      current = normalizePageText(intended.pageId, await this.deps.fetchPageMarkdown(intended.pageId))
    } catch (e) {
      return {
        supported: false,
        targetPageId: intended.pageId,
        detail:
          e instanceof BaselineError
            ? `${e.message} Inspect it in Notion before marking it reviewed.`
            : `The current state could not be read (${e instanceof Error ? e.message : String(e)}). Inspect it in Notion before marking it reviewed.`,
      }
    }
    if (current.status !== 'complete') {
      return {
        supported: false,
        targetPageId: intended.pageId,
        detail:
          'The current read is incomplete, so the outcome cannot be verified by readback — inspect it in Notion before marking it reviewed.',
      }
    }
    const match = (await hashMarkdown(current.markdown)) === (await hashMarkdown(intended.content))
    return {
      supported: true,
      match,
      targetPageId: intended.pageId,
      detail: match
        ? 'Current content matches what Nox attempted (this does not prove Nox wrote it).'
        : 'Current content differs from what Nox attempted — inspect it in Notion.',
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(fn, fn)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Ownership + lease admission; throws before any approval UI or transport. */
  private admitMutation(signal?: AbortSignal): OwnershipSnapshot {
    const ownership = this.deps.ownership
    if (!ownership?.isOwner()) {
      throw new MutationRejectedError('NOT_OWNER', 'this window does not hold the agent lock — only the owner panel may mutate. No changes were made.')
    }
    const ownerGeneration = ownership.getOwnerGeneration()
    if (!ownerGeneration) {
      throw new MutationRejectedError('NOT_OWNER', 'there is no valid owner lease for this window. No changes were made.')
    }
    signal?.throwIfAborted()
    return { ownerGeneration, connectionGeneration: ownership.getConnectionGeneration?.() ?? null }
  }

  /** Re-check immediately before external dispatch; a queued operation from an expired lease/turn fails without transport. */
  private reassertMutation(snapshot: OwnershipSnapshot, signal?: AbortSignal): void {
    const ownership = this.deps.ownership
    if (!ownership?.isOwner()) {
      throw new MutationRejectedError('NOT_OWNER', 'owner lease lost while this operation was queued. No changes were made.')
    }
    if (ownership.getOwnerGeneration() !== snapshot.ownerGeneration) {
      throw new MutationRejectedError('LEASE_EXPIRED', 'ownership changed while this operation was queued. No changes were made.')
    }
    if ((ownership.getConnectionGeneration?.() ?? null) !== snapshot.connectionGeneration) {
      throw new MutationRejectedError('CONNECTION_CHANGED', 'the Notion connection changed while this operation was queued. No changes were made.')
    }
    signal?.throwIfAborted()
  }

  /** Fresh storage read so a restored activity row cannot replay a stale undo. */
  private async revalidateUndoEntry(journalId: string, tool: string, args: Record<string, unknown>): Promise<JournalEntry> {
    const entries = await this.journal.newestFirst()
    const entry = entries.find((candidate) => candidate.id === journalId)
    if (!entry || entry.status !== 'applied' || !entry.inverse) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'this change is no longer available to undo.')
    }
    if (entry.reservedByUndoOpId != null) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'an undo is already recorded for this change — inspect it before retrying.')
    }
    if (entry.inverse.tool !== tool || JSON.stringify(entry.inverse.args) !== JSON.stringify(args)) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'the stored undo no longer matches this change. No changes were made.')
    }
    return entry
  }

  /**
   * Runtime scope for intent capture: owner/connection generations from the
   * admission snapshot plus the journal thread/turn and workspace identity,
   * all read synchronously before any await that could observe a switch.
   */
  private captureIntentScope(snapshot: OwnershipSnapshot): IntentScope {
    const { threadId, turnId } = this.journal.captureScope()
    if (!threadId || !turnId) {
      throw new MutationRejectedError('NO_PERSISTED_THREAD', 'there is no persisted conversation thread for this change — reconnect or start a new chat. No changes were made.')
    }
    const workspaceId = this.deps.getWorkspaceId?.() ?? null
    if (!workspaceId) {
      throw new MutationRejectedError('NO_WORKSPACE_SCOPE', 'the connected Notion workspace is not established — reconnect Notion. No changes were made.')
    }
    return {
      threadId,
      turnId,
      workspaceId,
      connectionGeneration: snapshot.connectionGeneration,
      ownerGeneration: snapshot.ownerGeneration,
    }
  }

  /** Refuse new effects while another operation in scope is unresolved. Reads stay available. */
  private async requireNoConflict(threadId: string): Promise<void> {
    const blocking = await this.journal.unresolvedInScope(threadId, this.activeIntentIds)
    if (blocking.length > 0) {
      const kinds = [...new Set(blocking.map((entry) => entry.tool))].slice(0, 3).join(', ')
      throw new MutationRejectedError(
        'CONFLICT_UNRESOLVED',
        `${blocking.length} change${blocking.length === 1 ? '' : 's'} (${kinds}) still ${blocking.length === 1 ? 'has' : 'have'} an unknown outcome. ` +
          'Inspect the unresolved activity and mark it reviewed before new writes. No changes were made.',
      )
    }
  }

  private async handleRequest(req: ToolCallRequest, approved: boolean): Promise<unknown> {
    const classification = classifyToolCall(req.tool, req.args)
    if (!classification.mutates) {
      const result = await this.deps.callTool(req.tool, req.args, req.signal)
      const pageId = req.tool === 'notion-fetch' ? firstString(req.args.id) ?? firstString(req.args.page_id) : undefined
      if (pageId) {
        // A tool-declared failure establishes no baseline and no evidence.
        if (result?.isError === true) return result
        // Only a successful, complete read establishes inspection evidence
        // and an edit baseline. Partial reads are remembered as partial
        // (analysis only); unrecognized payloads establish nothing.
        let complete = false
        try {
          complete = normalizePageFetch(pageId, result).status === 'complete'
        } catch {
          complete = false
        }
        await this.rememberNormalizedRead(pageId, result)
        if (!complete) return result
      }
      // Successful retrievals feed the plan-evidence ledger; a recording
      // failure must never fail the read itself.
      try {
        recordRetrievals(this.journal.captureScope().threadId, extractRetrievalIds(req.tool, req.args, result))
      } catch {
        // Evidence tracking is best-effort; the read already succeeded.
      }
      return result
    }

    // Proposal validation precedes everything else: malformed proposals and
    // unsupported effects never reach approval UI or transport.
    let effect: ValidatedEffect
    try {
      effect = validateEffect(req.tool, req.args)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e))
    }

    // Owner admission precedes approval UI: viewers fail fast with zero
    // transport and no pending cards. Scope is captured synchronously here
    // so a later thread switch cannot reassign the operation.
    let snapshot: OwnershipSnapshot
    let scope: IntentScope
    try {
      if (this.undoActive) {
        throw new MutationRejectedError('UNDO_IN_PROGRESS', 'an undo is running — wait for it to finish before writing. No changes were made.')
      }
      snapshot = this.admitMutation(req.signal)
      scope = this.captureIntentScope(snapshot)
      await this.requireNoConflict(scope.threadId)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e))
    }

    // Content writes need a successful, complete, in-scope read baseline the
    // model actually observed. This runs before any approval card: without a
    // baseline there is nothing to consent to. Guard-only reads never
    // populate baselines, and a missing baseline (fresh resume, reconnect,
    // scope change) forces a re-fetch instead of blessing two matching guard
    // reads against a stale proposal. The frozen hash binds the later
    // approval and dispatch to the observed state.
    let baselineHash: string | null = null
    if (effect.needsBaseline) {
      const target = effect.targets[0]
      const baseline = target ? this.currentBaseline(target) : null
      if (!baseline) {
        return textResult(
          'BASELINE_REQUIRED: Nox has no complete read of this page in the current conversation — ' +
            'fetch it with notion-fetch and inspect the result before replacing its content. No changes were made.',
        )
      }
      if (baseline.status !== 'complete') {
        return textResult(
          'PARTIAL_BASELINE: the available read of this page is incomplete (truncated content) — ' +
            'fetch the returned omitted block ids or a targeted subtree before replacing its content. ' +
            'A partial read cannot support whole-page replacement. No changes were made.',
        )
      }
      baselineHash = baseline.hash
    }

    const needsWorkspacePlan = requiresWorkspacePlan(classification, req.tool, effect.args) &&
      // A single-page move uses ordinary action approval (which it always
      // needs); broad moves still require a plan.
      !(classification.kind === 'move' && effect.count === 1)
    // Plan-covered operations skip only redundant ordinary consent: every
    // other check still runs, and the reservation is revalidated before
    // dispatch and consumed at dispatch, whatever the outcome.
    const planScope: PlanScope = {
      workspaceId: scope.workspaceId,
      connectionGeneration: scope.connectionGeneration,
      threadId: scope.threadId,
      turnId: scope.turnId,
    }
    let reservationId: string | undefined
    if (needsWorkspacePlan) {
      const authorization = this.deps.authorizeStructuralChange?.(effect, planScope)
      if (!authorization?.allowed) {
        return textResult(authorization?.reason ?? 'PLAN_REQUIRED: structural workspace changes require an approved plan.')
      }
      reservationId = authorization.reservationId
    }

    const mode = this.deps.getMode()
    // Plan-covered operations skip only redundant ordinary consent: the plan
    // card was the consent step, and every other check still runs below.
    let frozenArgs = effect.args
    let grantPath = false
    if (reservationId === undefined) {
      const approvalCall = {
        ...classification,
        name: req.tool,
        args: effect.args,
        provenance: req.provenance,
        targets: effect.targets,
        parents: effect.parents,
        affectedCount: effect.count,
        grant: this.deps.getSmallEditGrant?.() ?? { allowed: false, pages: [] },
      }
      const verdict = evaluateApproval(approvalCall, {
        mode,
        contextSet: this.deps.getContextSet(),
      })
      if (verdict.action === 'refuse') {
        return textResult(`REFUSED: ${verdict.reasons.join('; ')}. No changes were made.`)
      }
      // The frozen consent payload: approval displays effect.args and resolves
      // the same snapshot for dispatch, so later edits of the request object
      // cannot change what runs.
      if (verdict.action === 'require-approval' && !approved) {
        const decision = await this.approvals.request(approvalCall, verdict)
        if (!decision.approved) {
          return textResult('REJECTED_BY_USER: the user declined this change. Do not retry it without asking.')
        }
        frozenArgs = decision.frozenArgs
      } else {
        // Silent only via the explicit grant path (Auto); Ask never allows.
        grantPath = verdict.action === 'allow'
      }
    }

    return this.runExclusive(async () => {
      try {
        this.reassertMutation(snapshot, req.signal)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e))
    }

      if (reservationId !== undefined && this.deps.checkPlanReservation && !this.deps.checkPlanReservation(reservationId, planScope)) {
        return textResult('PLAN_MISMATCH: the approved operation is no longer valid for this turn — request a fresh review. No changes were made.')
      }
      if (grantPath) {
        // Reserve the unplanned-effect budget synchronously before dispatch,
        // counted by objects. Past the cap, demand a workspace plan first.
        // Reservations are never released — not even after ambiguous dispatch.
        const reserved = this.deps.recordUnplannedEffects?.(effect.count) ?? true
        if (!reserved) {
          return textResult('PLAN_REQUIRED: this turn already used its five unplanned small edits — propose a workspace plan for the remaining work. No changes were made.')
        }
      }
      return this.executeMutation(req, classification, scope, effect, frozenArgs, reservationId, baselineHash)
    })
  }

  /**
   * Final guard → durable intent → dispatch → settle. Runs only inside the
   * serial runner; no IndexedDB transaction is held across the network await.
   * The intent (with frozen args and pre-image) is persisted before dispatch;
   * a storage failure there returns a storage error with zero external calls.
   * A final guard recheck runs after intent persistence and immediately
   * before dispatch, so admission delay cannot silently stale the write.
   * Guard reads share the scheduler with dispatch but never hold its slot
   * across each other: every read completes before dispatch is invoked.
   */
  private async executeMutation(req: ToolCallRequest, classification: CallClassification, scope: IntentScope, effect: ValidatedEffect, frozenArgs: Record<string, unknown>, reservationId: string | undefined, baselineHash: string | null): Promise<unknown> {
    const guard = await this.runGuardPhase(req, classification, contentTarget(effect), baselineHash)
    if (!guard.ok) return guard.result

    let intent: JournalEntry
    try {
      intent = await this.journal.beginIntent({
        tool: req.tool,
        args: frozenArgs,
        kind: classification.kind,
        scope,
        preImage: guard.preImage,
        targetPageId: effect.targets[0],
        callId: req.callId,
      })
    } catch (e) {
      return textResult(`JOURNAL_STORAGE_ERROR: the recovery record could not be persisted (${e instanceof Error ? e.message : String(e)}). No changes were made.`)
    }
    this.activeIntentIds.add(intent.id)
    try {
      try {
        req.signal?.throwIfAborted()
      } catch {
        await this.settleProtected(intent.id, { status: 'failed', outcomeDetail: 'cancelled before dispatch' })
        return textResult('TURN_CANCELLED: the turn was cancelled before dispatch. No changes were made.')
      }

      // Final recheck immediately before dispatch: the intent is durable,
      // but the page may have changed while approval or intent persistence
      // was in flight. A mismatch settles known failure (nothing was
      // dispatched) and demands fresh review — the approved content was
      // based on an older state. This check runs with no awaits between it
      // and dispatch besides the settle on failure.
      if (guard.snapshot) {
        let finalHash: string
        try {
          const final = await capturePageSnapshot((id) => this.deps.fetchPageMarkdown(id, req.signal), guard.snapshot.pageId)
          requireCompleteBaseline(final.record)
          finalHash = final.hash
        } catch (e) {
          const detail = e instanceof BaselineError || e instanceof GuardViolation ? e.message : `could not re-read the page (${e instanceof Error ? e.message : String(e)})`
          await this.settleProtected(intent.id, { status: 'failed', outcomeDetail: detail })
          return textResult(`${detail} Write aborted before dispatch.`)
        }
        if (finalHash !== guard.snapshot.hash) {
          await this.settleProtected(intent.id, { status: 'failed', outcomeDetail: 'page changed between guard and dispatch' })
          return textResult(
            'PAGE_CHANGED_SINCE_READ: this page was edited in Notion after Nox read it — ' +
              'the approved change was based on an older state. Re-read the page and request a fresh review. No changes were made.',
          )
        }
      }

      let result: unknown
      try {
        result = await this.deps.callTool(req.tool, frozenArgs, req.signal)
      } catch (e) {
        const [status, detail] = classifyDispatchOutcome(e)
        await this.settleProtected(intent.id, { status, outcomeDetail: detail })
        if (status === 'unknown' && effect.targets[0]) this.retireBaseline(effect.targets[0])
        this.consumeReservation(reservationId)
        throw e
      }
      if (isToolError(result)) {
        const detail = textOfResult(result)
        await this.settleProtected(intent.id, { status: 'failed', outcomeDetail: detail || 'the provider reported the change as failed' })
        this.consumeReservation(reservationId)
        return result
      }
      if (guard.preImage.pageId) this.retireBaseline(guard.preImage.pageId)

      // Record applied immediately after the confirmed response, before
      // optional verification reads. A success-record failure keeps the
      // pending row and surfaces a session-visible recovery warning.
      try {
        await this.journal.settleIntent(intent.id, { status: 'applied' })
      } catch (e) {
        console.error('[nox] write succeeded but journal persistence failed', e)
        throw appliedRecoveryWarning(result)
      }

      const inverse = buildInverse(guard.preImage)
      if (inverse.kind === 'execute-tool' && guard.preImage.pageId) {
        try {
          const postWrite = await capturePageSnapshot((id) => this.deps.fetchPageMarkdown(id, req.signal), guard.preImage.pageId)
          const command = frozenArgs.command as Record<string, unknown> | undefined
          const intendedContent = command?.type === 'replace_content' && typeof command.content === 'string' ? command.content : null
          if (intendedContent == null || postWrite.hash !== await hashMarkdown(intendedContent)) {
            throw new Error('post-write state cannot be attributed safely')
          }
          inverse.args = { ...inverse.args, __nox_expected_hash: postWrite.hash }
        } catch {
          inverse.kind = 'not-undoable'
          inverse.reason = 'the page could not be verified after the change'
          inverse.tool = undefined
          inverse.args = undefined
        }
      }

      try {
        await this.journal.settleIntent(intent.id, {
          status: 'applied',
          inverse: inverse.kind === 'execute-tool' ? { tool: inverse.tool!, args: inverse.args! } : undefined,
          notUndoableReason: inverse.kind === 'not-undoable' ? inverse.reason : undefined,
        })
      } catch (e) {
        console.error('[nox] write succeeded but inverse persistence failed', e)
        throw appliedRecoveryWarning(result)
      }
      this.consumeReservation(reservationId, resultTextOf(result))
      return result
    } finally {
      this.activeIntentIds.delete(intent.id)
    }
  }

  /** Consume a plan reservation at dispatch, whatever the outcome. Never throws. */
  private consumeReservation(reservationId: string | undefined, resultText?: string): void {
    if (reservationId === undefined) return
    try {
      this.deps.consumePlanReservation?.(reservationId, resultText)
    } catch (e) {
      console.error('[nox] plan reservation bookkeeping failed', e)
    }
  }

  /** Settle an intent without letting bookkeeping failures mask the outcome. */
  private async settleProtected(id: string, update: { status: 'applied' | 'failed' | 'unknown'; outcomeDetail?: string }): Promise<void> {
    try {
      await this.journal.settleIntent(id, update)
    } catch (e) {
      console.error('[nox] intent outcome bookkeeping failed', e)
    }
  }

  /**
   * Pre-image + guard for content writes; snapshot config/properties/moves
   * otherwise. Reads only — no intent needed and no dispatch happens here.
   * The guarded page comes from the validated effect for forward writes, or
   * from trusted journal-sourced shapes for undo. `baselineHash` is the
   * frozen model-observed baseline the approval was bound to; a mismatch
   * means the approved content was based on an older state.
   */
  private async runGuardPhase(
    req: ToolCallRequest,
    classification: CallClassification,
    pageId: string | undefined,
    baselineHash: string | null = null,
  ): Promise<{ ok: true; snapshot: PageSnapshot | null; preImage: PreImage } | { ok: false; result: unknown }> {
    let snapshot: PageSnapshot | null = null
    let preImage: PreImage = { kind: classification.kind }
    try {
      if (CONTENT_WRITE_KINDS.has(classification.kind)) {
        if (pageId) {
          const fetchPage = (id: string) => this.deps.fetchPageMarkdown(id, req.signal)
          snapshot = await capturePageSnapshot(fetchPage, pageId)
          // Only complete reads can anchor a replacement or an inverse.
          // Partial reads stay usable for analysis elsewhere; here they
          // refuse with a targeted re-fetch path.
          requireCompleteBaseline(snapshot.record)
          const undoExpectedHash = firstString(req.args.__nox_expected_hash)
          if (undoExpectedHash && undoExpectedHash !== snapshot.hash) {
            throw new GuardViolation('PAGE_CHANGED_AFTER_NOX_WRITE: this page changed after Nox edited it. Undo was refused to protect the newer edits.')
          }
          if (baselineHash != null && baselineHash !== snapshot.hash) {
            throw new GuardViolation(
              'PAGE_CHANGED_SINCE_READ: this page was edited in Notion after Nox read it — ' +
                'the approved change was based on an older state. Re-read the page and request a fresh review. No changes were made.',
            )
          }
          preImage = {
            kind: classification.kind,
            pageId,
            markdown: snapshot.markdown,
            richPage: detectRichPage(snapshot.markdown),
            baselineComplete: true,
          }
        }
        if (snapshot) {
          await assertUnchanged((id) => this.deps.fetchPageMarkdown(id, req.signal), snapshot)
        }
      }
    } catch (e) {
      if (e instanceof GuardViolation || e instanceof BaselineError) return { ok: false, result: textResult(e.message) }
      // Snapshot failure must not block the write silently — say so.
      return { ok: false, result: textResult(`ERROR: could not capture a pre-image (${e instanceof Error ? e.message : e}). Write aborted.`) }
    }
    return { ok: true, snapshot, preImage }
  }
}

function isToolError(result: unknown): boolean {
  return typeof result === 'object' && result != null && (result as { isError?: unknown }).isError === true
}

function textResult(text: string): unknown {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

function firstString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Object ids a successful read establishes as inspected evidence. */
function extractRetrievalIds(
  tool: string,
  args: Record<string, unknown>,
  result: { content: Array<{ type: string; text?: string }> },
): string[] {
  if (tool === 'notion-fetch') {
    const id = firstString(args.id) ?? firstString(args.page_id)
    return id ? [id] : []
  }
  if (tool === 'notion-search') {
    try {
      const text = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const results = (parsed as Record<string, unknown>).results
      if (!Array.isArray(results)) return []
      const ids: string[] = []
      for (const entry of results) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const id = (entry as Record<string, unknown>).id
          if (typeof id === 'string' && id) ids.push(id)
        }
      }
      return ids
    } catch {
      return []
    }
  }
  return []
}

/** Guarded page for content writes from a validated effect. */
function contentTarget(effect: ValidatedEffect): string | undefined {
  if (effect.kind !== 'content-replace' && effect.kind !== 'content-update') return undefined
  return effect.targets[0]
}

/**
 * Guarded page from journal-sourced inverse shapes. Trusted internal input
 * only — model proposals go through effect adapters instead.
 */
function trustedPageId(args: Record<string, unknown>): string | undefined {
  return firstString(args.page_id) ?? firstString((args.data as Record<string, unknown> | undefined)?.page_id)
}

function stripReservedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { injected_request, __nox_expected_hash, ...rest } = args
  void injected_request
  void __nox_expected_hash
  return rest
}

function isErrorResult(result: unknown): result is { isError: true; content: Array<{ text?: string }> } {
  return typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
}

function textOfResult(result: unknown): string {
  if (isErrorResult(result)) return result.content.map((part) => part.text ?? '').join('\n')
  return 'unknown guard outcome'
}

function resultTextOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content.filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

/**
 * Outcome for a thrown dispatch failure. Pre-dispatch proof settles known
 * failure; the safe default after dispatch is unknown — no contract here
 * proves non-execution, including for thrown provider rejections.
 */
function classifyDispatchOutcome(e: unknown): ['unknown' | 'failed', string | undefined] {
  const detail = e instanceof Error ? e.message : String(e)
  if (isPreDispatchFailure(e)) return ['failed', `not dispatched: ${detail}`]
  if (e instanceof UncertainDispatchError) return ['unknown', detail]
  if (isAbortError(e)) return ['unknown', `cancelled after dispatch was attempted: ${detail}`]
  return ['unknown', detail]
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * Session-visible warning for a confirmed effect whose durable record could
 * not be updated. The older pending row remains recoverable on restart, and
 * the provider result travels in the message so the turn can still use it.
 */
function appliedRecoveryWarning(result: unknown): Error {
  const text = isErrorResult(result)
    ? result.content.map((part) => part.text ?? '').join('\n')
    : typeof result === 'object' && result !== null
      ? JSON.stringify(result).slice(0, 2000)
      : String(result ?? '')
  return new Error(
    'APPLIED_WITH_RECOVERY_WARNING: the change was applied but the local recovery record could not be updated — ' +
      'reopening Nox will show it as unresolved. Do not assume undo is available. ' +
      (text ? `Provider result was: ${text.slice(0, 2000)}` : 'No provider result text was returned.'),
  )
}

/** Exact intended post-content for a replace_content operation, if knowable. */
function intendedReplaceContent(entry: JournalEntry): { pageId: string; content: string } | null {
  if (!entry.targetPageId) return null
  const command = (entry.args as Record<string, unknown> | undefined)?.command as Record<string, unknown> | undefined
  if (command?.type !== 'replace_content' || typeof command.content !== 'string') return null
  return { pageId: entry.targetPageId, content: command.content }
}
