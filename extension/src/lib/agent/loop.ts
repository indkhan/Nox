import type { CodexClient, CodexEvent, ThreadSettings } from '../codex/client'
import type { NativeBridge } from '../codex/native'
import { ToolExecutor } from './executor'
import { buildContextPreamble, type PageContext } from './context'
import type { CurrentPage } from '../../shared/notion-page'
import type { LocalAttachment } from '../../shared/attachments'

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000

export interface AgentLoopDeps {
  bridge: NativeBridge
  codex: CodexClient
  executor: ToolExecutor
  /** Returns tools already filtered through the capability gate. */
  getDynamicTools: () => Promise<unknown[]>
  developerInstructions: string | ((settings: ThreadSettings) => string)
  beginTurn?: () => void
  cancelPending?: () => void
}

export type TurnListener = (event: CodexEvent | { kind: 'bridge-reconnecting' }) => void

/**
 * Owns the persistent thread and turn lifecycle. One loop per panel document.
 */
export class AgentLoop {
  private threadId: string | null = null
  private listeners = new Set<TurnListener>()
  private cancelled = false
  private untrustedContextThisTurn = false
  private turnAbort: AbortController | null = null
  private turnRunning = false
  /** User-selected model/effort applied on the next thread start or resume. */
  private overrides: Partial<ThreadSettings> = {}

  constructor(private readonly deps: AgentLoopDeps) {
    this.deps.codex.onToolCall = async (req) => {
      if (!this.turnRunning || this.cancelled) throw new Error('TURN_CANCELLED')
      const outcome = await this.deps.executor.execute({
        ...req,
        provenance: this.untrustedContextThisTurn ? 'untrusted-context' : 'user-only',
      })
      this.untrustedContextThisTurn = true
      return {
        success: outcome.success,
        contentItems: outcome.contentItems,
        displayText: outcome.displayText,
      }
    }
    this.deps.codex.emit = (event) => this.listeners.forEach((l) => l(event))

  }

  get currentThreadId(): string | null {
    return this.threadId
  }

  newThread(): void {
    this.threadId = null
  }

  restoreThread(threadId: string | null): void {
    this.threadId = threadId
  }

  /** Model/effort changes land on the next turn via thread resume. */
  setOverrides(overrides: Partial<ThreadSettings>): void {
    this.overrides = { ...this.overrides, ...overrides }
  }

  onTurnEvent(listener: TurnListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts or resumes the persistent thread; safe to call every turn. */
  async ensureThread(settings?: Partial<ThreadSettings>, signal?: AbortSignal): Promise<string> {
    const dynamicTools = await this.deps.getDynamicTools()
    signal?.throwIfAborted()
    const full: ThreadSettings = {
      dynamicTools,
      developerInstructions: '',
      ...this.overrides,
      ...settings,
    }
    full.developerInstructions = typeof this.deps.developerInstructions === 'function' ? this.deps.developerInstructions(full) : this.deps.developerInstructions
    if (this.threadId) {
      const original = this.threadId
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resumed = await this.deps.codex.resumeThread(original, full, signal)
          signal?.throwIfAborted()
          if (resumed !== original) throw new Error('Server returned a different thread')
          return resumed
        } catch (error) {
          signal?.throwIfAborted()
          const message = error instanceof Error ? error.message : String(error)
          if (attempt === 0 && /port disconnected|bridge timeout|codex exited|codex not running/i.test(message)) {
            this.deps.bridge.disconnect()
            await this.deps.codex.initialize()
            continue
          }
          throw new Error(`Could not resume this conversation: ${message}. Reconnect and retry, or explicitly start a new chat. Your visible history is preserved.`)
        }
      }
    }
    const started = await this.deps.codex.startThread(full, signal)
    signal?.throwIfAborted()
    this.threadId = started
    return this.threadId
  }

  /**
   * Sends one user turn. Resolves with final text; streams events to listeners.
   * Only explicitly @-mentioned pages are injected as context.
   */
  async sendUserMessage(
    text: string,
    opts: { currentPage?: CurrentPage; mentions?: PageContext[]; attachments?: LocalAttachment[]; signal?: AbortSignal; prepareContext?: (signal: AbortSignal) => Promise<PageContext[]>; timeoutMs?: number } = {},
  ): Promise<{ text: string; interrupted: boolean }> {
    if (this.turnRunning) throw new Error('turn already running')
    this.turnRunning = true
    try {
      return await this.runUserMessage(text, opts)
    } finally {
      this.turnRunning = false
    }
  }

  private async runUserMessage(
    text: string,
    opts: { currentPage?: CurrentPage; mentions?: PageContext[]; attachments?: LocalAttachment[]; signal?: AbortSignal; prepareContext?: (signal: AbortSignal) => Promise<PageContext[]>; timeoutMs?: number },
  ): Promise<{ text: string; interrupted: boolean }> {
    this.cancelled = false
    this.untrustedContextThisTurn = (opts.mentions?.length ?? 0) > 0 || !!opts.prepareContext
    const abort = new AbortController()
    this.turnAbort = abort
    const cancel = () => this.cancel()
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    this.deps.executor.beginTurn(abort.signal)
    this.deps.beginTurn?.()
    let started = false
    try {
      if (opts.signal?.aborted) this.cancel()
      abort.signal.throwIfAborted()
      const mentions = opts.prepareContext ? await abortable(opts.prepareContext(abort.signal), abort.signal) : opts.mentions
      await abortable(this.ensureThread(undefined, abort.signal), abort.signal)
      abort.signal.throwIfAborted()
      if (this.deps.codex.researchLimitation) this.listeners.forEach(l => l({ kind: 'commentary', id: 'research-limitation', text: this.deps.codex.researchLimitation! }))
      const preamble = buildContextPreamble({ currentPage: opts.currentPage, mentions, attachments: opts.attachments }, (text, budget) => this.deps.executor.excerpt(text, budget))
      const researchState = this.deps.codex.researchLimitation ?? (this.overrides.webSearchEnabled === false ? 'Web research is disabled. Do not claim fresh verification.' : 'Live web search is requested. Claim fresh verification only after reading sources this turn.')
      const message = preamble ? `${researchState}\n${preamble}\n\n${text}` : text
      started = true
      const result = await this.deps.codex.runTurn([{ type: 'text', text: message }])
      return { text: result.finalText, interrupted: result.interrupted }
    } catch (error) {
      if (abort.signal.aborted && !started) return { text: '', interrupted: true }
      throw error
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', cancel)
      abort.abort()
      this.deps.executor.endTurn()
      this.deps.cancelPending?.()
      this.turnAbort = null
    }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.turnAbort?.abort()
    this.deps.cancelPending?.()
    void this.deps.codex.interrupt().catch((error) => {
      this.listeners.forEach(l => l({ kind: 'error', message: String(error) }))
    })
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('TURN_CANCELLED'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
