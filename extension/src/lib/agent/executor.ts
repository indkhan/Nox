import type { ToolCallRequest } from '../codex/client'
import { wrapUntrusted } from './untrusted'
import { truncateResult } from './context'

export const DEFAULT_STEP_LIMIT = 12
export const DEFAULT_RESULT_BUDGET_CHARS = 24_000

export interface ExecutorDeps {
  /** Runs one tool call through the scheduler (the Notion facade). */
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal, provenance?: ToolCallRequest['provenance']) => Promise<{ content: Array<{ type: string; text?: string }> }>
  /** Throws when the tool is plan-gated. */
  assertToolAllowed: (name: string) => void
  /**
   * Reports local truncation before Codex (Epoch F2 / R2). The provider
   * fetch may be complete, but only `deliveredChars` of `totalChars`
   * reached model context — the gate must downgrade that page to
   * model-partial so replacement refuses before approval.
   */
  onModelTruncation?: (pageId: string, deliveredChars: number, totalChars: number) => void
  /**
   * Reports continuation delivery (Epoch F2 / R2). Only actual reads count:
   * possession of a handle never completes a baseline by itself.
   */
  onModelDelivery?: (pageId: string, offset: number, end: number, totalChars: number) => void
}

export interface ToolOutcome {
  success: boolean
  contentItems: Array<{ type: 'inputText'; text: string }>
  /** Sanitized, unwrapped text for local UI rendering only. */
  displayText?: string
}

/**
 * Executes Codex's item/tool/call requests against Notion.
 * Errors become model-readable results — a failing tool never crashes the turn.
 */
export class ToolExecutor {
  private continuations = new Map<string, { text: string; source: string; pageId?: string }>()
  private storedChars = 0
  private stepsUsed = 0
  private signal: AbortSignal | undefined

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly opts: { stepLimit?: number; resultBudgetChars?: number; onJournalEvent?: (e: JournalEvent) => void } = {},
  ) {}

  beginTurn(signal?: AbortSignal): void {
    this.continuations.clear()
    this.storedChars = 0
    this.stepsUsed = 0
    this.signal = signal
  }

  endTurn(): void {
    this.continuations.clear()
    this.storedChars = 0
  }

  excerpt(text: string, budget: number, source = 'notion-fetch', pageId?: string): string {
    if (text.length <= budget) return text
    const delivered = Math.min(budget, text.length)
    // Bound ephemeral memory across every result in this turn. No handle is
    // stored, so continuation can never complete this delivery (F2.3).
    if (this.storedChars + text.length > 1_000_000) {
      if (pageId) this.deps.onModelTruncation?.(pageId, delivered, text.length)
      return truncateResult(text, budget) + '\nCONTINUATION_UNAVAILABLE: turn memory limit. Retrieve a targeted subtree or state the missing scope.'
    }
    const handle = crypto.randomUUID()
    this.continuations.set(handle, { text, source, pageId })
    this.storedChars += text.length
    if (pageId) this.deps.onModelTruncation?.(pageId, delivered, text.length)
    return text.slice(0, budget) + `\n<continuation handle="${handle}" offset="${budget}" total_chars="${text.length}" tool="nox-read-continuation"/>`
  }

  private continuation(args: Record<string, unknown>): string {
    const value = typeof args.handle === 'string' ? this.continuations.get(args.handle) : undefined
    if (!value) throw new Error('CONTINUATION_UNAVAILABLE: handle expired or unknown; fetch the source again.')
    this.deps.assertToolAllowed(value.source)
    const offset = args.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > value.text.length) throw new Error('INVALID_OFFSET')
    const end = Math.min(offset + (this.opts.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS), value.text.length)
    if (value.pageId) this.deps.onModelDelivery?.(value.pageId, offset, end, value.text.length)
    return value.text.slice(offset, end) + `\n<continuation offset="${end}" total_chars="${value.text.length}"/>\n` + (end === value.text.length ? 'END_OF_RESULT' : 'MORE_AVAILABLE')
  }

  get stepsTaken(): number {
    return this.stepsUsed
  }

  async execute(req: ToolCallRequest): Promise<ToolOutcome> {
    if (this.signal?.aborted) return refusal('TURN_CANCELLED: no further tools may run.')
    const stepLimit = this.opts.stepLimit ?? DEFAULT_STEP_LIMIT
    if (this.stepsUsed >= stepLimit) {
      return refusal(
        `STEP_LIMIT_REACHED: ${stepLimit} tool calls were made this turn. Answer now from the information you already have.`,
      )
    }
    try {
      if (req.tool !== 'nox-read-continuation') this.deps.assertToolAllowed(req.tool)
    } catch {
      return refusal(`TOOL_UNAVAILABLE: "${req.tool}" is not available on this Notion plan or connection.`)
    }

    this.stepsUsed += 1
    const startedAt = Date.now()
    try {
      const signal = this.signal
      const result = req.tool === 'nox-read-continuation'
        ? { content: [{ type: 'text', text: this.continuation(req.args) }] }
        : await this.deps.callTool(req.tool, req.args, signal, req.provenance)
      signal?.throwIfAborted()
      const text = result.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
      const fetchPageId =
        req.tool === 'notion-fetch'
          ? (typeof req.args.id === 'string' && req.args.id ? req.args.id : typeof req.args.page_id === 'string' ? req.args.page_id : undefined)
          : undefined
      const processed = wrapUntrusted(req.tool === 'nox-read-continuation' ? text : this.excerpt(text, this.opts.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS, req.tool, fetchPageId))
      this.opts.onJournalEvent?.({ req, status: 'ok', ms: Date.now() - startedAt })
      return { success: true, contentItems: [{ type: 'inputText', text: processed }], displayText: truncateResult(text, 2_000) }
    } catch (e) {
      // Map every failure into data the model can react to (MVP: errors are results).
      const message = e instanceof Error ? e.message : String(e)
      this.opts.onJournalEvent?.({ req, status: 'error', error: message, ms: Date.now() - startedAt })
      const displayText = `ERROR: ${message}`
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: wrapUntrusted(displayText) }],
        displayText,
      }
    }
  }
}

function refusal(text: string): ToolOutcome {
  return { success: false, contentItems: [{ type: 'inputText', text }], displayText: text }
}

export interface JournalEvent {
  req: Pick<ToolCallRequest, 'tool' | 'args' | 'callId'>
  status: 'ok' | 'error'
  error?: string
  ms: number
}
