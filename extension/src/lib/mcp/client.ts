import { buildNotification, buildRequest, type JsonRpcErrorObject } from './jsonrpc'
import { parseSseOrJson, pickResponse } from './sse'

export const MCP_ENDPOINT = 'https://mcp.notion.com/mcp'
export const MCP_PROTOCOL_VERSION = '2025-06-18'
/**
 * Bounds (Epoch 12 / M12): one MCP response/event body may use at most 8 MiB
 * of actual received bytes. `Content-Length` is only an early hint; the
 * streaming reader enforces the budget on bytes actually read, including
 * error bodies. The turn AbortSignal bounds idle streams; oversize results
 * fail honestly and never trigger a mutation retry.
 */
export const MCP_RESPONSE_BUDGET_BYTES = 8 * 1024 * 1024
const MCP_ERROR_PREVIEW_BYTES = 32 * 1024
const MCP_ERROR_PREVIEW_CHARS = 400

/** Body exceeded the byte budget before a complete response arrived. */
export class McpBodyTooLargeError extends Error {
  constructor(public readonly budgetBytes: number) {
    super(`MCP_OVERSIZE: response body exceeded ${budgetBytes} bytes; stopping instead of buffering unboundedly.`)
    this.name = 'McpBodyTooLargeError'
  }
}

/** Response arrived but has no usable payload for this request. */
export class McpMalformedResponseError extends Error {
  constructor(detail: string) {
    super(`MCP_MALFORMED: ${detail}`)
    this.name = 'McpMalformedResponseError'
  }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
  [key: string]: unknown
}

export interface McpContentPart {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpCallResult {
  content: McpContentPart[]
  isError?: boolean
  structuredContent?: unknown
  [key: string]: unknown
}

export interface McpClientDeps {
  fetchImpl: typeof fetch
  getAccessToken: () => Promise<string | null>
  endpoint?: string
  clientName?: string
  clientVersion?: string
}

/** Raised for JSON-RPC error payloads. `code` is the JSON-RPC error code. */
export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`mcp ${code}: ${message}`)
    this.name = 'McpRpcError'
  }
}

/**
 * Minimal Streamable-HTTP MCP client (MVP §4.6). Stateless-friendly: Notion's
 * server is stateless but still issues an Mcp-Session-Id which we echo for
 * support correlation (RESEARCH §2.4).
 */
export class McpClient {
  private sessionId: string | null = null
  private initialized = false

  constructor(private readonly deps: McpClientDeps) {}

  get isInitialized(): boolean {
    return this.initialized
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = (await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.deps.clientName ?? 'nox',
        version: this.deps.clientVersion ?? '0.0.1',
      },
    })) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      throw new McpMalformedResponseError('initialize result is not an object')
    }
    await this.notify('notifications/initialized')
    this.initialized = true
    return result
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc('tools/list', {})) as { tools?: unknown }
    if (typeof result !== 'object' || result === null) {
      throw new McpMalformedResponseError('tools/list result is not an object')
    }
    if (result.tools === undefined) return []
    if (!Array.isArray(result.tools)) {
      throw new McpMalformedResponseError('tools/list tools is not an array')
    }
    for (const tool of result.tools) {
      if (typeof tool !== 'object' || tool === null || typeof (tool as { name?: unknown }).name !== 'string') {
        throw new McpMalformedResponseError('tools/list tool entry is malformed')
      }
    }
    return result.tools as McpTool[]
  }

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpCallResult> {
    const result = (await this.rpc('tools/call', { name, arguments: args }, signal)) as McpCallResult
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { content?: unknown }).content)) {
      throw new McpMalformedResponseError('tools/call result content is not an array')
    }
    for (const part of result.content) {
      if (typeof part !== 'object' || part === null || typeof (part as { type?: unknown }).type !== 'string') {
        throw new McpMalformedResponseError('tools/call content part is malformed')
      }
    }
    return result
  }

  /** Flattens a tool result into the text the model should see. */
  static resultText(result: McpCallResult): string {
    if (!Array.isArray(result.content)) return ''
    return result.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.send(JSON.stringify(buildNotification(method, params)))
    // Notifications carry no usable body: drain boundedly so the connection
    // can be reused, never buffering unboundedly.
    try {
      await res.body?.cancel?.()
    } catch {
      // Cancellation is best-effort; the notification already succeeded.
    }
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = buildRequest(method, params)
    const body = JSON.stringify(request)
    const response = await this.send(body, signal)
    const contentType = response.headers.get('content-type') ?? ''
    const text = await readBoundedMcpBody(response, request.id, contentType.includes('text/event-stream'), signal)
    const payload = pickResponse(parseSseOrJson(text), request.id)
    if (!payload) {
      throw new McpMalformedResponseError(`${method}: no matching JSON-RPC payload in response`)
    }
    if (payload.jsonrpc !== '2.0' || payload.id !== request.id) {
      throw new McpMalformedResponseError(`${method}: mismatched JSON-RPC envelope`)
    }
    if (payload.error) {
      if (typeof payload.error.code !== 'number' || typeof payload.error.message !== 'string') {
        throw new McpMalformedResponseError(`${method}: malformed JSON-RPC error`)
      }
      throw toRpcError(payload.error)
    }
    if (!('result' in payload)) {
      throw new McpMalformedResponseError(`${method}: JSON-RPC payload has neither result nor error`)
    }
    return payload.result
  }

  /**
   * Sends one HTTP message and returns the raw Response after validating
   * transport-level status codes (auth / origin / rate-limit are classified
   * by errors.ts upstream).
   */
  private async send(body: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.deps.getAccessToken()
    if (!token) throw new McpUnauthenticatedError()
    // Final abort check after token acquisition: dispatch is counted at
    // actual fetch invocation below, never for a local missing-token error.
    signal?.throwIfAborted()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const res = await this.deps.fetchImpl(this.deps.endpoint ?? MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body,
      signal,
    })
    // Session id may arrive on any response; echo it from then on.
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 401) {
      try {
        await res.body?.cancel?.()
      } catch {
        // Best-effort cleanup.
      }
      throw new McpUnauthenticatedError()
    }
    if (!res.ok) {
      const preview = await readBoundedPreview(res, signal)
      throw new McpHttpError(res.status, preview, parseRetryAfter(res.headers.get('retry-after')))
    }
    return res
  }
}

