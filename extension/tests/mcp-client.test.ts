import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClient, McpHttpError, McpRpcError, McpUnauthenticatedError, parseRetryAfter } from '../src/lib/mcp/client'
import { parseSseOrJson, pickResponse } from '../src/lib/mcp/sse'
import { resetRequestIds } from '../src/lib/mcp/jsonrpc'

function sseBody(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

describe('parseSseOrJson', () => {
  it('parses plain JSON bodies', () => {
    const [p] = parseSseOrJson('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    expect(p.result).toEqual({ ok: true })
  })

  it('parses SSE frames including multi-line data', () => {
    const payload = { jsonrpc: '2.0', id: 2, result: { n: 1 } }
    const text = `event: message\ndata: ${JSON.stringify(payload).slice(0, 10)}\ndata: ${JSON.stringify(payload).slice(10)}\n\n`
    expect(parseSseOrJson(text)[0].result).toEqual({ n: 1 })
  })

  it('returns every event in order for batched SSE', () => {
    const a = { jsonrpc: '2.0', id: 1, result: 'a' }
    const b = { jsonrpc: '2.0', id: 2, result: 'b' }
    const out = parseSseOrJson(`${sseBody(a)}${sseBody(b)}`)
    expect(out.map((p) => p.result)).toEqual(['a', 'b'])
  })

  it('tolerates empty input', () => {
    expect(parseSseOrJson('')).toEqual([])
  })
})

describe('pickResponse', () => {
  it('prefers the payload with our id', () => {
    const payloads = [
      { jsonrpc: '2.0' as const, id: 99, error: { code: -32000, message: 'other' } },
      { jsonrpc: '2.0' as const, id: 5, result: 'mine' },
    ]
    expect(pickResponse(payloads, 5)?.result).toBe('mine')
  })

  it('never adopts an unrelated error when our id never arrives', () => {
    // Epoch 12 / M12: another id's error (or a null-id error) must not
    // complete this call; the caller fails honestly as no-match instead.
    const payloads = [{ jsonrpc: '2.0' as const, id: null, error: { code: -32600, message: 'bad' } }]
    expect(pickResponse(payloads, 5)).toBeUndefined()
    const other = [{ jsonrpc: '2.0' as const, id: 99, error: { code: -32000, message: 'other' } }]
    expect(pickResponse(other, 5)).toBeUndefined()
  })
})

describe('McpClient', () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>
  let fetchImpl: typeof fetch

  function makeClient(responder?: (url: string, body: unknown) => Response | Promise<Response>) {
    fetchCalls = []
    fetchImpl = (async (url, init) => {
      fetchCalls.push({ url: String(url), init: init as RequestInit })
      const parsed = JSON.parse(String(init?.body))
      if (responder) return await responder(String(url), parsed)
      // Default scripted server: initialize handshake then echo results.
      if (parsed.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: 'notion', version: '1' } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-7' },
          },
        )
      }
      return new Response(sseBody({ jsonrpc: '2.0', id: parsed.id, result: {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    return new McpClient({ fetchImpl, getAccessToken: async () => 'tok-1' })
  }

  beforeEach(() => resetRequestIds())
  afterEach(() => vi.restoreAllMocks())

  it('initialize sends protocol version + client info, then notifications/initialized', async () => {
    const client = makeClient()
    const result = await client.initialize()
    expect(result.serverInfo).toMatchObject({ name: 'notion' })
    expect(client.isInitialized).toBe(true)
    expect(fetchCalls).toHaveLength(2)
    const notifyInit = JSON.parse(String(fetchCalls[1].init.body))
    expect(notifyInit.method).toBe('notifications/initialized')
    expect(notifyInit.id).toBeUndefined()
  })

  it('echoes mcp-session-id from initialize on subsequent calls', async () => {
    const client = makeClient()
    await client.initialize()
    await client.listTools()
    const headers = fetchCalls[1].init.headers as Record<string, string>
    expect(headers['mcp-session-id']).toBe('sess-7')
  })

  it('listTools returns the tools array', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { method: string; id: number }
      if (b.method === 'tools/list') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'notion-search' }, { name: 'notion-fetch' }] } }),
          { status: 200 },
        )
      }
      throw new Error('unexpected')
    })
    await client.initialize().catch(() => undefined)
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['notion-search', 'notion-fetch'])
  })

  it('callTool posts name+arguments and flattens text content', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { method: string; id: number; params: Record<string, unknown> }
      if (b.method === 'tools/call') {
        expect(b.params).toEqual({ name: 'notion-search', arguments: { query: 'roadmap' } })
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: b.id,
            result: { content: [{ type: 'text', text: 'hit one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'hit two' }] },
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }), { status: 200 })
    })
    await client.initialize()
    const res = await client.callTool('notion-search', { query: 'roadmap' })
    expect(McpClient.resultText(res)).toBe('hit one\nhit two')
  })

  it('raises McpRpcError carrying the server error code', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32001, message: 'Server overloaded; retry later' } }),
        { status: 200 },
      )
    })
    await expect(client.listTools()).rejects.toMatchObject({ code: -32001 })
    await expect(client.listTools()).rejects.toBeInstanceOf(McpRpcError)
  })

  it('maps HTTP 401 to McpUnauthenticatedError before parsing', async () => {
    const client = makeClient(() => new Response('denied', { status: 401 }))
    await expect(client.listTools()).rejects.toBeInstanceOf(McpUnauthenticatedError)
  })

  it('wraps other HTTP failures in McpHttpError with Retry-After', async () => {
    const client = makeClient(() => new Response('throttled', { status: 429, headers: { 'retry-after': '7' } }))
    try {
      await client.listTools()
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(McpHttpError)
      expect((e as McpHttpError).status).toBe(429)
      expect((e as McpHttpError).retryAfterSeconds).toBe(7)
    }
  })

  it('supports an HTTP-date Retry-After value', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-24T12:00:00Z'))
    const client = makeClient(() => new Response('busy', {
      status: 503,
      headers: { 'retry-after': 'Mon, 24 Aug 2026 12:00:05 GMT' },
    }))
    await expect(client.listTools()).rejects.toMatchObject({ retryAfterSeconds: 5 })
  })

  it('refuses to send without an access token', async () => {
    const fetchSpy = vi.fn()
    const client = new McpClient({ fetchImpl: fetchSpy, getAccessToken: async () => null })
    await expect(client.listTools()).rejects.toBeInstanceOf(McpUnauthenticatedError)
    // A local missing-token error is a pre-dispatch failure: nothing was sent.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never invokes fetch when aborted before dispatch', async () => {
    const client = makeClient()
    const controller = new AbortController()
    controller.abort()
    await expect(client.callTool('notion-search', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchCalls).toHaveLength(0)
  })

  describe('parseRetryAfter', () => {
    it('parses seconds', () => {
      expect(parseRetryAfter('7')).toBe(7)
      expect(parseRetryAfter('0')).toBe(0)
    })

    it('parses HTTP-date values relative to now', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-24T12:00:00Z'))
      expect(parseRetryAfter('Mon, 24 Aug 2026 12:02:00 GMT')).toBe(120)
    })

    it('rejects missing and malformed values', () => {
      expect(parseRetryAfter(null)).toBeNull()
      expect(parseRetryAfter('not-a-date')).toBeNull()
    })
  })

  it('sends bearer auth and dual accept headers on every call', async () => {
    const client = makeClient()
    await client.initialize()
    const headers = fetchCalls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-1')
    expect(headers.accept).toBe('application/json, text/event-stream')
    expect(headers['content-type']).toBe('application/json')
  })

  it('parses CRLF SSE with comments and multiline data', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      const inner = JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'notion-search' }] } })
      const sse = `: comment\r\nevent: message\r\ndata: ${inner}\r\n\r\n`
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['notion-search'])
  })

  it('ignores an unrelated error when the matching result arrives', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      const other = JSON.stringify({ jsonrpc: '2.0', id: 9999, error: { code: -32000, message: 'unrelated' } })
      const mine = JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { tools: [] } })
      const sse = `event: message\ndata: ${other}\n\nevent: message\ndata: ${mine}\n\n`
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    await expect(client.listTools()).resolves.toEqual([])
  })

  it('fails honestly when only an unrelated error arrives', async () => {
    const client = makeClient(() => {
      const other = JSON.stringify({ jsonrpc: '2.0', id: 9999, error: { code: -32000, message: 'unrelated-boom' } })
      return new Response(`event: message\ndata: ${other}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    let err: Error | undefined
    try {
      await client.listTools()
    } catch (e) {
      err = e as Error
    }
    expect(String(err?.message)).toMatch(/no matching/i)
    expect(String(err?.message)).not.toContain('unrelated-boom')
  })

  it('rejects oversize bodies without unbounded buffering', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024)
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { blob: big } }), { status: 200 })
    })
    await expect(client.listTools()).rejects.toThrow(/too large|oversize|budget/i)
    expect(fetchCalls).toHaveLength(1)
  })

  it('rejects via Content-Length early check without reading the body', async () => {
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }), {
        status: 200,
        headers: { 'content-length': String(16 * 1024 * 1024) },
      })
    })
    await expect(client.listTools()).rejects.toThrow(/too large|oversize|budget|content-length/i)
  })

  it('decodes split UTF-8 across transport chunks', async () => {
    const text = 'Grüße 中文 😀 €'
    const client = makeClient((_url, body) => {
      const b = body as { id: number }
      const json = JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text }] } })
      const bytes = new TextEncoder().encode(json)
      // Split inside a 4-byte emoji sequence.
      const at = bytes.indexOf(0xf0) + 1
      const a = bytes.subarray(0, at > 0 ? at : Math.floor(bytes.length / 2))
      const rest = bytes.subarray(a.length)
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(a)
          c.enqueue(rest)
          c.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const res = await client.callTool('notion-fetch', {})
    expect(McpClient.resultText(res)).toBe(text)
  })
})
