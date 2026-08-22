/**
 * Reassembles chunk/chunkEnd framed envelopes (bridge/PROTOCOL.md).
 * Pure logic — no chrome.* — so it is unit-testable.
 */
export interface ChunkFrame {
  t: 'chunk'
  id: number
  data: string
}

export interface ChunkEndFrame {
  t: 'chunkEnd'
  id: number
  totalChars: number
  chunks: number
}

export type AssemblerResult =
  | { kind: 'complete'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'waiting' }

export class ChunkAssembler {
  private readonly parts = new Map<number, string[]>()

  push(frame: ChunkFrame | ChunkEndFrame): AssemblerResult {
    if (frame.t === 'chunk') {
      const list = this.parts.get(frame.id) ?? []
      list.push(frame.data)
      this.parts.set(frame.id, list)
      return { kind: 'waiting' }
    }
    const list = this.parts.get(frame.id)
    this.parts.delete(frame.id)
    if (!list) return { kind: 'error', message: `chunkEnd for unknown chunk id ${frame.id}` }
    const text = list.join('')
    if (text.length !== frame.totalChars) {
      return {
        kind: 'error',
        message: `chunk ${frame.id}: assembled ${text.length} chars, expected ${frame.totalChars}`,
      }
    }
    return { kind: 'complete', text }
  }

  /** Drops a partial reassembly (e.g. after a port reconnect). */
  reset(): void {
    this.parts.clear()
  }

  get pendingCount(): number {
    return this.parts.size
  }
}
