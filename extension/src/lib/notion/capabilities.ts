/**
 * Parses `notion-fetch { id: 'self' }` output (RESEARCH §2.5). Notion returns
 * this as markdown text whose exact layout is theirs to change, so every field
 * is extracted defensively and may stay undefined.
 */

export type AccessState = 'available' | 'available_with_limit' | 'upgrade_required' | 'not_enabled'

export interface SelfInfo {
  identity: {
    workspaceName?: string
    userName?: string
    email?: string
  }
  access: Record<string, AccessState>
}

export function parseSelfResult(text: string): SelfInfo {
  const access: Record<string, AccessState> = {}
  const accessMatch = text.match(/current_tool_access[\s\S]{0,4000}/)
  const haystack = accessMatch ? accessMatch[0] : ''
  for (const [, tool, state] of haystack.matchAll(
    /"?([A-Za-z0-9_-]+)"?\s*:\s*"?(available_with_limit|upgrade_required|not_enabled|available)"?/g,
  )) {
    // Skip obvious non-tools that happen to sit inside the block.
    if (['state', 'status', 'plan', 'value'].includes(tool)) continue
    access[tool] = state as AccessState
  }

  return { identity: extractIdentity(text), access }
}

function extractIdentity(text: string): SelfInfo['identity'] {
  const identity: SelfInfo['identity'] = {}
  const workspaceName = firstMatch(text, [
    /workspace[_\s-]?name"?\s*:\s*"([^"]{1,120})"/i,
    /\*\*Workspace\*\*\s*[:\-]?\s*(.+)/i,
  ])
  if (workspaceName) identity.workspaceName = workspaceName

  const userName = firstMatch(text, [
    /user[_\s-]?(?:first[_\s-]?)?name"?\s*:\s*"([^"]{1,80})"/i,
    /\b(?:Hi|Hello),?\s+([A-Z][a-z]+)\b/,
    /preferred[_\s-]?name"?\s*:\s*"([^"]{1,80})"/i,
  ])
  if (userName) identity.userName = userName

  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  if (email) identity.email = email[0]
  return identity
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m?.[1]) return m[1].trim()
  }
  return undefined
}

/** Decides whether a tool may be offered/executed for this account. */
export class CapabilityGate {
  constructor(private readonly access: Record<string, AccessState> = {}) {}

  /** True when nothing is known (server did not send the map) — fail open. */
  get isEmpty(): boolean {
    return Object.keys(this.access).length === 0
  }

  can(tool: string): { allowed: boolean; state: AccessState | 'unknown'; reason?: string } {
    const state = this.access[tool]
    if (!state) return { allowed: true, state: 'unknown' }
    switch (state) {
      case 'available':
        return { allowed: true, state }
      case 'available_with_limit':
        return { allowed: true, state, reason: 'limited by your Notion plan' }
      case 'upgrade_required':
        return { allowed: false, state, reason: 'requires a higher Notion plan' }
      case 'not_enabled':
        return { allowed: false, state, reason: 'not enabled for this connection' }
    }
  }

  toolsWith(state: AccessState): string[] {
    return Object.entries(this.access)
      .filter(([, s]) => s === state)
      .map(([t]) => t)
  }
}
