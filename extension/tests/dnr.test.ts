import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOriginStripRule,
  ensureOriginStripRule,
  isAuthenticatedAcceptance,
  isExpectedOriginStripRule,
  matchesMcpEndpoint,
  originStripRuleIsActive,
  removeOriginStripRule,
} from '../src/background/dnr'

describe('buildOriginStripRule (Epoch 13 / M13)', () => {
  it('targets only our own requests to the exact MCP endpoint and strips Origin', () => {
    const rule = buildOriginStripRule('ext-id-123')
    expect(rule.id).toBe(1)
    expect(rule.priority).toBe(1)
    // Initiator scope is always present: no variant may drop it for availability.
    expect(rule.condition.initiatorDomains).toEqual(['ext-id-123'])
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest'])
    // Exact endpoint scope: regexFilter pins https://mcp.notion.com/mcp with
    // deliberate query handling. requestDomains alone would cover any path.
    const cond = rule.condition as { regexFilter?: string; urlFilter?: string; requestDomains?: string[] }
    const pattern = cond.regexFilter ?? cond.urlFilter ?? ''
    expect(pattern.length).toBeGreaterThan(0)
    expect(matchesMcpEndpoint('https://mcp.notion.com/mcp')).toBe(true)
    expect(rule.action.requestHeaders).toEqual([{ header: 'origin', operation: 'remove' }])
  })

  it('is bound to the given extension id (not a wildcard)', () => {
    const a = buildOriginStripRule('aaa')
    const b = buildOriginStripRule('bbb')
    expect(a.condition.initiatorDomains).toEqual(['aaa'])
    expect(b.condition.initiatorDomains).toEqual(['bbb'])
  })

  it('keeps resource types narrow (xmlhttprequest only)', () => {
    const rule = buildOriginStripRule('ext-id-123')
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest'])
  })
})

describe('MCP endpoint scope (Epoch 13 / M13)', () => {
  it('accepts the exact endpoint with and without a query string', () => {
    expect(matchesMcpEndpoint('https://mcp.notion.com/mcp')).toBe(true)
    expect(matchesMcpEndpoint('https://mcp.notion.com/mcp?foo=bar')).toBe(true)
  })

  it('rejects other paths on the same host', () => {
    expect(matchesMcpEndpoint('https://mcp.notion.com/')).toBe(false)
    expect(matchesMcpEndpoint('https://mcp.notion.com/mcp-extra')).toBe(false)
    expect(matchesMcpEndpoint('https://mcp.notion.com/mcp/other')).toBe(false)
    expect(matchesMcpEndpoint('https://mcp.notion.com/other')).toBe(false)
  })

  it('rejects suffix lookalikes and other hosts', () => {
    expect(matchesMcpEndpoint('https://mcp.notion.com.evil.com/mcp')).toBe(false)
    expect(matchesMcpEndpoint('https://evil-mcp.notion.com/mcp')).toBe(false)
    expect(matchesMcpEndpoint('https://mcp.notion.com.evil.com/')).toBe(false)
    expect(matchesMcpEndpoint('https://example.com/mcp')).toBe(false)
  })

  it('rejects non-HTTPS and malformed URLs', () => {
    expect(matchesMcpEndpoint('http://mcp.notion.com/mcp')).toBe(false)
    expect(matchesMcpEndpoint('not a url')).toBe(false)
    expect(matchesMcpEndpoint('')).toBe(false)
  })
})

