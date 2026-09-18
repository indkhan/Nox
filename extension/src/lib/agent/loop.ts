import type { CodexClient, CodexEvent, ThreadSettings } from '../codex/client'
import type { NativeBridge } from '../codex/native'
import { WORKSPACE_PLAN_TOOL_NAME } from '../architect/tool'
import { ToolExecutor } from './executor'
import { buildContextPreamble, type PageContext } from './context'
import type { CurrentPage } from '../../shared/notion-page'
import type { LocalAttachment } from '../../shared/attachments'
import { logInfo } from '../log'

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000

export interface AgentLoopDeps {
  bridge: NativeBridge
  codex: CodexClient
  executor: ToolExecutor
  /** Returns tools already filtered through the capability gate. */
  getDynamicTools: () => Promise<unknown[]>
  developerInstructions: string | ((settings: ThreadSettings) => string)
  beginTurn?: () => void
  endTurn?: () => void
  cancelPending?: () => void
  /** True while an undo holds the serial mutation boundary: new turns wait. */
  isUndoActive?: () => boolean
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
  /**
   * Conversation-lifetime untrusted exposure (Epoch F2 / R3). The same Codex
   * conversation is resumed with its previous workspace content, so once a
   * turn observes untrusted Notion text, every later turn in that
   * conversation stays untrusted until a genuinely fresh thread starts.
   * Restored non-null threads default to untrusted (conservative reload).
   */
  private untrustedConversation = false
  private turnAbort: AbortController | null = null
  private turnRunning = false
  /** User-selected model/effort applied on the next thread start or resume. */
  private overrides: Partial<ThreadSettings> = {}

  constructor(private readonly deps: AgentLoopDeps) {
    this.deps.codex.onToolCall = async (req) => {
      if (!this.turnRunning || this.cancelled) throw new Error('TURN_CANCELLED')
      const untrusted = this.untrustedContextThisTurn || this.untrustedConversation
      const outcome = await this.deps.executor.execute({
        ...req,
        provenance: untrusted ? 'untrusted-context' : 'user-only',
      })
      // Local plan receipts are Nox-internal status, not workspace content:
      // only real tool exposure taints the turn and the conversation.
      if (req.tool !== WORKSPACE_PLAN_TOOL_NAME) {
        this.untrustedContextThisTurn = true
        this.untrustedConversation = true
      }
      return {
        success: outcome.success,
        contentItems: outcome.contentItems,
        displayText: outcome.displayText,
      }
    }
    this.deps.codex.emit = (event) => this.listeners.forEach((l) => l(event))

  }

  /** Conversation-lifetime exposure, for tests and conservative restore. */
  hasUntrustedConversation(): boolean {
    return this.untrustedConversation
  }

  get currentThreadId(): string | null {
    return this.threadId
  }

  newThread(): void {
    this.threadId = null
    // A genuinely fresh model context is the only reset: no prior workspace
    // content survives, so ordinary Auto behavior is preserved for new chats.
    this.untrustedConversation = false
    this.untrustedContextThisTurn = false
  }

  restoreThread(threadId: string | null): void {
    const changed = threadId !== this.threadId
    this.threadId = threadId
    if (threadId == null) {
      this.untrustedConversation = false
      this.untrustedContextThisTurn = false
    } else if (changed) {
      // Conservative reload: a resumed conversation may still carry prior
      // workspace content in Codex history. Assume exposure until a fresh
      // thread proves otherwise; clean restores may ask once more rather
      // than silently authorize.
      this.untrustedConversation = true
    }
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
    if (this.deps.isUndoActive?.()) {
      throw new Error('UNDO_IN_PROGRESS: an undo is running — wait for it to finish before sending. No changes were made.')
    }
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
    // Provenance is actual exposure, not callback presence: an empty
    // preparation callback taints nothing by itself. Retained conversation
    // exposure carries over: turn two with no new mentions is still
    // untrusted when turn one saw workspace content (R3).
    const initialMentionsTainted = opts.mentions?.some((mention) => mention.markdown != null) ?? false
    this.untrustedContextThisTurn = this.untrustedConversation || initialMentionsTainted
    if (initialMentionsTainted) this.untrustedConversation = true
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
      if (mentions?.some((mention) => mention.markdown != null)) {
        this.untrustedContextThisTurn = true
        this.untrustedConversation = true
      }
      // Verbose trace: context fill counts only; page text never enters diagnostics.
      logInfo(`Turn context filled: mentions=${mentions?.length ?? 0}, attachments=${opts.attachments?.length ?? 0}, currentPage=${opts.currentPage ? 'yes' : 'no'}`)
      await abortable(this.ensureThread(undefined, abort.signal), abort.signal)
      abort.signal.throwIfAborted()
      if (this.deps.codex.researchLimitation) this.listeners.forEach(l => l({ kind: 'commentary', id: 'research-limitation', text: this.deps.codex.researchLimitation! }))
      const preamble = buildContextPreamble({ currentPage: opts.currentPage, mentions, attachments: opts.attachments }, (text, budget, pageId) => this.deps.executor.excerpt(text, budget, 'notion-fetch', pageId))
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
      this.deps.endTurn?.()
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
