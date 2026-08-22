export const ORIGIN_STRIP_RULE_ID = 1

type DnrRule = chrome.declarativeNetRequest.Rule

/**
 * The load-bearing rule family (RESEARCH §2.1): mcp.notion.com rejects
 * authenticated requests carrying a chrome-extension:// Origin with
 * `403 Invalid Origin`, and fetch() cannot remove forbidden headers — only
 * declarativeNetRequest can. Dynamic (not static) because the condition needs
 * chrome.runtime.id.
 *
 * Chrome's handling of `initiatorDomains` for extension-initiated requests has
 * drifted across versions, so we keep several scoped variants and PROBE which
 * one actually strips the header in the running browser (see probe below).
 */
function baseRule(): Pick<DnrRule, 'id' | 'priority'> & {
  action: DnrRule['action']
} {
  return {
    id: ORIGIN_STRIP_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'origin', operation: 'remove' }],
    },
  }
}

export function buildOriginStripRule(extensionId: string): DnrRule {
  return {
    ...baseRule(),
    condition: {
      initiatorDomains: [extensionId],
      requestDomains: ['mcp.notion.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  } as DnrRule
}

/** Progressively looser — every variant still touches only mcp.notion.com. */
export const RULE_VARIANTS: Array<{ name: string; build: (extensionId: string) => DnrRule }> = [
  { name: 'initiator+request+type', build: buildOriginStripRule },
  {
    name: 'request+type',
    build: () =>
      ({
        ...baseRule(),
        condition: { requestDomains: ['mcp.notion.com'], resourceTypes: ['xmlhttprequest'] },
      }) as DnrRule,
  },
  {
    name: 'initiator+request',
    build: (extensionId: string) =>
      ({
        ...baseRule(),
        condition: { initiatorDomains: [extensionId], requestDomains: ['mcp.notion.com'] },
      }) as DnrRule,
  },
  {
    name: 'request-only',
    build: () =>
      ({
        ...baseRule(),
        condition: { requestDomains: ['mcp.notion.com'] },
      }) as DnrRule,
  },
]

export interface OriginStripStatus {
  active: boolean
  variant?: string
  /** 'stripped' = our probe came back without an Origin rejection. */
  probe?: 'stripped' | 'present' | 'network-error'
}

const PROBE_URL = 'https://mcp.notion.com/mcp'

/**
 * Canary: an UNAUTHENTICATED POST tells us whether our Origin leaked.
 *   401 (missing token)          → Origin absent → rule works
 *   403 "Invalid Origin"         → Origin leaked → rule not applying
 * Auth runs before the Origin check (RESEARCH §2.1), which is what makes this
 * an exact discriminator without spending any quota.
 */
export async function probeOriginStripped(): Promise<OriginStripStatus['probe']> {
  try {
    const res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'notifications/initialized' }),
    })
    if (res.status === 403) return 'present'
    return 'stripped'
  } catch {
    return 'network-error'
  }
}

/**
 * Installs the first variant that verifiably strips our own Origin. Called at
 * SW startup and before every connect attempt.
 */
export async function ensureOriginStripRule(): Promise<OriginStripStatus> {
  const extensionId = chrome.runtime.id
  let lastError: unknown = null
  for (const variant of RULE_VARIANTS) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ORIGIN_STRIP_RULE_ID],
        addRules: [variant.build(extensionId)],
      })
      const probe = await probeOriginStripped()
      if (probe === 'stripped') {
        console.log(`[nox] origin-strip variant "${variant.name}" verified working`)
        return { active: true, variant: variant.name, probe }
      }
      console.warn(`[nox] origin-strip variant "${variant.name}" did not strip (probe=${probe}), trying next`)
    } catch (e) {
      lastError = e
      console.error(`[nox] origin-strip variant "${variant.name}" failed to install`, e)
    }
  }
  if (lastError) console.error('[nox] all origin-strip variants failed', lastError)
  return { active: false, probe: 'network-error' }
}

/** True when a rule with our id is installed, enabled, and strips the Origin header. */
export function originStripRuleIsActive(rules: chrome.declarativeNetRequest.Rule[]): boolean {
  return rules.some(
    (r) =>
      r.id === ORIGIN_STRIP_RULE_ID &&
      (r as { enabled?: boolean }).enabled !== false &&
      r.action?.type === 'modifyHeaders' &&
      ((r.action as { requestHeaders?: Array<{ header?: string; operation?: string }> }).requestHeaders ?? []).some(
        (h) => (h.header ?? '').toLowerCase() === 'origin' && h.operation === 'remove',
      ),
  )
}