describe('isExpectedOriginStripRule (Epoch 13 / M13)', () => {
  it('accepts the exact narrow rule for the owning extension', () => {
    expect(isExpectedOriginStripRule(buildOriginStripRule('ext-1'), 'ext-1')).toBe(true)
  })

  it('rejects foreign initiators', () => {
    expect(isExpectedOriginStripRule(buildOriginStripRule('ext-1'), 'ext-2')).toBe(false)
  })

  it('rejects rules missing initiator scope', () => {
    const rule = buildOriginStripRule('ext-1')
    const withoutInitiator = {
      ...rule,
      condition: { ...(rule.condition as object), initiatorDomains: undefined },
    } as chrome.declarativeNetRequest.Rule
    expect(isExpectedOriginStripRule(withoutInitiator, 'ext-1')).toBe(false)
  })

  it('rejects broadened endpoint scope', () => {
    const broad = {
      ...buildOriginStripRule('ext-1'),
      condition: { initiatorDomains: ['ext-1'], requestDomains: ['mcp.notion.com'], resourceTypes: ['xmlhttprequest'] },
    } as unknown as chrome.declarativeNetRequest.Rule
    expect(isExpectedOriginStripRule(broad, 'ext-1')).toBe(false)
  })

  it('rejects broadened resource types', () => {
    const rule = buildOriginStripRule('ext-1')
    const broad = {
      ...rule,
      condition: { ...(rule.condition as object), resourceTypes: ['xmlhttprequest', 'main_frame'] },
    } as chrome.declarativeNetRequest.Rule
    expect(isExpectedOriginStripRule(broad, 'ext-1')).toBe(false)
  })
})

describe('isAuthenticatedAcceptance (Epoch 13 / M13)', () => {
  it('accepts only an affirmative accepted protocol response', () => {
    expect(isAuthenticatedAcceptance({ ok: true, status: 200 })).toBe(true)
  })

  it('rejects 401, 403, 429, and 5xx as verification success', () => {
    expect(isAuthenticatedAcceptance({ ok: false, status: 401 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: 403 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: 429 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: 500 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: 503 })).toBe(false)
  })

  it('rejects redirects, malformed protocol, missing status, and lookup exceptions', () => {
    expect(isAuthenticatedAcceptance({ ok: false, status: 302 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: 307 })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false })).toBe(false)
    expect(isAuthenticatedAcceptance({ ok: false, status: undefined })).toBe(false)
  })

  it('rejects 200 without ok (malformed envelope)', () => {
    expect(isAuthenticatedAcceptance({ ok: false, status: 200 })).toBe(false)
  })
})

describe('ensureOriginStripRule (Epoch 13 / M13)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  function stubChrome(installed: chrome.declarativeNetRequest.Rule[], updateImpl?: () => Promise<void>) {
    const updateDynamicRules = vi.fn(async () => updateImpl?.())
    const getDynamicRules = vi.fn(async () => installed)
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-1' },
      declarativeNetRequest: { updateDynamicRules, getDynamicRules },
    })
    return { updateDynamicRules, getDynamicRules }
  }

  it('installs the narrow rule and reports installed/unverified before OAuth', async () => {
    const expected = buildOriginStripRule('ext-1')
    stubChrome([expected])
    const status = await ensureOriginStripRule()
    expect(status.installed).toBe(true)
    // Pre-OAuth: installation only. Authenticated acceptance comes later via
    // the owner's authorized MCP initialize; never from an unauthenticated 401.
    expect(status.verified).toBe(false)
  })

  it('removes the rule and reports compatibility failure when installation throws', async () => {
    const updateDynamicRules = vi.fn()
      .mockRejectedValueOnce(new Error('unsupported'))
      .mockResolvedValueOnce(undefined)
    const getDynamicRules = vi.fn(async () => [])
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-1' },
      declarativeNetRequest: { updateDynamicRules, getDynamicRules },
    })
    const status = await ensureOriginStripRule()
    expect(status.installed).toBe(false)
    expect(status.verified).toBe(false)
    // Cleanup: the known Nox rule must not be left installed on total failure.
    expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [1], addRules: [] })
  })

  it('reports not-installed when the installed rule does not equal the narrow rule', async () => {
    const foreign = buildOriginStripRule('other-ext')
    stubChrome([foreign])
    const status = await ensureOriginStripRule()
    // Equality (initiator + endpoint + type), not merely id + Origin action.
    expect(status.installed).toBe(false)
    expect(status.verified).toBe(false)
  })

  it('removeOriginStripRule clears the known rule without broadening scope', async () => {
    const updateDynamicRules = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-1' },
      declarativeNetRequest: { updateDynamicRules, getDynamicRules: vi.fn(async () => []) },
    })
    await removeOriginStripRule()
    expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [1], addRules: [] })
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
