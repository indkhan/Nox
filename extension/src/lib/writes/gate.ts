import type { ToolCallRequest } from '../codex/client'
import { classifyToolCall, detectRichPage } from './classify'
import { buildInverse, type PreImage } from './inverse'
import { capturePageSnapshot, assertUnchanged, GuardViolation, type PageSnapshot } from './guard'
import { ApprovalEngine, evaluateApproval, type Mode } from './approvals'
import { MutationJournal } from './journal'
import { hashMarkdown } from './guard'
import { normalizeId } from '../../shared/notion-page'

export interface WriteGateDeps {
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }> }>
  fetchPageMarkdown: (pageId: string, signal?: AbortSignal) => Promise<string>
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
  private readonly readHashes = new Map<string, string>()

  constructor(private readonly deps: WriteGateDeps) {
    this.journal = deps.journal ?? new MutationJournal()
    this.approvals = new ApprovalEngine(deps.onApproval)
  }

  beginTurn(): void {
    this.approvals.beginTurn()
  }

  async rememberPageRead(pageId: string, markdown: string): Promise<void> {
    this.readHashes.set(normalizeId(pageId) ?? pageId, await hashMarkdown(markdown))
  }

  async handle(req: ToolCallRequest): Promise<unknown> {
    return this.handleRequest(req, false, true)
  }

  async handleUndo(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.handleRequest({ rid: 0, tool, args, namespace: null, provenance: 'user-only' }, true, false)
    if (isErrorResult(result)) throw new Error(result.content.map((part) => part.text ?? '').join('\n'))
    return result
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

    const verdict = evaluateApproval({ ...classification, name: req.tool, args: req.args, provenance: req.provenance }, {
      mode: this.deps.getMode(),
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

    // Pre-image + guard for content writes; snapshot config/properties/moves otherwise.
    let snapshot: PageSnapshot | null = null
    let preImage: PreImage = { kind: classification.kind }
    try {
      if (CONTENT_WRITE_KINDS.has(classification.kind)) {
        const pageId = firstString(req.args.page_id) ?? firstString((req.args.data as Record<string, unknown> | undefined)?.page_id)
        if (pageId) {
          const fetchPage = (id: string) => this.deps.fetchPageMarkdown(id, req.signal)
          snapshot = await capturePageSnapshot(fetchPage, pageId)
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
        if (snapshot && !this.isUndoRequest(req)) {
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
    const inverse = buildInverse(req.tool, req.args, preImage)

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

  private isUndoRequest(_req: ToolCallRequest): boolean {
    // Reserved for E7 bulk undo flows that bypass the guard deliberately.
    return false
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
  const { injected_request, ...rest } = args
  void injected_request
  return rest
}

function isErrorResult(result: unknown): result is { isError: true; content: Array<{ text?: string }> } {
  return typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
}
