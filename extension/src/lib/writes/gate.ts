import type { ToolCallRequest } from '../codex/client'
import { classifyToolCall, detectRichPage, requiresWorkspacePlan, type CallClassification } from './classify'
import { buildInverse, type PreImage } from './inverse'
import { capturePageSnapshot, assertUnchanged, GuardViolation, type PageSnapshot } from './guard'
import { ApprovalEngine, evaluateApproval, type Mode } from './approvals'
import { MutationJournal } from './journal'
import { hashMarkdown } from './guard'
import { normalizeId } from '../../shared/notion-page'

export type MutationRejectionCode =
  | 'NOT_OWNER'
  | 'LEASE_EXPIRED'
  | 'CONNECTION_CHANGED'
  | 'TURN_ACTIVE'
  | 'UNDO_IN_PROGRESS'
  | 'NOT_UNDOABLE'

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

export interface WriteGateDeps {
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }> }>
  fetchPageMarkdown: (pageId: string, signal?: AbortSignal) => Promise<string>
  getMode: () => Mode
  getContextSet: () => Set<string>
  journal?: MutationJournal
  onApproval?: ApprovalEngine['notify']
  authorizeStructuralChange?: (name: string, args: Record<string, unknown>) => { allowed: boolean; reason?: string }
  ownership?: MutationOwnership
}

const CONTENT_WRITE_KINDS = new Set(['content-replace', 'content-update'])

/**
 * The full mutation chain (docs/plans/E6.md): classify → approve → guard →
 * execute → journal. Reads pass straight through.
 */
export class WriteGate {
  readonly approvals: ApprovalEngine
  readonly journal: MutationJournal
  private readonly readHashes = new Map<string, string>()
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

  constructor(private readonly deps: WriteGateDeps) {
    this.journal = deps.journal ?? new MutationJournal()
    this.approvals = new ApprovalEngine(deps.onApproval)
  }

