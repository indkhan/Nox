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
}

export interface ToolOutcome {
  success: boolean
  contentItems: Array<{ type: 'inputText'; text: string }>
}

/**
 * Executes Codex's item/tool/call requests against Notion.
 * Errors become model-readable results — a failing tool never crashes the turn.
 */
export class ToolExecutor {
  private stepsUsed = 0
  private signal: AbortSignal | undefined

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly opts: { stepLimit?: number; resultBudgetChars?: number; onJournalEvent?: (e: JournalEvent) => void } = {},
  ) {}

  beginTurn(signal?: AbortSignal): void {
    this.stepsUsed = 0
    this.signal = signal
  }

  get stepsTaken(): number {
    return this.stepsUsed
  }

  async execute(req: ToolCallRequest): Promise<ToolOutcome> {
    const stepLimit = this.opts.stepLimit ?? DEFAULT_STEP_LIMIT
    if (this.stepsUsed >= stepLimit) {
      return refusal(
        `STEP_LIMIT_REACHED: ${stepLimit} tool calls were made this turn. Answer now from the information you already have.`,
      )
    }
    try {
      this.deps.assertToolAllowed(req.tool)
    } catch {
      return refusal(`TOOL_UNAVAILABLE: "${req.tool}" is not available on this Notion plan or connection.`)
    }

    this.stepsUsed += 1
    const startedAt = Date.now()
    try {
      const result = await this.deps.callTool(req.tool, req.args, this.signal, req.provenance)
      const text = result.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
      const processed = wrapUntrusted(truncateResult(text, this.opts.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS))
      this.opts.onJournalEvent?.({ req, status: 'ok', ms: Date.now() - startedAt })
      return { success: true, contentItems: [{ type: 'inputText', text: processed }] }
    } catch (e) {
      // Map every failure into data the model can react to (MVP: errors are results).
      const message = e instanceof Error ? e.message : String(e)
      this.opts.onJournalEvent?.({ req, status: 'error', error: message, ms: Date.now() - startedAt })
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: wrapUntrusted(`ERROR: ${message}`) }],
      }
    }
  }
}

function refusal(text: string): ToolOutcome {
  return { success: false, contentItems: [{ type: 'inputText', text }] }
}

export interface JournalEvent {
  req: Pick<ToolCallRequest, 'tool' | 'args' | 'callId'>
  status: 'ok' | 'error'
  error?: string
  ms: number
}
