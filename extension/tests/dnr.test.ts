import { buildOriginStripRule, originStripRuleIsActive } from '../src/background/dnr'
import { describe, expect, it } from 'vitest'

describe('buildOriginStripRule', () => {
  it('targets only our own requests to mcp.notion.com and strips Origin', () => {
    const rule = buildOriginStripRule('ext-id-123')
    expect(rule.id).toBe(1)
    expect(rule.priority).toBe(1)
    expect(rule.condition).toEqual({
      initiatorDomains: ['ext-id-123'],
      requestDomains: ['mcp.notion.com'],
      resourceTypes: ['xmlhttprequest'],
    })
    expect(rule.action.requestHeaders).toEqual([{ header: 'origin', operation: 'remove' }])
  })

  it('is bound to the given extension id (not a wildcard)', () => {
    const a = buildOriginStripRule('aaa')
    const b = buildOriginStripRule('bbb')
    expect(a.condition.initiatorDomains).toEqual(['aaa'])
    expect(b.condition.initiatorDomains).toEqual(['bbb'])
  })
})

function rule(over: Record<string, unknown> & { id?: number }): chrome.declarativeNetRequest.Rule {
  return {
    id: 1,
    priority: 1,
    condition: {},
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'origin', operation: 'remove' }],
    },
    ...over,
  } as unknown as chrome.declarativeNetRequest.Rule
}

describe('originStripRuleIsActive', () => {
  it('accepts the exact rule', () => {
    expect(originStripRuleIsActive([rule({})])).toBe(true)
  })

  it('rejects wrong id', () => {
    expect(originStripRuleIsActive([rule({ id: 7 })])).toBe(false)
  })

  it('rejects disabled rule', () => {
    expect(originStripRuleIsActive([rule({ enabled: false })])).toBe(false)
  })

  it('rejects rules that modify something other than Origin removal', () => {
    const r = rule({
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'remove' }],
      },
    })
    expect(originStripRuleIsActive([r])).toBe(false)
  })

  it('passes when the rule sits among unrelated rules', () => {
    const others = [
      rule({ id: 5, action: { type: 'block' } as chrome.declarativeNetRequest.RuleAction }),
      rule({ id: 9, priority: 2 }),
    ]
    expect(originStripRuleIsActive([...others, rule({})])).toBe(true)
  })

  it('fails loudly on an empty rule set', () => {
    expect(originStripRuleIsActive([])).toBe(false)
  })
})
