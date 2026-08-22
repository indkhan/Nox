import type { NativeBridge } from './native'

/** `model/list` entry — everything the UI needs to render a picker (MVP §10b). */
export interface ModelInfo {
  id: string
  displayName?: string
  description?: string
  isDefault?: boolean
  inputModalities?: string[]
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>
}

export interface ThreadSettings {
  model?: string
  effort?: string
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
  | { kind: 'web-search' }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed' }
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
  item?: { type?: string; id?: string; text?: string; tool?: string; status?: string }
  delta?: string
  error?: { message?: string }
  turn?: { usage?: TurnUsage }
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
  private models: ModelInfo[] | null = null
  private wired = false

  /** Single active turn for V1 (the panel owns one loop). */
  private activeThread: string | null = null
  private turnDone: ((r: { interrupted: boolean; finalText: string }) => void) | null = null
  private turnFail: ((e: Error) => void) | null = null
  private turnFinalText = ''
  private sawError: string | null = null
  private turnRunning = false

  constructor(private readonly bridge: NativeBridge) {}

  /** Idempotent: attaches bridge-level handlers exactly once. */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    this.bridge.onNotification = ({ method, params }) => this.handleNotification(method, params as ItemParams)
    this.bridge.onCodexRequest = (req) => void this.handleServerRequest(req)
  }

  async initialize(): Promise<string> {
    this.wire()
    const result = (await this.bridge.rpc<Record<string, unknown>>('initialize', {
      clientInfo: { name: 'nox', title: 'Nox', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })) as { userAgent?: string }
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

  async startThread(settings: ThreadSettings): Promise<string> {
    this.wire()
    const models = await this.listModels()
    const params = {
      ...settings,
      // Pin the chosen model explicitly so a stale binary fails loudly instead
      // of silently defaulting (RESEARCH §3.4).
      model: settings.model ?? this.defaultModel(models),
      effort: settings.effort ?? 'low',
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
    this.activeThread = threadId
    return threadId
  }

  async resumeThread(threadId: string, settings: ThreadSettings): Promise<string> {
    this.wire()
    const result = (await this.bridge.rpc<Record<string, unknown>>('thread/resume', {
      threadId,
      ...settings,
    })) as { thread?: { id?: string }; id?: string }
    const resumed = (result.thread?.id ?? result.id) ?? threadId
    this.activeThread = resumed
    return resumed
  }

  /**
   * Starts one turn and resolves when it completes. Events stream through
   * onEvent while it runs.
   */
  async runTurn(input: TurnInput[]): Promise<{ interrupted: boolean; finalText: string }> {
    if (!this.activeThread) throw new Error('no active thread — start or resume one first')
    if (this.turnRunning) throw new Error('turn already running')
    this.turnRunning = true
    this.wire()
    this.turnFinalText = ''
    this.sawError = null
    // Register the completion promise BEFORE the request goes out — the server
    // may stream notifications before its response frame arrives.
    const completion = new Promise<{ interrupted: boolean; finalText: string }>((resolve, reject) => {
      this.turnDone = resolve
      this.turnFail = reject
    })
    this.emit({ kind: 'turn-started', threadId: this.activeThread })
    try {
      await this.bridge.rpc('turn/start', { threadId: this.activeThread, input })
      return await completion
    } finally {
      this.turnRunning = false
      this.turnDone = null
      this.turnFail = null
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeThread) return
    await this.bridge.rpc('turn/interrupt', { threadId: this.activeThread }).catch(() => undefined)
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
      const p = req.params as { tool?: string; namespace?: string; arguments?: Record<string, unknown>; callId?: string }
      const tool = p.tool ?? p.namespace ?? 'unknown'
      const args = p.arguments ?? {}
      this.emit({ kind: 'tool-call', tool, args, callId: p.callId })
      try {
        const result = this.onToolCall
          ? await this.onToolCall({ tool, namespace: p.namespace ?? null, args, rid: req.rid, callId: p.callId })
          : { decision: 'decline' }
        this.bridge.respondTool(req.rid, result)
        this.emit({ kind: 'tool-completed' })
      } catch (e) {
        // Errors become model-readable results, never a crashed turn (MVP §6).
        this.bridge.respondTool(req.rid, {
          success: false,
          contentItems: [{ type: 'inputText', text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
        })
        this.emit({ kind: 'tool-completed' })
      }
      return
    }
    // Approvals/other server requests are declined in V1.
    this.bridge.respondTool(req.rid, { decision: 'decline' })
  }

  private handleNotification(method: string, p: ItemParams): void {
    if (method.startsWith('item/') && method.endsWith('/delta')) {
      const itemType = method.slice(5, -6) // between item/ and /delta
      if (!p.delta) return
      if (itemType === 'agentMessage') {
        this.turnFinalText += p.delta
        this.emit({ kind: 'text-delta', text: p.delta })
      } else if (itemType === 'reasoning') {
        this.emit({ kind: 'reasoning-delta', text: p.delta })
      }
      return
    }

    switch (method) {
      case 'item/started': {
        const type = p.item?.type
        if (type === 'reasoning') this.emit({ kind: 'reasoning-started' })
        else if (type === 'agentMessage') this.emit({ kind: 'text-started' })
        else if (type === 'webSearch') this.emit({ kind: 'web-search' })
        return
      }
      case 'item/completed': {
        if (p.item?.type === 'agentMessage') {
          // Prefer the authoritative completed text over accumulated deltas.
          if (typeof p.item.text === 'string' && p.item.text.length >= this.turnFinalText.length) {
            this.turnFinalText = p.item.text
          }
        }
        if (p.item?.type === 'dynamicToolCall') this.emit({ kind: 'tool-completed' })
        return
      }
      case 'error': {
        this.sawError = p.error?.message ?? JSON.stringify(p)
        this.emit({ kind: 'error', message: this.sawError })
        return
      }
      case 'turn/completed': {
        const usage = p.turn?.usage ?? p.usage ?? null
        this.emit({ kind: 'usage', usage })
        const interrupted = p.interrupted === true
        this.emit({ kind: 'done', interrupted, finalText: this.turnFinalText })
        const done = this.turnDone
        const fail = this.turnFail
        this.turnDone = null
        this.turnFail = null
        if (fail && this.sawError && !interrupted && !this.turnFinalText) {
          fail(new Error(this.sawError))
        } else {
          done?.({ interrupted, finalText: this.turnFinalText })
        }
        return
      }
      default:
      // Unknown notifications are ignored deliberately.
    }
  }
}
