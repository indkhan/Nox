// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { ApprovalEngine } from '../src/lib/writes/approvals'
import { PlanEngine } from '../src/lib/architect/plan-engine'
import { recordRetrievals } from '../src/lib/agent/retrievals'
import { clearLogs, describeArgKeys, describeToolNames, detailedErrorText, formatLogs } from '../src/lib/log'

const SECRET = 'SECRET_VALUE_abc123'
const DB = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  clearLogs()
})

describe('verbose turn trace', () => {
  it('names arg keys without leaking values', () => {
    const line = describeArgKeys({ id: SECRET, query: SECRET })
    expect(line).toMatch(/id/)
    expect(line).toMatch(/query/)
    expect(line).not.toContain(SECRET)
  })

  it('bounds long key lists so logging stays O(1)', () => {
    const args: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) args[`k${i}`] = SECRET
    const line = describeArgKeys(args)
    expect(line).toMatch(/n=30/)
    expect(line).not.toContain(SECRET)
    expect(line.length).toBeLessThan(500)
  })

  it('names plan tools without leaking content', () => {
    const line = describeToolNames(['notion-update-data-source', 'notion-fetch'])
    expect(line).toMatch(/notion-update-data-source/)
    expect(line).not.toContain(SECRET)
  })

  it('traces approval request and user decision', async () => {
    const engine = new ApprovalEngine()
    const pending = engine.request(
      {
        name: 'notion-update-page',
        mutates: true,
        kind: 'properties',
        args: { page_id: SECRET },
        targets: ['p1'],
        parents: [],
        affectedCount: 1,
        grant: { allowed: false, pages: [] },
      },
      { action: 'require-approval', reasons: ['ask-before-changes mode is on'] },
    )
    expect(formatLogs()).toMatch(/Approval requested: notion-update-page/)
    expect(formatLogs()).not.toContain(SECRET)
    engine.answer(1, 'reject')
    await pending
    expect(formatLogs()).toMatch(/Approval 1 .* reject/)
    expect(formatLogs()).not.toContain(SECRET)
  })

  it('traces plan proposal and decision without leaking plan text', async () => {
    recordRetrievals('thread-trace', [DB])
    const engine = new PlanEngine()
    const pending = engine.request(
      {
        goal: `goal ${SECRET}`,
        recommendation: `rec ${SECRET}`,
        evidence: [{ id: DB, title: `title ${SECRET}`, kind: 'database', reason: 'inspected' }],
        operations: [{ tool: 'notion-update-data-source', targetId: DB, args: { data_source_id: DB }, summary: `sum ${SECRET}` }],
        consequences: [],
      },
      { workspaceId: 'ws', connectionGeneration: 'c', threadId: 'thread-trace', turnId: 't1' },
    )
    expect(formatLogs()).toMatch(/Plan proposed: 1 ops/)
    expect(formatLogs()).not.toContain(SECRET)
    engine.answer((engine as unknown as { pending: Map<string, unknown> })['pending'].keys().next().value as string, 'rejected')
    await pending
    expect(formatLogs()).toMatch(/Plan rejected/)
  })

  it('error detail carries the message behind the safe category', () => {
    const text = detailedErrorText(new Error('STEP_LIMIT_REACHED: 12 tool calls were made'))
    expect(text).toMatch(/STEP_LIMIT_REACHED/)
  })

  it('error detail redacts credentials and stays bounded', () => {
    const text = detailedErrorText(new Error(`boom Bearer ABCDEF123456 ${'x'.repeat(2000)}`))
    expect(text).not.toContain('ABCDEF123456')
    expect(text).toMatch(/Bearer \[redacted\]/)
    expect(text.length).toBeLessThan(500)
  })
})
