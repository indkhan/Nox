/**
 * Reassembles chunk/chunkEnd framed envelopes (bridge/PROTOCOL.md).
 * Pure logic — no chrome.* — so it is unit-testable.
 *
 * Bounds (Epoch 12 / M12): at most 8 active assemblies, 256 chunks per
 * assembly, 512 KiB UTF-16 units / 1 MiB conservative bytes per chunk, 32 MiB
 * conservative aggregate bytes, and a 30-second incomplete-assembly lifetime.
 * Byte budgets use `length * 3` as a conservative UTF-8 upper bound (1 unit is
 * at most 3 bytes; a surrogate pair is 2 units for 4 bytes), so no TextEncoder
 * allocation is needed. Host chunks are 256 Ki units (`SAFE_CHUNK`), which is
 * 768 KiB conservative — well under the per-chunk and aggregate caps,
 * including CJK/emoji expansion.
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

export const MAX_ACTIVE_ASSEMBLIES = 8
export const MAX_CHUNKS_PER_ASSEMBLY = 256
export const MAX_CHUNK_CHARS = 512 * 1024
export const MAX_CHUNK_BYTES = 1024 * 1024
export const MAX_AGGREGATE_BYTES = 32 * 1024 * 1024
export const ASSEMBLY_TTL_MS = 30_000

interface Assembly {
  parts: string[]
  bytes: number
  timer: ReturnType<typeof setTimeout>
}

/** Conservative UTF-8 byte upper bound for a JS string. */
function conservativeBytes(s: string): number {
  return s.length * 3
}

function isValidId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && Number.isFinite(id) && id >= 0
}

export class ChunkAssembler {
  private readonly assemblies = new Map<number, Assembly>()
  private aggregateBytes = 0

  push(frame: ChunkFrame | ChunkEndFrame): AssemblerResult {
    if (frame.t === 'chunk') {
      if (!isValidId((frame as { id?: unknown }).id) || typeof (frame as { data?: unknown }).data !== 'string') {
        return { kind: 'error', message: 'malformed chunk frame' }
      }
      const id = frame.id
      const data = frame.data
      if (data.length > MAX_CHUNK_CHARS || conservativeBytes(data) > MAX_CHUNK_BYTES) {
        this.drop(id)
        return { kind: 'error', message: `chunk ${id}: per-chunk budget exceeded` }
      }
      const existing = this.assemblies.get(id)
      if (!existing && this.assemblies.size >= MAX_ACTIVE_ASSEMBLIES) {
        return { kind: 'error', message: `too many active chunk assemblies` }
      }
      if (existing && existing.parts.length >= MAX_CHUNKS_PER_ASSEMBLY) {
        this.drop(id)
        return { kind: 'error', message: `chunk ${id}: too many chunks` }
      }
      const incoming = conservativeBytes(data)
      if (this.aggregateBytes + incoming > MAX_AGGREGATE_BYTES) {
        this.drop(id)
        return { kind: 'error', message: `chunk aggregate budget exceeded` }
      }
      if (existing) {
        existing.parts.push(data)
        existing.bytes += incoming
        this.aggregateBytes += incoming
        return { kind: 'waiting' }
      }
      const timer = setTimeout(() => {
        this.drop(id)
      }, ASSEMBLY_TTL_MS)
      // Under vitest fake timers the handle needs no ref; in production a
      // pending assembly must still expire even if no more frames arrive.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        try {
          ;(timer as { unref: () => void }).unref()
        } catch {
          // Browser/extension timers lack unref; expiry still fires.
        }
      }
      this.assemblies.set(id, { parts: [data], bytes: incoming, timer })
      this.aggregateBytes += incoming
      return { kind: 'waiting' }
    }
    if (frame.t === 'chunkEnd') {
      if (
        !isValidId((frame as { id?: unknown }).id) ||
        typeof (frame as { totalChars?: unknown }).totalChars !== 'number' ||
        !Number.isInteger(frame.totalChars) ||
        !Number.isFinite(frame.totalChars) ||
        (frame.totalChars as number) < 0 ||
        typeof (frame as { chunks?: unknown }).chunks !== 'number' ||
        !Number.isInteger(frame.chunks) ||
        !Number.isFinite(frame.chunks) ||
        (frame.chunks as number) < 0
      ) {
        return { kind: 'error', message: 'malformed chunkEnd frame' }
      }
      const asm = this.assemblies.get(frame.id)
      if (!asm) return { kind: 'error', message: `chunkEnd for unknown chunk id ${frame.id}` }
      const actualChunks = asm.parts.length
      if (actualChunks !== frame.chunks) {
        const id = frame.id
        this.drop(id)
        return { kind: 'error', message: `chunk ${id}: got ${actualChunks} chunks, expected ${frame.chunks}` }
      }
      const text = asm.parts.join('')
      if (text.length !== frame.totalChars) {
        const id = frame.id
        this.drop(id)
        return {
          kind: 'error',
          message: `chunk ${id}: assembled ${text.length} chars, expected ${frame.totalChars}`,
        }
      }
      this.drop(frame.id)
      return { kind: 'complete', text }
    }
    return { kind: 'error', message: 'malformed chunk frame' }
  }

  private drop(id: number): void {
    const asm = this.assemblies.get(id)
    if (!asm) return
    clearTimeout(asm.timer)
    this.aggregateBytes -= asm.bytes
    if (this.aggregateBytes < 0) this.aggregateBytes = 0
    this.assemblies.delete(id)
  }

  /** Drops a partial reassembly (e.g. after a port reconnect). */
  reset(): void {
    for (const [, asm] of this.assemblies) clearTimeout(asm.timer)
    this.assemblies.clear()
    this.aggregateBytes = 0
  }

  get pendingCount(): number {
    return this.assemblies.size
  }
}
