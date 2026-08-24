import type { CodexClient, CodexEvent, ThreadSettings } from '../codex/client'
import type { NativeBridge } from '../codex/native'
import { classifyBridgeFailure } from '../codex/health'
import { ToolExecutor } from './executor'
import { buildContextPreamble } from './context'
import type { CurrentPage } from '../../shared/notion-page'

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000

export interface AgentLoopDeps {
  bridge: NativeBridge
  codex: CodexClient
  executor: ToolExecutor
  /** Returns tools already filtered through the capability gate. */
  getDynamicTools: () => Promise<unknown[]>
  developerInstructions: string
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
  private reconnectAttempted = false
  private toolUsedThisTurn = false
  private untrustedContextThisTurn = false
  private turnAbort: AbortController | null = null
  private turnRunning = false
  /** User-selected model/effort applied on the next thread start or resume. */
  private overrides: Partial<ThreadSettings> = {}

  constructor(private readonly deps: AgentLoopDeps) {
    this.deps.codex.onToolCall = async (req) => {
      this.toolUsedThisTurn = true
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
    this.deps.bridge.onStatus = ({ state }) => {
      if (state === 'running') this.reconnectAttempted = false
    }
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
  async ensureThread(settings?: Partial<ThreadSettings>): Promise<string> {
    const dynamicTools = await this.deps.getDynamicTools()
    const full: ThreadSettings = {
      dynamicTools,
      developerInstructions: this.deps.developerInstructions,
      ...this.overrides,
      ...settings,
    }
    if (this.threadId) {
      try {
        // Re-assert settings on resume so tool-schema updates take effect.
        this.threadId = await this.deps.codex.resumeThread(this.threadId, full)
        return this.threadId
      } catch {
        // Fall through to a fresh thread; the old one died with the process.
        this.threadId = null
      }
    }
    this.threadId = await this.deps.codex.startThread(full)
    return this.threadId
  }

  /**
   * Sends one user turn. Resolves with final text; streams events to listeners.
   * Only explicitly @-mentioned pages are injected as context.
   */
  async sendUserMessage(
    text: string,
    opts: { currentPage?: CurrentPage; mentions?: Array<{ pageId: string; title?: string; markdown?: string }>; timeoutMs?: number } = {},
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
    opts: { currentPage?: CurrentPage; mentions?: Array<{ pageId: string; title?: string; markdown?: string }>; timeoutMs?: number },
  ): Promise<{ text: string; interrupted: boolean }> {
    this.cancelled = false
    this.toolUsedThisTurn = false
    this.untrustedContextThisTurn = (opts.mentions?.length ?? 0) > 0
    this.turnAbort = new AbortController()
    this.deps.executor.beginTurn(this.turnAbort.signal)
    await this.ensureThread()
    this.deps.beginTurn?.()

    const preamble = buildContextPreamble({ currentPage: opts.currentPage, mentions: opts.mentions })
    const message = preamble ? `${preamble}\n\n${text}` : text

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.cancel()
    }, timeoutMs)

    try {
      const result = await this.deps.codex.runTurn([{ type: 'text', text: message }])
      return { text: result.finalText, interrupted: result.interrupted }
    } catch (e) {
      const message_ = e instanceof Error ? e.message : String(e)
      if (!this.toolUsedThisTurn && !this.reconnectAttempted && classifyBridgeFailure(message_) === 'bridge-missing') {
        // One transparent reconnect + thread resume, then give up.
        this.reconnectAttempted = true
        this.listeners.forEach((l) => l({ kind: 'bridge-reconnecting' }))
        this.deps.bridge.disconnect()
        this.threadId = null
        await this.ensureThread()
        const retry = await this.deps.codex.runTurn([{ type: 'text', text: message }])
        return { text: retry.finalText, interrupted: retry.interrupted }
      }
      throw e
    } finally {
      clearTimeout(timer)
      this.turnAbort = null
    }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.turnAbort?.abort()
    this.deps.cancelPending?.()
    void this.deps.codex.interrupt()
  }
}

/** Word-boundary trim for auto-titling threads (MVP §6.1). */
export function titleFromExchange(userText: string): string {
  const clean = userText.replace(/\s+/g, ' ').trim()
  if (clean.length <= 48) return clean || 'New chat'
  const cut = clean.slice(0, 48)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}
