export const ORIGIN_STRIP_RULE_ID = 1

/** Exact HTTPS MCP endpoint. The rule must match only this, never any path. */
export const MCP_ENDPOINT = 'https://mcp.notion.com/mcp'

/**
 * Exact endpoint scope (Epoch 13 / M13): pins the scheme, host, and `/mcp`
 * path with deliberate query handling (`?...` allowed, other paths denied).
 * Suffix lookalikes (`mcp.notion.com.evil.com`), other hosts, non-HTTPS, and
 * sibling paths (`/mcp-extra`, `/mcp/other`) never match.
 */
export const DNR_ENDPOINT_REGEX = '^https://mcp\\.notion\\.com/mcp(\\?.*)?$'

const DNR_ENDPOINT_PATTERN = new RegExp(DNR_ENDPOINT_REGEX)

type DnrRule = chrome.declarativeNetRequest.Rule

/**
 * The load-bearing rule (RESEARCH §2.1): mcp.notion.com rejects authenticated
 * requests carrying a chrome-extension:// Origin with `403 Invalid Origin`,
 * and fetch() cannot remove forbidden headers — only declarativeNetRequest
 * can. Dynamic (not static) because the condition needs chrome.runtime.id.
 *
 * Scope is exactly one narrow rule: this extension as initiator, the exact
 * MCP endpoint URL, xmlhttprequest only. No fallback variants broaden scope
 * for availability (M13).
 */
export function buildOriginStripRule(extensionId: string): DnrRule {
  return {
    id: ORIGIN_STRIP_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'origin', operation: 'remove' }],
    },
    condition: {
      initiatorDomains: [extensionId],
      regexFilter: DNR_ENDPOINT_REGEX,
      resourceTypes: ['xmlhttprequest'],
    },
  } as DnrRule
}

/** True only for the exact endpoint URL (query string allowed, nothing else). */
export function matchesMcpEndpoint(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false
  // Fast ASCII pre-check keeps the regex anchored and cheap; the regex itself
  // is the authority for host/path/query boundaries.
  if (!rawUrl.startsWith('https://mcp.notion.com/mcp')) return false
  return DNR_ENDPOINT_PATTERN.test(rawUrl)
}

/** Strict equality for the installed rule: initiator, endpoint, and type. */
export function isExpectedOriginStripRule(rule: DnrRule, extensionId: string): boolean {
  if (!rule || rule.id !== ORIGIN_STRIP_RULE_ID) return false
  if ((rule as { enabled?: boolean }).enabled === false) return false
  const action = rule.action as
    | { type?: string; requestHeaders?: Array<{ header?: string; operation?: string }> }
    | undefined
  if (action?.type !== 'modifyHeaders') return false
  const headers = action.requestHeaders ?? []
  if (
    !headers.some((h) => (h.header ?? '').toLowerCase() === 'origin' && h.operation === 'remove')
  ) {
    return false
  }
  const condition = rule.condition as
    | {
        initiatorDomains?: string[]
        regexFilter?: string
        urlFilter?: string
        requestDomains?: string[]
        resourceTypes?: string[]
      }
    | undefined
  if (!condition) return false
  if (!Array.isArray(condition.initiatorDomains) || condition.initiatorDomains.length !== 1) return false
  if (condition.initiatorDomains[0] !== extensionId) return false
  // Endpoint scope must be the exact regex. A bare requestDomains entry would
  // cover every path on the host, so it is not accepted on its own.
  if (condition.regexFilter !== DNR_ENDPOINT_REGEX) return false
  if (!Array.isArray(condition.resourceTypes) || condition.resourceTypes.length !== 1) return false
  if (condition.resourceTypes[0] !== 'xmlhttprequest') return false
  return true
}

export interface OriginStripStatus {
  /** Narrow rule is installed and equality-verified. */
  installed: boolean
  /**
   * Authenticated endpoint compatibility acceptance. Always false from this
   * module: only the owner's authorized MCP initialize (Notion facade) can
   * establish it. Pre-OAuth callers must treat installed/unverified as
   * "endpoint ready, not yet accepted" — never as header-removal proof.
   */
  verified: boolean
  /** Legacy alias for installed (pre-OAuth gate). Prefer `installed`. */
  active: boolean
  reason?: string
}

/**
 * Authenticated acceptance discriminator (Epoch 13 / M13): only an
 * affirmative accepted protocol response (HTTP 200 + valid envelope)
 * verifies the scoped connection. 401, 403, 429, 5xx, redirects, malformed
 * protocol envelopes, missing statuses, and lookup exceptions are all
 * "not verified" — an ordinary 401 in particular proves nothing about
 * header stripping, because authentication runs before the Origin check.
 */
export function isAuthenticatedAcceptance(input: { ok: boolean; status?: number }): boolean {
  return input.ok === true && input.status === 200
}

/** Removes the known Nox rule without installing any broader replacement. */
export async function removeOriginStripRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ORIGIN_STRIP_RULE_ID],
    addRules: [],
  })
}

/**
 * Installs the single narrow rule and verifies installation equality.
 * Called at SW startup and before every connect attempt.
 *
 * This is endpoint compatibility acceptance preparation, not direct
 * observation of a removed header: it proves the narrow rule is installed,
 * not that the header was stripped. Stripping is established later by the
 * owner's authenticated MCP initialize; actual header scope across Chrome
 * families/versions remains a supported-Chrome integration test (C15).
 * Sends no tokens and performs no network probe.
 */
export async function ensureOriginStripRule(): Promise<OriginStripStatus> {
  const extensionId = chrome.runtime.id
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ORIGIN_STRIP_RULE_ID],
      addRules: [buildOriginStripRule(extensionId)],
    })
  } catch (e) {
    // Unsupported installation: remove the known rule and report a
    // compatibility failure instead of broadening scope for availability.
    try {
      await removeOriginStripRule()
    } catch {
      // Best effort; the status below already reports not-installed.
    }
    console.error('[nox] origin-strip narrow rule unsupported in this Chrome', e)
    return { installed: false, verified: false, active: false, reason: 'dnr-unsupported' }
  }
  let installed = false
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules()
    installed = rules.some((r) => isExpectedOriginStripRule(r, extensionId))
  } catch (e) {
    console.error('[nox] origin-strip rule lookup failed', e)
    return { installed: false, verified: false, active: false, reason: 'lookup-failed' }
  }
  if (!installed) {
    console.error('[nox] origin-strip narrow rule did not install as expected')
    return { installed: false, verified: false, active: false, reason: 'mismatch' }
  }
  return { installed: true, verified: false, active: true }
}

/**
 * True when the narrow rule for this extension is installed, enabled, and
 * strips Origin — with full initiator/endpoint/type equality, not merely id
 * plus remove-Origin action. Requires the owning extension id.
 */
export function originStripRuleIsActive(
  rules: chrome.declarativeNetRequest.Rule[],
  extensionId?: string,
): boolean {
  if (extensionId === undefined) {
    // Legacy loose check (tests only): id plus Origin removal. Production
    // always passes the extension id for the strict equality path below.
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
  return rules.some((r) => isExpectedOriginStripRule(r, extensionId))
}
