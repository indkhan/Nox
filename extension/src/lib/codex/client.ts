import { researchConfig, verifyResearchTools } from './research'
import type { NativeBridge } from './native'
// Single version source: extension/package.json (see manifest.config.ts mapping).
import { version as NOX_VERSION } from '../../../package.json'

/** `model/list` entry — everything the UI needs to render a picker (MVP §10b). */
export interface ModelInfo {
  id: string
  displayName?: string
  description?: string
  defaultReasoningEffort?: string
  isDefault?: boolean
  inputModalities?: string[]
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>
  serviceTiers?: Array<{ id: string; name: string; description: string }>
}

export interface ThreadSettings {
  model?: string
  webSearchEnabled?: boolean
  effort?: string
  serviceTier?: string
  dynamicTools?: unknown[]
  developerInstructions?: string
  /** Persistent threads keep prompt caching alive (RESEARCH §3.6). */
  ephemeral?: boolean
}

export interface TurnUsage {
  input_tokens?: number
  output_tokens?: number
  [key: string]: unknown
}

export type TurnInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }

/** The only event shapes the UI ever sees — raw JSON-RPC stays in here. */
export type CodexEvent =
  | { kind: 'turn-started'; threadId: string }
  | { kind: 'reasoning-started' }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'text-started' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'text-replaced'; text: string }
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'web-search'; id?: string; query?: string; action?: Record<string, unknown> }
  | { kind: 'web-search-completed'; id?: string; query?: string; action?: Record<string, unknown> }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed'; tool?: string; callId?: string; success?: boolean; error?: string; durationMs?: number; resultText?: string }
  | { kind: 'usage'; usage: TurnUsage | null }
  | { kind: 'done'; interrupted: boolean; finalText: string }
  | { kind: 'error'; message: string }

export interface ToolCallRequest {
  tool: string
  namespace: string | null
  args: Record<string, unknown>
  /** Raw JSON-RPC id we must answer through the bridge. */
  rid: number
  callId?: string
  signal?: AbortSignal
  provenance?: 'user-only' | 'untrusted-context'
}

interface ItemParams extends Record<string, unknown> {
  threadId?: string
  turnId?: string
  itemId?: string
  item?: { type?: string; id?: string; text?: string; phase?: string | null; query?: string; action?: Record<string, unknown>; tool?: string; status?: string }
  delta?: string
  error?: { message?: string }
  turn?: { id?: string; status?: string; error?: { message?: string } | null; usage?: TurnUsage }
  usage?: TurnUsage
  interrupted?: boolean
}

/**
 * Drives the verified app-server lifecycle (docs/plans/E3.md):
 * initialize → model/list → thread/start → turn/start ⇄ items → turn/completed,
 * normalizing every notification into CodexEvent.
 */
export class CodexClient {
  userAgent: string | null = null
  researchLimitation: string | null = null
  private models: ModelInfo[] | null = null
  private wired = false

  /** Single active turn for V1 (the panel owns one loop). */
  private activeThread: string | null = null
  private turnDone: ((r: { interrupted: boolean; finalText: string }) => void) | null = null
  private turnFail: ((e: Error) => void) | null = null
  private turnFinalText = ''
  private sawError: string | null = null
  private turnRunning = false
  private activeTurn: string | null = null
  private effort: string | undefined
  private pendingEvents: Array<() => void> = []
  private messages = new Map<string, { text: string; phase?: string | null; completed: boolean }>()
  private searches = new Set<string>()
  private searchCompletions = new Set<string>()
  private cancelled = false
  private interruptTimer: ReturnType<typeof setTimeout> | undefined
  private interruptPending: Promise<void> | null = null

  constructor(private readonly bridge: NativeBridge) {}

