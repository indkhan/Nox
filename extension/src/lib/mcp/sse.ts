import type { JsonRpcResponse } from './jsonrpc'

/**
 * Streamable HTTP responses may arrive as plain JSON or as an SSE stream
 * (`text/event-stream`). Notion's server has used both (spike harness parsed
 * either). Returns the response payload(s) in arrival order.
 */
export function parseSseOrJson(text: string): JsonRpcResponse[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return [JSON.parse(trimmed) as JsonRpcResponse]
  }
  const out: JsonRpcResponse[] = []
  for (const event of trimmed.split(/\n\n+/)) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) continue
    out.push(JSON.parse(dataLines.join('')) as JsonRpcResponse)
  }
  return out
}

/** Extracts the payload matching our request id, or the first error present. */
export function pickResponse(payloads: JsonRpcResponse[], id: number): JsonRpcResponse | undefined {
  return payloads.find((p) => p.id === id) ?? payloads.find((p) => p.error != null)
}
