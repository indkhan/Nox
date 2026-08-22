import { buildNotification, buildRequest, type JsonRpcErrorObject } from './jsonrpc'
import { parseSseOrJson, pickResponse } from './sse'

export const MCP_ENDPOINT = 'https://mcp.notion.com/mcp'
export const MCP_PROTOCOL_VERSION = '2025-06-18'

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
    await this.notify('notifications/initialized')
    this.initialized = true
    return result
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc('tools/list', {})) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.rpc('tools/call', { name, arguments: args }, signal)) as McpCallResult
  }

  async readResource(uri: string): Promise<Array<{ uri: string; text?: string; mimeType?: string }>> {
    const result = (await this.rpc('resources/read', { uri })) as {
      contents?: Array<{ uri: string; text?: string; mimeType?: string }>
    }
    return result.contents ?? []
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
    await this.send(JSON.stringify(buildNotification(method, params)))
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = buildRequest(method, params)
    const body = JSON.stringify(request)
    const response = await this.send(body, signal)
    const text = await response.text()
    const payload = pickResponse(parseSseOrJson(text), request.id)
    if (!payload) throw new Error(`${method}: no matching JSON-RPC payload in response`)
    if (payload.error) throw toRpcError(payload.error)
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
    if (res.status === 401) throw new McpUnauthenticatedError()
    if (!res.ok) {
      const retryAfterRaw = res.headers.get('retry-after')
      const retryAfterSeconds = retryAfterRaw == null ? null : Number(retryAfterRaw)
      throw new McpHttpError(
        res.status,
        (await res.text().catch(() => '')).slice(0, 400),
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      )
    }
    return res
  }
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

function toRpcError(error: JsonRpcErrorObject): McpRpcError {
  return new McpRpcError(error.code, error.message, error.data)
}
