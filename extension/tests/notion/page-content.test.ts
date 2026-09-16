import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizePageFetch,
  normalizePageText,
  requireCompleteBaseline,
  BaselineError,
} from '../../src/lib/notion/page-content'

const PAGE = 'a'.repeat(32)

/** Redacted synthetic provider shapes live under tests/fixtures/notion/. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`tests/fixtures/notion/${name}`, 'utf8'))
}

/** Wrap a JSON payload the way the MCP transport delivers page text. */
function textResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

describe('page-content normalization (Epoch 07)', () => {
  it('recognizes the complete plain fixture as a baseline', () => {
    const record = normalizePageFetch(PAGE, textResult(fixture('page-plain-complete.json')))
    expect(record).toMatchObject({ status: 'complete', shape: 'json-content' })
    expect(record.markdown).toBe('alpha\nbeta\ngamma')
    expect(record.truncated).toBe(false)
    expect(record.unknownBlockIds).toEqual([])
    expect(() => requireCompleteBaseline(record)).not.toThrow()
  })

  it('accepts plain-text payloads as complete while keeping rich completeness', () => {
    const plain = normalizePageText(PAGE, 'alpha\nbeta\ngamma')
    expect(plain).toMatchObject({ status: 'complete', shape: 'plain-text' })
    const rich = normalizePageFetch(PAGE, textResult(fixture('page-rich-complete.json')))
    expect(rich.status).toBe('complete')
    expect(rich.markdown).toContain('synced_block')
  })

  it('marks the partial fixture partial with its omitted block ids', () => {
    const record = normalizePageFetch(PAGE, textResult(fixture('page-partial.json')))
    expect(record.status).toBe('partial')
    expect(record.truncated).toBe(true)
    expect(record.unknownBlockIds).toHaveLength(1)
    // Partial content stays available for analysis …
    expect(record.markdown).toContain('alpha')
    // … but never authorizes replacement.
    expect(() => requireCompleteBaseline(record)).toThrowError(BaselineError)
    expect(() => requireCompleteBaseline(record)).toThrowError(/PARTIAL_BASELINE/)
    expect(() => requireCompleteBaseline(record)).toThrowError(/omitted block/)
  })

  it('rejects unavailable pages without a baseline', () => {
    expect(() => normalizePageFetch(PAGE, textResult(fixture('page-unavailable.json')))).toThrowError(/UNAVAILABLE_BASELINE/)
    expect(() => normalizePageText(PAGE, '   ')).toThrowError(/UNAVAILABLE_BASELINE/)
  })

  it('rejects tool-declared failures instead of snapshotting error text', () => {
    const envelope = fixture('fetch-tool-error.json') as { isError: boolean; content: Array<{ type: string; text?: string }> }
    expect(() => normalizePageFetch(PAGE, envelope)).toThrowError(/FETCH_FAILED/)
  })

  it('rejects identity and search wrappers as page baselines', () => {
    const identity = {
      title: 'Acme',
      self: { workspace: { id: 'w1', name: 'Acme' }, current_tool_access: { search: { status: 'available' } } },
    }
    expect(() => normalizePageFetch(PAGE, textResult(identity))).toThrowError(/WRAPPER_MISMATCH/)
    expect(() => normalizePageFetch(PAGE, textResult({ results: [{ id: PAGE }] }))).toThrowError(/WRAPPER_MISMATCH/)
    expect(() => normalizePageFetch(PAGE, textResult(['not', 'a', 'page']))).toThrowError(/WRAPPER_MISMATCH/)
  })

  it('treats locally truncated envelopes as partial, never complete', () => {
    const record = normalizePageText(PAGE, 'alpha\n…[truncated by Nox]')
    expect(record.status).toBe('partial')
    expect(() => requireCompleteBaseline(record)).toThrowError(/PARTIAL_BASELINE/)
  })
})
