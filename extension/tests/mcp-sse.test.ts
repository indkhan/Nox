import { describe, expect, it } from 'vitest'
import { parseSseOrJson, pickResponse } from '../src/lib/mcp/sse'

function payload(id: number, result: unknown = { ok: true }) {
  return { jsonrpc: '2.0' as const, id, result }
}

describe('SSE grammar (Epoch 12 / M12)', () => {
  it('supports LF line endings', () => {
    const text = `event: message\ndata: ${JSON.stringify(payload(1))}\n\n`
    expect(parseSseOrJson(text)[0].id).toBe(1)
  })

  it('supports CRLF line endings with multiple events', () => {
    const a = JSON.stringify(payload(1, 'a'))
    const b = JSON.stringify(payload(2, 'b'))
    const text = `event: message\r\ndata: ${a}\r\n\r\nevent: message\r\ndata: ${b}\r\n\r\n`
    const out = parseSseOrJson(text)
    expect(out.map((p) => p.result)).toEqual(['a', 'b'])
  })

  it('supports CR-only line endings', () => {
    const text = `event: message\rdata: ${JSON.stringify(payload(3))}\r\r`
    expect(parseSseOrJson(text)[0].id).toBe(3)
  })

  it('ignores comments and non-data fields', () => {
    const text = `: this is a comment\nevent: message\nid: 99\nretry: 1000\ndata: ${JSON.stringify(payload(4))}\n\n`
    const out = parseSseOrJson(text)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(4)
  })

  it('joins multiline data with newline, stripping one optional space', () => {
    // Pretty-printed JSON sent as one data: line per source line must
    // reassemble with newlines preserved (SSE join semantics).
    const pretty = JSON.stringify(payload(5, { nested: true }), null, 2)
    const sse = `event: message\n${pretty.split('\n').map((l) => `data:${l ? ` ${l}` : ''}`).join('\n')}\n\n`
    const out = parseSseOrJson(sse)
    expect(out[0].id).toBe(5)
    expect(out[0].result).toEqual({ nested: true })
  })

  it('does not trim semantic data indiscriminately', () => {
    const inner = JSON.stringify(payload(6))
    // Two spaces after colon: only one is stripped, preserving one leading space.
    const text = `data:  ${inner}\n\n`
    const out = parseSseOrJson(text)
    expect(out[0].id).toBe(6)
  })

  it('preserves unicode split across data lines', () => {
    const text = `data: ${JSON.stringify(payload(7, 'Grüße 中文 😀 €'))}\n\n`
    expect(parseSseOrJson(text)[0].result).toBe('Grüße 中文 😀 €')
  })
})

describe('pickResponse strict id matching (Epoch 12 / M12)', () => {
  it('accepts only the matching request id', () => {
    const payloads = [
      { jsonrpc: '2.0' as const, id: 99, error: { code: -32000, message: 'other' } },
      { jsonrpc: '2.0' as const, id: 5, result: 'mine' },
    ]
    expect(pickResponse(payloads, 5)?.result).toBe('mine')
  })

  it('never completes with another id error when our result arrives', () => {
    const payloads = [
      { jsonrpc: '2.0' as const, id: 99, error: { code: -32000, message: 'unrelated failure' } },
      { jsonrpc: '2.0' as const, id: 5, result: 'mine' },
    ]
    const picked = pickResponse(payloads, 5)
    expect(picked?.result).toBe('mine')
    expect(picked?.error).toBeUndefined()
  })

  it('returns undefined when only an unrelated error is present', () => {
    const payloads = [{ jsonrpc: '2.0' as const, id: 99, error: { code: -32000, message: 'other' } }]
    expect(pickResponse(payloads, 5)).toBeUndefined()
  })

  it('ignores null-id errors for a pending request', () => {
    const payloads = [{ jsonrpc: '2.0' as const, id: null, error: { code: -32600, message: 'bad' } }]
    expect(pickResponse(payloads, 5)).toBeUndefined()
  })
})
