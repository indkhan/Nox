import type { ToolCallRequest } from '../codex/client'
import { classifyToolCall, detectRichPage } from './classify'
import { buildInverse, type PreImage } from './inverse'
import { capturePageSnapshot, assertUnchanged, GuardViolation, type PageSnapshot } from './guard'
import { ApprovalEngine, evaluateApproval, type Mode } from './approvals'
import { MutationJournal } from './journal'

export interface WriteGateDeps {
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>
  fetchPageMarkdown: (pageId: string) => Promise<string>
  getMode: () => Mode
  getContextSet: () => Set<string>
  journal?: MutationJournal
  onApproval?: ApprovalEngine['notify']
}

const CONTENT_WRITE_KINDS = new Set(['content-replace', 'content-update'])

/**
 * The full mutation chain (docs/plans/E6.md): classify → approve → guard →
 * execute → journal. Reads pass straight through.
 */
export class WriteGate {
  readonly approvals: ApprovalEngine
  readonly journal: MutationJournal

  constructor(private readonly deps: WriteGateDeps) {
    this.journal = deps.journal ?? new MutationJournal()
    this.approvals = new ApprovalEngine(deps.onApproval)
  }

  beginTurn(): void {
    this.approvals.beginTurn()
  }

  async handle(req: ToolCallRequest): Promise<unknown> {
    const classification = classifyToolCall(req.tool, req.args)
    if (!classification.mutates) {
      return await this.deps.callTool(req.tool, req.args)
    }

    const verdict = evaluateApproval({ ...classification, name: req.tool, args: req.args }, {
      mode: this.deps.getMode(),
      contextSet: this.deps.getContextSet(),
    })
    if (verdict.action === 'refuse') {
      return textResult(`REFUSED: ${verdict.reasons.join('; ')}. No changes were made.`)
    }
    if (verdict.action === 'require-approval') {
      const approved = await this.approvals.request({ ...classification, name: req.tool, args: req.args }, verdict)
      if (!approved) {
        return textResult('REJECTED_BY_USER: the user declined this change. Do not retry it without asking.')
      }
    }

    // Pre-image + guard for content writes; snapshot config/properties/moves otherwise.
    let snapshot: PageSnapshot | null = null
    let preImage: PreImage = { kind: classification.kind }
    try {
      if (CONTENT_WRITE_KINDS.has(classification.kind)) {
        const pageId = firstString(req.args.page_id) ?? firstString((req.args.data as Record<string, unknown> | undefined)?.page_id)
        if (pageId) {
          snapshot = await capturePageSnapshot(this.deps.fetchPageMarkdown, pageId)
          preImage = {
            kind: classification.kind,
            pageId,
            markdown: snapshot.markdown,
            richPage: detectRichPage(snapshot.markdown),
          }
        }
        if (snapshot && !this.isUndoRequest(req)) {
          await assertUnchanged(this.deps.fetchPageMarkdown, snapshot)
        }
      }
    } catch (e) {
      if (e instanceof GuardViolation) return textResult(e.message)
      // Snapshot failure must not block the write silently — say so.
      return textResult(`ERROR: could not capture a pre-image (${e instanceof Error ? e.message : e}). Write aborted.`)
    }

    const result = await this.deps.callTool(req.tool, stripReservedArgs(req.args))
    const inverse = buildInverse(req.tool, req.args, preImage)

    await this.journal.record({
      tool: req.tool,
      args: stripReservedArgs(req.args),
      kind: classification.kind,
      preImage: snapshot ? { hash: snapshot.hash, markdownChars: snapshot.markdown.length } : undefined,
      inverse: inverse.kind === 'execute-tool' ? { tool: inverse.tool!, args: inverse.args! } : undefined,
      notUndoableReason: inverse.kind === 'not-undoable' ? inverse.reason : undefined,
      targetPageId: preImage.pageId,
    })

    return result
  }

  private isUndoRequest(_req: ToolCallRequest): boolean {
    // Reserved for E7 bulk undo flows that bypass the guard deliberately.
    return false
  }
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
  const { injected_request, ...rest } = args
  void injected_request
  return rest
}