export function parseRetryAfter(value: string | null): number | null {
  if (value == null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : null
}

export class McpHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`mcp http ${status}${bodyText ? `: ${bodyText}` : ''}`)
    this.name = 'McpHttpError'
  }
}

export class McpUnauthenticatedError extends Error {
  constructor() {
    super('not authenticated — connect Notion first')
    this.name = 'McpUnauthenticatedError'
  }
}

/**
 * True for failures that provably happened before fetchImpl ran, so callers
 * can record them as clean non-dispatches instead of unknown outcomes.
 * Currently only the local missing-token error qualifies: it is thrown
 * after token acquisition is attempted and before the final abort check
 * and fetch invocation.
 */
export function isPreDispatchFailure(error: unknown): boolean {
  return error instanceof McpUnauthenticatedError
}

function toRpcError(error: JsonRpcErrorObject): McpRpcError {
  return new McpRpcError(error.code, error.message, error.data)
}

function contentLengthOf(res: Response): number | null {
  const raw = res.headers.get('content-length')
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Bounded preview for HTTP error bodies: reads at most the preview budget
 * and returns at most 400 chars. Never buffers an unbounded error page and
 * never dumps full bodies into diagnostics.
 */
async function readBoundedPreview(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    const text = await readBoundedMcpBody(res, -1, false, signal, MCP_ERROR_PREVIEW_BYTES)
    return text.slice(0, MCP_ERROR_PREVIEW_CHARS)
  } catch (e) {
    if (e instanceof McpBodyTooLargeError) return ''
    try {
      signal?.throwIfAborted()
    } catch {
      throw e
    }
    return ''
  }
}

/**
 * Reads one MCP response body with a byte budget, decoding UTF-8
 * incrementally so CR/LF and JSON tokens split across transport chunks
 * survive. For SSE, cancels the reader as soon as a complete event carries
 * the matching request id; otherwise reads to end. Aborts and resets the
 * reader on signal abort. `requestId < 0` disables early exit (error preview
 * path).
 */
async function readBoundedMcpBody(
  res: Response,
  requestId: number,
  isSse: boolean,
  signal?: AbortSignal,
  budgetBytes: number = MCP_RESPONSE_BUDGET_BYTES,
): Promise<string> {
  const declared = contentLengthOf(res)
  if (declared != null && declared > budgetBytes) {
    try {
      await res.body?.cancel?.()
    } catch {
      // Best-effort cleanup.
    }
    throw new McpBodyTooLargeError(budgetBytes)
  }
  const body = res.body as ReadableStream<Uint8Array> | null
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text().catch(() => '')
    if (byteLengthOf(text) > budgetBytes) throw new McpBodyTooLargeError(budgetBytes)
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let bytes = 0
  let text = ''
  const onAbort = () => {
    try {
      void reader.cancel()
    } catch {
      // Reader already settled.
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += (value as Uint8Array).byteLength ?? (value as Uint8Array).length ?? 0
      if (bytes > budgetBytes) {
        try {
          await reader.cancel()
        } catch {
          // Already cancelled.
        }
        throw new McpBodyTooLargeError(budgetBytes)
      }
      text += decoder.decode(value as Uint8Array, { stream: true })
      if (isSse && requestId >= 0 && hasMatchingSseEvent(text, requestId)) {
        try {
          await reader.cancel()
        } catch {
          // Best-effort early stop.
        }
        break
      }
    }
    text += decoder.decode()
    // Epoch F4.1 / R7: `bytes` above already enforces actual received wire
    // bytes. Do not re-check decoded text with an inflated character
    // estimate here: valid bodies within the advertised limit (e.g. 3 MiB
    // ASCII, where text.length * 3 exceeds 8 MiB) must resolve.
    return text
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // Reader already released via cancel.
    }
  }
}

function byteLengthOf(text: string): number {
  // Conservative upper bound without allocating: 3 bytes per UTF-16 unit.
  return text.length * 3
}

/**
 * True when the accumulated SSE text already contains a complete
 * (blank-delimited) event whose JSON body carries `requestId`. Trailing
 * partial data without its blank delimiter is ignored until more bytes
 * arrive, so split JSON tokens do not false-match.
 */
function hasMatchingSseEvent(textSoFar: string, requestId: number): boolean {
  const lines = textSoFar.split(/\r\n|\r|\n/)
  let block: string[] = []
  const completeBlocks: string[][] = []
  for (const line of lines) {
    if (line === '') {
      if (block.length > 0) completeBlocks.push(block)
      block = []
    } else {
      block.push(line)
    }
  }
  // Trailing `block` without its blank delimiter is partial: ignore it.
  for (const candidate of completeBlocks) {
    const data = sseBlockData(candidate.join('\n'))
    if (data == null) continue
    try {
      const parsed = JSON.parse(data) as { id?: unknown }
      if (parsed?.id === requestId) return true
    } catch {
      // Incomplete or unrelated event; keep reading.
    }
  }
  return false
}

function sseBlockData(block: string): string | null {
  const parts: string[] = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith(':')) continue
    if (line === 'data') {
      parts.push('')
      continue
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5)
      if (value.startsWith(' ')) value = value.slice(1)
      parts.push(value)
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}
