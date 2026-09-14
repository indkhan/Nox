import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ChunkAssembler } from '../../src/lib/codex/frame'

describe('ChunkAssembler bounds (Epoch 12 / M12)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects chunkEnd with the wrong chunk count', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 1, data: 'hel' })
    asm.push({ t: 'chunk', id: 1, data: 'lo' })
    const out = asm.push({ t: 'chunkEnd', id: 1, totalChars: 5, chunks: 100 })
    expect(out.kind).toBe('error')
  })

  it('rejects malformed frames without coercion', () => {
    const asm = new ChunkAssembler()
    expect(asm.push({ t: 'chunk', id: '1' as never, data: 'x' }).kind).toBe('error')
    expect(asm.push({ t: 'chunk', id: 2, data: 123 as never }).kind).toBe('error')
    expect(asm.push({ t: 'chunkEnd', id: 3, totalChars: '1' as never, chunks: 1 }).kind).toBe('error')
    expect(asm.push({ t: 'chunkEnd', id: 3, totalChars: 0, chunks: 'x' as never }).kind).toBe('error')
  })

  it('bounds active assemblies at 8', () => {
    const asm = new ChunkAssembler()
    for (let id = 1; id <= 8; id++) {
      expect(asm.push({ t: 'chunk', id, data: 'x' }).kind).toBe('waiting')
    }
    expect(asm.push({ t: 'chunk', id: 9, data: 'x' }).kind).toBe('error')
    expect(asm.pendingCount).toBe(8)
  })

  it('bounds chunks per assembly at 256', () => {
    const asm = new ChunkAssembler()
    for (let i = 0; i < 256; i++) {
      expect(asm.push({ t: 'chunk', id: 1, data: 'x' }).kind).toBe('waiting')
    }
    expect(asm.push({ t: 'chunk', id: 1, data: 'x' }).kind).toBe('error')
  })

  it('bounds per-chunk data', () => {
    const asm = new ChunkAssembler()
    const big = 'x'.repeat(600 * 1024)
    expect(asm.push({ t: 'chunk', id: 1, data: big }).kind).toBe('error')
    expect(asm.pendingCount).toBe(0)
  })

  it('expires stale assemblies after 30s even with no further frames', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 1, data: 'partial' })
    expect(asm.pendingCount).toBe(1)
    vi.advanceTimersByTime(30_001)
    expect(asm.pendingCount).toBe(0)
    // A late end for the expired id fails and frees nothing else.
    expect(asm.push({ t: 'chunkEnd', id: 1, totalChars: 7, chunks: 1 }).kind).toBe('error')
  })

  it('reset disposes expiry state', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 1, data: 'x' })
    asm.reset()
    expect(asm.pendingCount).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(asm.pendingCount).toBe(0)
  })

  it('preserves multibyte content split across chunks', () => {
    const asm = new ChunkAssembler()
    const text = 'Grüße 中文 😀 € 𝄞'
    const mid = Math.floor(text.length / 2)
    asm.push({ t: 'chunk', id: 7, data: text.slice(0, mid) })
    asm.push({ t: 'chunk', id: 7, data: text.slice(mid) })
    const out = asm.push({ t: 'chunkEnd', id: 7, totalChars: text.length, chunks: 2 })
    expect(out).toEqual({ kind: 'complete', text })
  })

  it('releases memory on wrong total', () => {
    const asm = new ChunkAssembler()
    asm.push({ t: 'chunk', id: 5, data: 'abc' })
    const out = asm.push({ t: 'chunkEnd', id: 5, totalChars: 99, chunks: 1 })
    expect(out.kind).toBe('error')
    expect(asm.pendingCount).toBe(0)
  })
})
