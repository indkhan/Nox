import { describe, expect, it } from 'vitest'
import { CapabilityGate, parseSelfResult } from '../src/lib/notion/capabilities'

/** Fixture mirrors the VERIFIED production shape (2026-08-22), with synthetic identity. */
const SELF_JSON = JSON.stringify({
  metadata: { type: 'self' },
  title: "Ada's Notion",
  url: 'https://app.notion.com',
  text: '# Ada\'s Notion\n\n- Workspace name: Ada\'s Notion\n- User: Ada Lovelace (ada@example.com)\n\nTool access on this workspace\'s plan (all other tools are available):\n- query_meeting_notes: upgrade_required',
  self: {
    workspace: { id: '11111111-2222-3333-4444-555555555555', name: "Ada's Notion" },
    user: { type: 'person', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Ada Lovelace', email: 'ada@example.com' },
    current_tool_access: {
      search: { status: 'available' },
      fetch: { status: 'available' },
      create_pages: { status: 'available' },
      update_page: { status: 'available' },
      move_pages: { status: 'available' },
      duplicate_page: { status: 'available' },
      query_data_sources: {
        status: 'available_with_limit',
        upgrade_url: 'https://app.notion.com/checkout?tool=query_data_sources',
      },
      query_meeting_notes: {
        status: 'upgrade_required',
        upgrade_url: 'https://app.notion.com/checkout?tool=query_meeting_notes',
      },
    },
  },
})

describe('parseSelfResult', () => {
  it('parses the verified JSON payload', () => {
    const parsed = parseSelfResult(SELF_JSON)
    expect(parsed.identity).toMatchObject({
      workspaceName: "Ada's Notion",
      workspaceId: '11111111-2222-3333-4444-555555555555',
      userName: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    expect(parsed.access['search']).toBe('available')
    expect(parsed.access['query-data-sources']).toBe('available_with_limit')
    expect(parsed.access['query-meeting-notes']).toBe('upgrade_required')
    expect(parsed.upgradeUrls['query-meeting-notes']).toMatch(/checkout/)
  })

  it('tolerates plain text without structured self data', () => {
    const parsed = parseSelfResult('# Just a page\n\nHello.')
    expect(parsed.identity.workspaceName).toBeUndefined()
    expect(parsed.access).toEqual({})
  })

  it('falls back to the legacy markdown capability block', () => {
    const legacy = `current_tool_access:\n"notion-search": "available"\n"notion-fetch": "not_enabled"`
    const parsed = parseSelfResult(legacy)
    expect(parsed.access['search']).toBe('available')
    expect(parsed.access['fetch']).toBe('not_enabled')
  })
})

describe('CapabilityGate', () => {
  it('fails open when the server sent no map', () => {
    const gate = new CapabilityGate()
    expect(gate.isEmpty).toBe(true)
    expect(gate.can('anything').allowed).toBe(true)
  })

  it('normalizes prefix and separator variants on lookups', () => {
    const gate = new CapabilityGate({ 'update-page': 'upgrade_required', search: 'available' })
    expect(gate.can('notion-search').state).toBe('available')
    expect(gate.can('update_page').allowed).toBe(false)
    expect(gate.can('notion-update-page').allowed).toBe(false)
  })

  it('allows limited tools with a reason and blocks gated tools', () => {
    const gate = new CapabilityGate({
      query_data_sources: 'available_with_limit',
      query_meeting_notes: 'upgrade_required',
    })
    expect(gate.can('notion-query-data-sources')).toMatchObject({ allowed: true })
    expect(gate.can('notion-query-data-sources').reason).toMatch(/plan/)
    expect(gate.can('notion-query-meeting-notes')).toMatchObject({ allowed: false })
  })

  it('lists unprefixed tools by state for the limitations panel', () => {
    const gate = new CapabilityGate({ a: 'upgrade_required', b: 'upgrade_required', c: 'not_enabled' })
    expect(gate.toolsWith('upgrade_required').sort()).toEqual(['a', 'b'])
    expect(gate.toolsWith('not_enabled')).toEqual(['c'])
  })

  it('reports unknown state for tools absent from the map', () => {
    const gate = new CapabilityGate({ search: 'available' })
    expect(gate.can('notion-move-pages')).toMatchObject({ allowed: true, state: 'unknown' })
  })
})
