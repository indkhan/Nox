import { describe, expect, it } from 'vitest'
import { classifyError } from '../src/lib/mcp/errors'
import { McpHttpError, McpRpcError } from '../src/lib/mcp/client'

describe('classifyError', () => {
  it('classifies 401 as unauthenticated with refresh guidance', () => {
    expect(classifyError(new McpHttpError(401, ''))).toMatchObject({
      kind: 'unauthenticated',
      retryable: false,
    })
  })

  it('detects the DNR-missing 403 Invalid Origin signature loudly', () => {
    const c = classifyError(new McpHttpError(403, '{"message":"Invalid Origin: ext-id"}'))
    expect(c.kind).toBe('dnr-missing')
    expect(c.userMessage).toMatch(/reload/i)
  })

  it('treats plain 403 permission errors as possible workspace mismatch', () => {
    expect(classifyError(new McpHttpError(403, 'access denied')).kind).toBe('workspace-mismatch')
  })

  it('classifies 429 as retryable rate-limiting', () => {
    expect(classifyError(new McpHttpError(429, '', 3)).retryable).toBe(true)
    expect(classifyError(new McpHttpError(429, '')).kind).toBe('rate-limited')
  })

  it('classifies 5xx and network failures as transient', () => {
    expect(classifyError(new McpHttpError(502, '')).kind).toBe('transient')
    expect(classifyError(new TypeError('Failed to fetch')).kind).toBe('transient')
  })

  it('classifies -32001 overload as transient/retryable', () => {
    const c = classifyError(new McpRpcError(-32001, 'Server overloaded; retry later'))
    expect(c).toMatchObject({ kind: 'transient', retryable: true })
  })

  it('recognizes plan-gated messages', () => {
    const c = classifyError(new McpRpcError(-32000, 'upgrade_required: SQL queries need Business plan'))
    expect(c.kind).toBe('plan-gated')
  })

  it('maps permission-denied to workspace mismatch with a friendly explanation', () => {
    const c = classifyError(new McpRpcError(-32000, 'permission denied for this page'))
    expect(c.kind).toBe('workspace-mismatch')
    expect(c.userMessage).toMatch(/different workspace/i)
    expect(c.modelMessage).not.toMatch(/\bundefined\b/)
  })

  it('wraps unknown errors without leaking undefined fields', () => {
    const c = classifyError(new Error('something odd'))
    expect(c.kind).toBe('unknown')
    expect(c.modelMessage).toContain('something odd')
  })

  it('never crashes on non-Error input', () => {
    expect(classifyError('boom').modelMessage).toContain('boom')
  })
})