  beginTurn(): void {
    this.approvals.beginTurn()
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

  async rememberPageRead(pageId: string, markdown: string): Promise<void> {
    this.readHashes.set(normalizeId(pageId) ?? pageId, await hashMarkdown(markdown))
  }

  async handle(req: ToolCallRequest): Promise<unknown> {
    return this.handleRequest(req, false, true)
  }

  /**
   * Undo entry through the same ownership + serial boundary as forward
   * writes. Rejects while a turn is active (never queues for later) and
   * re-validates the journal entry from storage inside the exclusive section
   * so a restored row cannot authorize a stale or repeated undo.
   */
  async handleUndo(tool: string, args: Record<string, unknown>, opts: { journalId?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const snapshot = this.admitMutation(opts.signal)
    if (this.turnActive) {
      throw new MutationRejectedError('TURN_ACTIVE', 'Nox is working — wait for the turn to finish before undoing. No changes were made.')
    }
    return this.runExclusive(async () => {
      this.reassertMutation(snapshot, opts.signal)
      if (this.turnActive) {
        throw new MutationRejectedError('TURN_ACTIVE', 'a turn started while this undo was queued — the undo was refused. No changes were made.')
      }
      if (opts.journalId) await this.revalidateUndoEntry(opts.journalId, tool, args)
      this.undoActive = true
      try {
        const result = await this.executeMutation(
          { rid: 0, tool, args, namespace: null, provenance: 'user-only', signal: opts.signal },
          classifyToolCall(tool, args),
          false,
        )
        if (isErrorResult(result)) throw new Error(result.content.map((part) => part.text ?? '').join('\n'))
        if (opts.journalId) {
          try {
            await this.journal.setStatus(opts.journalId, 'undone')
          } catch (e) {
            console.error('[nox] undo applied but journal status update failed', e)
          }
        }
        return result
      } finally {
        this.undoActive = false
      }
    })
  }

  /**
   * Shared serial boundary for external effects that do not flow through
   * handle() (currently the upload ticket + byte upload). Enforces the same
   * owner lease and undo exclusion as forward writes.
   */
  async runEffectExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.undoActive) {
      throw new MutationRejectedError('UNDO_IN_PROGRESS', 'an undo is running — wait for it to finish. No changes were made.')
    }
    const snapshot = this.admitMutation(signal)
    return this.runExclusive(async () => {
      this.reassertMutation(snapshot, signal)
      return fn()
    })
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
  private async revalidateUndoEntry(journalId: string, tool: string, args: Record<string, unknown>): Promise<void> {
    const entries = await this.journal.newestFirst()
    const entry = entries.find((candidate) => candidate.id === journalId)
    if (!entry || entry.status !== 'applied' || !entry.inverse) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'this change is no longer available to undo.')
    }
    if (entry.inverse.tool !== tool || JSON.stringify(entry.inverse.args) !== JSON.stringify(args)) {
      throw new MutationRejectedError('NOT_UNDOABLE', 'the stored undo no longer matches this change. No changes were made.')
    }
  }

  private async handleRequest(req: ToolCallRequest, approved: boolean, record: boolean): Promise<unknown> {
    const classification = classifyToolCall(req.tool, req.args)
    if (!classification.mutates) {
      const result = await this.deps.callTool(req.tool, req.args, req.signal)
      const pageId = req.tool === 'notion-fetch' ? firstString(req.args.id) ?? firstString(req.args.page_id) : undefined
      if (pageId) {
        const markdown = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
        await this.rememberPageRead(pageId, markdown)
      }
      return result
    }

    // Owner admission precedes approval UI: viewers fail fast with zero
    // transport and no pending cards.
    let snapshot: OwnershipSnapshot
    try {
      if (this.undoActive) {
        throw new MutationRejectedError('UNDO_IN_PROGRESS', 'an undo is running — wait for it to finish before writing. No changes were made.')
      }
      snapshot = this.admitMutation(req.signal)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e))
    }

    const needsWorkspacePlan = requiresWorkspacePlan(classification, req.args)
    if (needsWorkspacePlan) {
      const authorization = this.deps.authorizeStructuralChange?.(req.tool, req.args)
      if (!authorization?.allowed) {
        return textResult(authorization?.reason ?? 'PLAN_REQUIRED: structural workspace changes require an approved plan.')
      }
    }

    const mode = this.deps.getMode()
    const verdict = needsWorkspacePlan && mode === 'auto'
      ? { action: 'allow' as const }
      : evaluateApproval({ ...classification, name: req.tool, args: req.args, provenance: req.provenance }, {
          mode,
          contextSet: this.deps.getContextSet(),
        })
    if (verdict.action === 'refuse') {
      return textResult(`REFUSED: ${verdict.reasons.join('; ')}. No changes were made.`)
    }
    if (verdict.action === 'require-approval' && !approved) {
      const approved = await this.approvals.request({ ...classification, name: req.tool, args: req.args }, verdict)
      if (!approved) {
        return textResult('REJECTED_BY_USER: the user declined this change. Do not retry it without asking.')
      }
    }

    return this.runExclusive(async () => {
      try {
        this.reassertMutation(snapshot, req.signal)
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e))
      }
      return this.executeMutation(req, classification, record)
    })
  }

  /**
   * Final guard → dispatch → journal update. Runs only inside the serial
   * runner; no IndexedDB transaction is held across the network await.
   */
  private async executeMutation(req: ToolCallRequest, classification: CallClassification, record: boolean): Promise<unknown> {
    // Pre-image + guard for content writes; snapshot config/properties/moves otherwise.
    let snapshot: PageSnapshot | null = null
    let preImage: PreImage = { kind: classification.kind }
    try {
      if (CONTENT_WRITE_KINDS.has(classification.kind)) {
        const pageId = firstString(req.args.page_id) ?? firstString((req.args.data as Record<string, unknown> | undefined)?.page_id)
        if (pageId) {
          const fetchPage = (id: string) => this.deps.fetchPageMarkdown(id, req.signal)
          snapshot = await capturePageSnapshot(fetchPage, pageId)
          const undoExpectedHash = firstString(req.args.__nox_expected_hash)
          if (undoExpectedHash && undoExpectedHash !== snapshot.hash) {
            throw new GuardViolation('PAGE_CHANGED_AFTER_NOX_WRITE: this page changed after Nox edited it. Undo was refused to protect the newer edits.')
          }
          const expectedHash = this.readHashes.get(normalizeId(pageId) ?? pageId)
          if (expectedHash && expectedHash !== snapshot.hash) {
            throw new GuardViolation(
              'PAGE_CHANGED_SINCE_READ: this page was edited in Notion after Nox read it. Re-read the page and try again — refusing to overwrite the newer edits.',
            )
          }
          preImage = {
            kind: classification.kind,
            pageId,
            markdown: snapshot.markdown,
            richPage: detectRichPage(snapshot.markdown),
          }
        }
        if (snapshot) {
          await assertUnchanged((id) => this.deps.fetchPageMarkdown(id, req.signal), snapshot)
        }
      }
    } catch (e) {
      if (e instanceof GuardViolation) return textResult(e.message)
      // Snapshot failure must not block the write silently — say so.
      return textResult(`ERROR: could not capture a pre-image (${e instanceof Error ? e.message : e}). Write aborted.`)
    }

    const result = await this.deps.callTool(req.tool, stripReservedArgs(req.args), req.signal)
    if (isToolError(result)) return result
    if (preImage.pageId) this.readHashes.delete(normalizeId(preImage.pageId) ?? preImage.pageId)
    const inverse = buildInverse(preImage)
    if (inverse.kind === 'execute-tool' && preImage.pageId) {
      try {
        const postWrite = await capturePageSnapshot((id) => this.deps.fetchPageMarkdown(id, req.signal), preImage.pageId)
        const command = req.args.command as Record<string, unknown> | undefined
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
      if (!record) return result
      await this.journal.record({
        tool: req.tool,
        args: stripReservedArgs(req.args),
        kind: classification.kind,
        preImage: snapshot ? { hash: snapshot.hash, markdownChars: snapshot.markdown.length } : undefined,
        inverse: inverse.kind === 'execute-tool' ? { tool: inverse.tool!, args: inverse.args! } : undefined,
        notUndoableReason: inverse.kind === 'not-undoable' ? inverse.reason : undefined,
        targetPageId: preImage.pageId,
        callId: req.callId,
      })
    } catch (e) {
      console.error('[nox] write succeeded but journal persistence failed', e)
    }

    return result
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

function stripReservedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { injected_request, __nox_expected_hash, ...rest } = args
  void injected_request
  void __nox_expected_hash
  return rest
}

function isErrorResult(result: unknown): result is { isError: true; content: Array<{ text?: string }> } {
  return typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
}