  /** Idempotent: attaches bridge-level handlers exactly once. */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    this.bridge.onNotification = ({ method, params }) => this.handleNotification(method, params as ItemParams)
    this.bridge.onCodexRequest = (req) => {
      if (this.turnRunning && !this.activeTurn) this.pendingEvents.push(() => void this.handleServerRequest(req))
      else void this.handleServerRequest(req)
    }
    const disconnected = this.bridge.onBridgeDisconnected
    this.bridge.onBridgeDisconnected = () => {
      this.failActiveTurn('bridge port disconnected; reconnect before continuing')
      disconnected?.()
    }
    const status = this.bridge.onStatus
    this.bridge.onStatus = (event) => {
      if (['exited', 'dead'].includes(event.state)) this.failActiveTurn('Codex disconnected; reconnect before continuing')
      status?.(event)
    }
  }

  async initialize(): Promise<string> {
    this.wire()
    const result = (await this.bridge.rpc<Record<string, unknown>>('initialize', {
      clientInfo: { name: 'nox', title: 'Nox', version: NOX_VERSION },
      capabilities: { experimentalApi: true },
    })) as { userAgent?: string }
    this.bridge.notify('initialized')
    this.userAgent = result.userAgent ?? null
    return this.userAgent ?? 'unknown'
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    if (!this.models || force) {
      const result = await this.bridge.rpc<{ data?: ModelInfo[] }>('model/list', {})
      this.models = result.data ?? []
    }
    return this.models
  }

  defaultModel(models: ModelInfo[] = this.models ?? []): string | undefined {
    return models.find((m) => m.isDefault)?.id
  }

  async startThread(settings: ThreadSettings, signal?: AbortSignal): Promise<string> {
    this.wire()
    const models = await this.listModels()
    signal?.throwIfAborted()
    this.selectEffort(settings, models)
    const research = await researchConfig(this.bridge, settings.webSearchEnabled !== false)
    signal?.throwIfAborted()
    this.researchLimitation = research.limitation
    const params = {
      ...this.threadParams(settings),
      config: research.config,
      developerInstructions: [settings.developerInstructions, research.limitation].filter(Boolean).join('\n'),
      // Pin the chosen model explicitly so a stale binary fails loudly instead
      // of silently defaulting (RESEARCH §3.4).
      model: settings.model ?? this.defaultModel(models),
      ephemeral: settings.ephemeral ?? false,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      personality: 'pragmatic',
    }
    const result = (await this.bridge.rpc<Record<string, unknown>>('thread/start', params)) as {
      thread?: { id?: string }
      id?: string
    }
    const threadId = result.thread?.id ?? result.id
    if (!threadId) throw new Error('thread/start returned no thread id')
    signal?.throwIfAborted()
    await verifyResearchTools(this.bridge, threadId, signal)
    signal?.throwIfAborted()
    this.activeThread = threadId
    return threadId
  }

  async resumeThread(threadId: string, settings: ThreadSettings, signal?: AbortSignal): Promise<string> {
    if (this.turnRunning) throw new Error('Cannot resume during an active turn')
    signal?.throwIfAborted()
    // 0.153.4 rejoins loaded threads without applying fresh configuration.
    // Reload our owned server, then resume the same persisted ID; never replay a turn.
    this.bridge.disconnect()
    await this.initialize()
    signal?.throwIfAborted()
    const models = await this.listModels()
    signal?.throwIfAborted()
    this.selectEffort(settings, models)
    const research = await researchConfig(this.bridge, settings.webSearchEnabled !== false)
    signal?.throwIfAborted()
    this.researchLimitation = research.limitation
    const { dynamicTools: _tools, ephemeral: _ephemeral, ...params } = this.threadParams(settings)
    const result = (await this.bridge.rpc<Record<string, unknown>>('thread/resume', {
      threadId,
      ...params,
      model: settings.model ?? this.defaultModel(models),
      config: research.config,
      developerInstructions: [settings.developerInstructions, research.limitation].filter(Boolean).join('\n'),
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })) as { thread?: { id?: string }; id?: string }
    const resumed = (result.thread?.id ?? result.id) ?? threadId
    if (resumed !== threadId) throw new Error('Server returned a different thread')
    signal?.throwIfAborted()
    await verifyResearchTools(this.bridge, resumed, signal)
    signal?.throwIfAborted()
    // Resume retains old developer messages in model-visible history on 0.153.4.
    // Append the current trusted policy using the documented history-input RPC.
    await this.bridge.rpc('thread/inject_items', { threadId: resumed, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: [settings.developerInstructions, research.limitation].filter(Boolean).join('\n') }] }] })
    signal?.throwIfAborted()
    this.activeThread = resumed
    return resumed
  }

  private threadParams(settings: ThreadSettings) {
    const { effort: _effort, webSearchEnabled: _webSearchEnabled, ...params } = settings
    return params
  }

  private selectEffort(settings: ThreadSettings, models: ModelInfo[]): void {
    const model = models.find(m => m.id === (settings.model ?? this.defaultModel(models)))
    if (settings.effort && model?.supportedReasoningEfforts?.length &&
        !model.supportedReasoningEfforts.some(e => e.reasoningEffort === settings.effort)) {
      throw new Error(`Reasoning effort ${settings.effort} is unavailable for ${model.id}. Choose a supported effort.`)
    }
    this.effort = settings.effort ?? model?.defaultReasoningEffort
  }

  async runTurn(input: TurnInput[]): Promise<{ interrupted: boolean; finalText: string }> {
    if (!this.activeThread) throw new Error('no active thread: start or resume one first')
    if (this.turnRunning) throw new Error('turn already running')
    this.turnRunning = true
    this.wire()
    this.activeTurn = null
    this.cancelled = false
    this.interruptPending = null
    this.pendingEvents = []
    this.messages.clear()
    this.searches.clear()
    this.searchCompletions.clear()
    this.turnFinalText = ''
    this.sawError = null
    const completion = new Promise<{ interrupted: boolean; finalText: string }>((resolve, reject) => {
      this.turnDone = resolve
      this.turnFail = reject
    })
    // A disconnect can reject completion while the start RPC is still pending.
    void completion.catch(() => undefined)
    this.emit({ kind: 'turn-started', threadId: this.activeThread })
    try {
      const result = await Promise.race([
        this.bridge.rpc<{ turn: { id: string } }>('turn/start', { threadId: this.activeThread, input, effort: this.effort }),
        completion.then(() => { throw new Error('Turn ended before acknowledgement') }),
      ])
      if (!result.turn?.id) throw new Error('turn/start returned no turn id')
      this.activeTurn = result.turn.id
      for (const apply of this.pendingEvents.splice(0)) apply()
      if (this.cancelled && this.turnDone) void this.interrupt().catch(() => undefined)
      return await completion
    } finally {
      clearTimeout(this.interruptTimer)
      this.interruptTimer = undefined
      this.turnRunning = false
      this.activeTurn = null
      this.turnDone = null
      this.turnFail = null
      this.pendingEvents = []
    }
  }

  async interrupt(): Promise<void> {
    this.cancelled = true
    if (!this.turnDone) return
    const done = this.turnDone
    if (!this.interruptTimer) this.interruptTimer = setTimeout(() => {
      if (this.turnDone !== done) return
      this.failActiveTurn('Could not stop Codex: no completion received within five seconds.')
      this.bridge.disconnect()
    }, 5000)
    if (!this.activeThread || !this.turnRunning || !this.activeTurn) return
    if (this.interruptPending) return this.interruptPending
    this.interruptPending = (async () => {
      try {
        await this.bridge.rpc('turn/interrupt', { threadId: this.activeThread, turnId: this.activeTurn }, 5000)
      } catch (e) {
        if (this.turnDone !== done) return
        const message = `Could not stop Codex: ${e instanceof Error ? e.message : String(e)}`
        this.failActiveTurn(message)
        this.bridge.disconnect()
        throw new Error(message)
      }
    })()
    return this.interruptPending
  }

  private failActiveTurn(message: string): void {
    if (!this.turnFail) return
    this.cancelled = true
    this.emit({ kind: 'text-replaced', text: this.answerText() })
    this.emit({ kind: 'error', message })
    this.turnFail(new Error(message))
    this.turnFail = null
    this.turnDone = null
  }

  private answerEntry(completed = false) {
    const candidates = [...this.messages].filter(([, m]) => m.phase !== 'commentary')
    return candidates.filter(([, m]) => m.phase === 'final_answer').at(-1)
      ?? (completed ? candidates.filter(([, m]) => m.completed).at(-1) : undefined)
      ?? candidates.at(-1)
  }

  private answerText(): string {
    return this.answerEntry()?.[1].text ?? ''
  }

  emit: (event: CodexEvent) => void = () => {}

  /** Executes Notion tools when Codex asks; returns the content answer. */
  onToolCall: ((req: ToolCallRequest) => Promise<unknown>) | null = null

  private async handleServerRequest(req: {
    rid: number
    method: string
    params: Record<string, unknown>
  }): Promise<void> {
    if (req.method === 'item/tool/call') {
      if (!this.turnDone || this.cancelled || req.params.threadId !== this.activeThread || req.params.turnId !== this.activeTurn) {
        this.bridge.respondTool(req.rid, { success: false, contentItems: [{ type: 'inputText', text: 'TURN_UNAVAILABLE: this turn is no longer active.' }] })
        return
      }
      const done = this.turnDone
      const p = req.params as { tool?: unknown; namespace?: unknown; arguments?: unknown; callId?: unknown }
      const rawTool = p.tool ?? p.namespace
      if (typeof rawTool !== 'string' || rawTool.length === 0) {
        this.bridge.respondTool(req.rid, { success: false, contentItems: [{ type: 'inputText', text: 'MALFORMED_REQUEST: invalid tool name. No changes were made.' }] })
        return
      }
      if (p.arguments !== undefined && (typeof p.arguments !== 'object' || p.arguments === null || Array.isArray(p.arguments))) {
        this.bridge.respondTool(req.rid, { success: false, contentItems: [{ type: 'inputText', text: 'MALFORMED_REQUEST: invalid tool arguments. No changes were made.' }] })
        return
      }
      if (p.callId !== undefined && typeof p.callId !== 'string') {
        this.bridge.respondTool(req.rid, { success: false, contentItems: [{ type: 'inputText', text: 'MALFORMED_REQUEST: invalid call id. No changes were made.' }] })
        return
      }
      if (p.namespace !== undefined && p.namespace !== null && typeof p.namespace !== 'string') {
        this.bridge.respondTool(req.rid, { success: false, contentItems: [{ type: 'inputText', text: 'MALFORMED_REQUEST: invalid tool namespace. No changes were made.' }] })
        return
      }
      const tool = rawTool
      const args = (p.arguments ?? {}) as Record<string, unknown>
      const callId = p.callId as string | undefined
      const namespace = (p.namespace ?? null) as string | null
      const startedAt = Date.now()
      this.emit({ kind: 'tool-call', tool, args, callId })
      try {
        const result = this.onToolCall
          ? await this.onToolCall({ tool, namespace, args, rid: req.rid, callId })
          : { decision: 'decline' }
        if (this.turnDone !== done || this.cancelled) return
        this.bridge.respondTool(req.rid, result)
        const outcome = toolOutcomeMeta(result)
        const resultText = toolResultText(result)
        this.emit({
          kind: 'tool-completed', tool, callId, success: outcome.success,
          durationMs: Date.now() - startedAt, resultText, error: outcome.success ? undefined : resultText,
        })
      } catch (e) {
        if (this.turnDone !== done || this.cancelled) return
        // Errors become model-readable results, never a crashed turn (MVP §6).
        this.bridge.respondTool(req.rid, {
          success: false,
          contentItems: [{ type: 'inputText', text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
        })
        this.emit({
          kind: 'tool-completed',
          tool,
          callId,
          success: false,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - startedAt,
        })
      }
      return
    }
    // Approvals/other server requests are declined in V1.
    this.bridge.respondTool(req.rid, { decision: 'decline' })
  }

  private searchEvent(item: NonNullable<ItemParams['item']>, completed: boolean): void {
    const id = item.id ?? 'unknown-search'
    const seen = completed ? this.searchCompletions : this.searches
    if (seen.has(id)) return
    seen.add(id)
    if (!this.searches.has(id)) this.searches.add(id)
    this.emit({ kind: completed ? 'web-search-completed' : 'web-search', id, query: item.query, action: item.action })
    if (this.searches.size >= 12 && !this.cancelled) {
      this.emit({ kind: 'commentary', id: 'research-limit', text: 'Research limit reached. This response may be incomplete; remaining sources were not verified.' })
      void this.interrupt().catch(() => undefined)
    }
  }

  private handleNotification(method: string, p: ItemParams): void {
    if (!this.turnDone || p.threadId !== this.activeThread) return
    if (!this.activeTurn) {
      this.pendingEvents.push(() => this.handleNotification(method, p))
      return
    }
    if ((p.turn?.id ?? p.turnId) !== this.activeTurn) return
    if (method === 'item/reasoning/summaryTextDelta') {
      if (typeof p.delta !== 'string' || !p.delta) return
      this.emit({ kind: 'reasoning-delta', text: p.delta })
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof p.itemId !== 'string' || !p.itemId || typeof p.delta !== 'string' || !p.delta) return
      const message = this.messages.get(p.itemId) ?? { text: '', completed: false }
      if (message.completed) return
      message.text += p.delta
      this.messages.set(p.itemId, message)
      if (message.phase === 'final_answer') this.emit({ kind: 'text-replaced', text: message.text })
      // Unknown phases wait for completion: progress must never flash as an answer.
      return
    }
    switch (method) {
      case 'item/started':
        if (p.item?.type === 'reasoning') this.emit({ kind: 'reasoning-started' })
        if (p.item?.type === 'agentMessage' && typeof p.item.id === 'string' && p.item.id) {
          const text = typeof p.item.text === 'string' ? p.item.text : ''
          const phase = typeof p.item.phase === 'string' || p.item.phase == null ? p.item.phase : undefined
          this.messages.set(p.item.id, { text, phase, completed: false })
          if (p.item.phase === 'final_answer') this.emit({ kind: 'text-started' })
        }
        if (p.item?.type === 'webSearch') this.searchEvent(p.item, false)
        return
      case 'item/completed':
        if (p.item?.type === 'agentMessage' && typeof p.item.id === 'string' && p.item.id) {
          const text = typeof p.item.text === 'string' ? p.item.text : ''
          const phase = typeof p.item.phase === 'string' || p.item.phase == null ? p.item.phase : undefined
          this.messages.set(p.item.id, { text, phase, completed: true })
          if (p.item.phase === 'commentary') this.emit({ kind: 'commentary', id: p.item.id, text })
          if (p.item.phase === 'final_answer') this.emit({ kind: 'text-replaced', text })
        }
        if (p.item?.type === 'webSearch') this.searchEvent(p.item, true)
        return
      case 'error':
        this.sawError = p.error?.message ?? 'Codex error'
        return
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } } | undefined
        this.emit({ kind: 'usage', usage: { input_tokens: usage?.last?.inputTokens, output_tokens: usage?.last?.outputTokens } })
        return
      }
      case 'turn/completed': {
        const answer = this.answerEntry(p.turn?.status === 'completed')
        this.turnFinalText = answer?.[1].text ?? ''
        const candidateId = answer?.[0]
        for (const [id, message] of this.messages) {
          if (!message.phase && id !== candidateId) this.emit({ kind: 'commentary', id, text: message.text })
        }
        this.emit({ kind: 'text-replaced', text: this.turnFinalText })
        // Legacy usage is retained for older saved fixtures; current usage arrives separately.
        if (p.turn?.usage || p.usage) this.emit({ kind: 'usage', usage: p.turn?.usage ?? p.usage ?? null })
        if (p.turn?.status === 'failed') {
          this.failActiveTurn(p.turn.error?.message ?? this.sawError ?? 'Codex turn failed')
          return
        }
        const interrupted = p.turn?.status === 'interrupted'
        if (!interrupted && p.turn?.status !== 'completed') {
          this.failActiveTurn('Unknown Codex completion status')
          return
        }
        this.emit({ kind: 'done', interrupted, finalText: this.turnFinalText })
        this.turnDone?.({ interrupted, finalText: this.turnFinalText })
        this.turnDone = null
        this.turnFail = null
        return
      }
    }
  }
}

function toolResultText(result: unknown): string | undefined {
  if (result && typeof result === 'object' && 'displayText' in result && typeof (result as { displayText?: unknown }).displayText === 'string') {
    return (result as { displayText: string }).displayText
  }
  if (!result || typeof result !== 'object' || !('contentItems' in result)) return undefined
  const items = (result as { contentItems?: Array<{ text?: string }> }).contentItems
  return items?.map((item) => item.text ?? '').filter(Boolean).join('\n').slice(0, 2000) || undefined
}

function toolOutcomeMeta(result: unknown): { success: boolean } {
  if (result && typeof result === 'object' && 'success' in result && (result as { success?: unknown }).success === false) {
    return { success: false }
  }
  return { success: true }
}
