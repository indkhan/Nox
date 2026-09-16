import { beforeEach, describe, expect, it } from 'vitest'
import {
  McpClient,
  MCP_RESPONSE_BUDGET_BYTES,
} from '../src/lib/mcp/client'
import { resetRequestIds } from '../src/lib/mcp/jsonrpc'

const BUDGET = MCP_RESPONSE_BUDGET_BYTES
const encoder = new TextEncoder()
function utf8Len(s: string): number {
  return encoder.encode(s).byteLength
}
function jsonTextBody(id: number, text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
}
function sseTextBody(id: number, text: string): string {
  return `event: message\ndata: ${jsonTextBody(id, text)}\n\n`
}
function chunkedResponse(full: string, chunkBytes = 64 * 1024): Response {
  const bytes = new TextEncoder().encode(full)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= bytes.length) {
        c.close()
        return
      }
      const end = Math.min(offset + chunkBytes, bytes.length)
      c.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
}
function makeClient(responder: (url: string, body: unknown) => Response | Promise<Response>) {
  let calls = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls++
    return responder(String(url), JSON.parse(String(init?.body)))
  }) as typeof fetch
  return { client: new McpClient({ fetchImpl, getAccessToken: async () => 'tok-1' }), calls: () => calls }
}

beforeEach(() => resetRequestIds())

describe('Epoch F4.1 — R7 streaming exact byte accounting (ASCII JSON/SSE)', () => {
  it('resolves a valid 3 MiB ASCII JSON response (R7 probe)', async () => {
    const text = 'a'.repeat(3 * 1024 * 1024)
    const { client } = makeClient((_url, body) => {
      const b = body as { id: number }
      return chunkedResponse(jsonTextBody(b.id, text))
    })
    const res = await client.callTool('notion-fetch', {})
    expect(McpClient.resultText(res).length).toBe(text.length)
  })

  it('resolves a valid 3 MiB ASCII SSE response', async () => {
    const text = 'a'.repeat(3 * 1024 * 1024)
    const { client } = makeClient((_url, body) => {
      const b = body as { id: number }
      const full = sseTextBody(b.id, text)
      const bytes = new TextEncoder().encode(full)
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (offset >= bytes.length) {
            c.close()
            return
          }
          const end = Math.min(offset + 64 * 1024, bytes.length)
          c.enqueue(bytes.subarray(offset, end))
          offset = end
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const res = await client.callTool('notion-fetch', {})
    expect(McpClient.resultText(res).length).toBe(text.length)
  })

  it('resolves below-cap ASCII JSON', async () => {
    const { client } = makeClient((_url, body) => {
      const b = body as { id: number }
      const need = BUDGET - utf8Len(jsonTextBody(b.id, '')) - 1
      const full = jsonTextBody(b.id, 'a'.repeat(need))
      expect(utf8Len(full)).toBe(BUDGET - 1)
      return chunkedResponse(full)
    })
    const res = await client.callTool('notion-fetch', {})
    expect(utf8Len(McpClient.resultText(res))).toBe(BUDGET - utf8Len(jsonTextBody(1, '')) - 1)
  })

  it('resolves exact-cap ASCII JSON', async () => {
    const { client } = makeClient((_url, body) => {
      const b = body as { id: number }
      const need = BUDGET - utf8Len(jsonTextBody(b.id, ''))
      const full = jsonTextBody(b.id, 'a'.repeat(need))
      expect(utf8Len(full)).toBe(BUDGET)
      return chunkedResponse(full)
    })
    await expect(client.callTool('notion-fetch', {})).resolves.toBeDefined()
  })

  it('rejects above-cap ASCII JSON with bounded oversize failure', async () => {
    let calls = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++
      const b = JSON.parse(String(init?.body)) as { id: number }
      const need = BUDGET - utf8Len(jsonTextBody(b.id, '')) + 1
      return chunkedResponse(jsonTextBody(b.id, 'a'.repeat(need)))
    }) as typeof fetch
    const client = new McpClient({ fetchImpl, getAccessToken: async () => 'tok-1' })
    await expect(client.callTool('notion-fetch', {})).rejects.toThrow(/MCP_OVERSIZE/)
    expect(calls).toBe(1)
  })

  it('resolves exact-cap ASCII SSE and rejects above-cap SSE', async () => {
    const exact = makeClient((_url, body) => {
      const b = body as { id: number }
      const need = BUDGET - utf8Len(sseTextBody(b.id, ''))
      const full = sseTextBody(b.id, 'a'.repeat(need))
      expect(utf8Len(full)).toBe(BUDGET)
      return new Response(full, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    await expect(exact.client.callTool('notion-fetch', {})).resolves.toBeDefined()

    let calls = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++
      const b = JSON.parse(String(init?.body)) as { id: number }
      const need = BUDGET - utf8Len(sseTextBody(b.id, '')) + 1
      return new Response(sseTextBody(b.id, 'a'.repeat(need)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const over = new McpClient({ fetchImpl, getAccessToken: async () => 'tok-1' })
    await expect(over.callTool('notion-fetch', {})).rejects.toThrow(/MCP_OVERSIZE/)
    expect(calls).toBe(1)
  })

  it('early SSE termination still resolves without reading trailing garbage', async () => {
    const { client } = makeClient((_url, body) => {
      const b = body as { id: number }
      const mine = sseTextBody(b.id, 'hello')
      // Trailing padding would exceed the cap if fully buffered, but the
      // reader must stop at the first matching event.
      const trailing = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 9999, result: { blob: 'z'.repeat(9 * 1024 * 1024) } })}\n\n`
      const full = mine + trailing
      const bytes = new TextEncoder().encode(full)
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (offset >= bytes.length) {
            c.close()
            return
          }
          const end = Math.min(offset + 1024, bytes.length)
          c.enqueue(bytes.subarray(offset, end))
          offset = end
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const res = await client.callTool('notion-fetch', {})
    expect(McpClient.resultText(res)).toBe('hello')
  })
})
