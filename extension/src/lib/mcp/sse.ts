import type { JsonRpcResponse } from './jsonrpc'

/**
 * Streamable HTTP responses may arrive as plain JSON or as an SSE stream
 * (`text/event-stream`). Notion's server has used both (spike harness parsed
 * either). Returns the response payload(s) in arrival order.
 *
 * SSE grammar (Epoch 12 / M12): lines split on CRLF/LF/CR, events delimited
 * by a blank line, `:` comments and non-data fields ignored, multiline
 * `data:` joined with `\n` after removing at most one leading space. Semantic
 * data is never `.trim()`ed beyond that single space.
 */
export function parseSseOrJson(text: string): JsonRpcResponse[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (!looksLikeSse(trimmed)) {
    return [JSON.parse(trimmed) as JsonRpcResponse]
  }
  const out: JsonRpcResponse[] = []
  // Split lines on all three SSE line endings first; blank lines delimit.
  const lines = text.split(/\r\n|\r|\n/)
  let block: string[] = []
  const flush = () => {
    if (block.length > 0) {
      const data = eventData(block)
      if (data !== null) {
        try {
          out.push(JSON.parse(data) as JsonRpcResponse)
        } catch {
          // Unparseable event data is ignored; a missing match surfaces as
          // an explicit no-match downstream, never as a wrong-id completion.
        }
      }
    }
    block = []
  }
  for (const line of lines) {
    if (line === '') {
      flush()
    } else {
      block.push(line)
    }
  }
  flush()
  return out
}

function looksLikeSse(trimmed: string): boolean {
  return (
    trimmed.startsWith('event:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith(':') ||
    trimmed.startsWith('id:') ||
    trimmed.startsWith('retry:')
  )
}

/** Joins one event block's data lines, or null when the block has no data. */
function eventData(block: string[]): string | null {
  const parts: string[] = []
  for (const line of block) {
    if (line.startsWith(':')) continue
    if (line === 'data') {
      parts.push('')
      continue
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5)
      if (value.startsWith(' ')) value = value.slice(1)
      parts.push(value)
      continue
    }
    // event:, id:, retry: and unknown fields are ignored.
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/**
 * Extracts the payload matching our request id. Notifications and another
 * id's error never complete this call: a missing match returns undefined and
 * the caller fails honestly instead of adopting an unrelated error.
 */
export function pickResponse(payloads: JsonRpcResponse[], id: number): JsonRpcResponse | undefined {
  return payloads.find((p) => p.id === id)
}
