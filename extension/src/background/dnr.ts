export const ORIGIN_STRIP_RULE_ID = 1

type DnrRule = chrome.declarativeNetRequest.Rule

/**
 * The load-bearing rule (RESEARCH §2.1): mcp.notion.com rejects authenticated
 * requests carrying a chrome-extension:// Origin with 403 Invalid Origin, and
 * fetch() cannot remove forbidden headers — only declarativeNetRequest can.
 * Dynamic (not static) because initiatorDomains must reference chrome.runtime.id.
 */
export function buildOriginStripRule(extensionId: string): DnrRule {
  return {
    id: ORIGIN_STRIP_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as const,
      requestHeaders: [{ header: 'origin', operation: 'remove' as const }],
    },
    condition: {
      initiatorDomains: [extensionId],
      requestDomains: ['mcp.notion.com'],
      resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
    },
  }
}

/** True when a rule with our id is installed, enabled, and strips the Origin header. */
export function originStripRuleIsActive(rules: DnrRule[]): boolean {
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
