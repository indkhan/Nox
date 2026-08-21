import { describe, expect, it } from 'vitest'
import { CapabilityGate, parseSelfResult } from '../src/lib/notion/capabilities'

const SELF_SAMPLE = `# Acme Corp Workspace

**Workspace**: Acme Corp
Hi, Dana — welcome back.
dana@acme.com

## current_tool_access
\`\`\`json
{
  "notion-search": "available",
  "notion-fetch": "available",
  "notion-query-data-sources": "available_with_limit",
  "notion-query-meeting-notes": "upgrade_required",
  "notion-create-comment": "not_enabled"
}
\`\`\`
`

describe('parseSelfResult', () => {
  it('extracts the capability map', () => {
    const { access } = parseSelfResult(SELF_SAMPLE)
    expect(access['notion-search']).toBe('available')
    expect(access['notion-query-data-sources']).toBe('available_with_limit')
    expect(access['notion-query-meeting-notes']).toBe('upgrade_required')
    expect(access['notion-create-comment']).toBe('not_enabled')
  })

  it('extracts identity fields when present', () => {
    const { identity } = parseSelfResult(SELF_SAMPLE)
    expect(identity.workspaceName).toContain('Acme')
    expect(identity.userName).toBe('Dana')
    expect(identity.email).toBe('dana@acme.com')
  })

  it('tolerates a missing capability block entirely', () => {
    const parsed = parseSelfResult('# Just a page\n\nHello.')
    expect(parsed.access).toEqual({})
    expect(parsed.identity.workspaceName).toBeUndefined()
  })
})

describe('CapabilityGate', () => {
  it('fails open when the server sent no map', () => {
    const gate = new CapabilityGate()
    expect(gate.isEmpty).toBe(true)
    expect(gate.can('anything').allowed).toBe(true)
  })

  it('allows available and limited tools, with reasons for limits', () => {
    const gate = new CapabilityGate({
      'notion-search': 'available',
      'notion-query-data-sources': 'available_with_limit',
    })
    expect(gate.can('notion-search')).toMatchObject({ allowed: true })
    const limited = gate.can('notion-query-data-sources')
    expect(limited.allowed).toBe(true)
    expect(limited.reason).toMatch(/plan/)
  })

  it('blocks upgrade_required and not_enabled with explanations', () => {
    const gate = new CapabilityGate({
      'notion-query-meeting-notes': 'upgrade_required',
      'notion-create-comment': 'not_enabled',
    })
    expect(gate.can('notion-query-meeting-notes')).toMatchObject({ allowed: false })
    expect(gate.can('notion-create-comment')).toMatchObject({ allowed: false })
  })

  it('lists tools by state for the limitations panel', () => {
    const gate = new CapabilityGate({
      a: 'upgrade_required',
      b: 'upgrade_required',
      c: 'not_enabled',
    })
    expect(gate.toolsWith('upgrade_required').sort()).toEqual(['a', 'b'])
    expect(gate.toolsWith('not_enabled')).toEqual(['c'])
  })

  it('reports unknown state for tools absent from the map', () => {
    const gate = new CapabilityGate({ 'notion-search': 'available' })
    expect(gate.can('notion-move-pages')).toMatchObject({ allowed: true, state: 'unknown' })
  })
})
