/**
 * Parses `notion-fetch { id: 'self' }` output (RESEARCH §2.5).
 *
 * Verified against production (2026-08-22): the content is a JSON object with
 *   .title/.url/.text            human-readable mirror
 *   .self.workspace.{id,name}    workspace identity
 *   .self.user.{id,name,email}   user identity
 *   .self.current_tool_access    { "<unprefixed-tool>": { status, upgrade_url? } }
 * Tool keys arrive UNPREFIXED ("search", "update_page") while tools/list names
 * are prefixed ("notion-search"), so lookups normalize the prefix away.
 * Every field stays defensive/optional — Notion's MCP is Beta.
 */

export type AccessState = 'available' | 'available_with_limit' | 'upgrade_required' | 'not_enabled'

const VALID_STATES: readonly AccessState[] = [
  'available',
  'available_with_limit',
  'upgrade_required',
  'not_enabled',
]

export interface SelfInfo {
  identity: {
    workspaceName?: string
    workspaceId?: string
    userName?: string
    email?: string
  }
  /** Keyed by unprefixed short name AND prefixed name for convenience. */
  access: Record<string, AccessState>
  upgradeUrls: Record<string, string>
}

interface RawSelf {
  workspace?: { id?: string; name?: string }
  user?: { id?: string; name?: string; email?: string }
  current_tool_access?: Record<string, { status?: string; upgrade_url?: string }>
}

export function stripNotionPrefix(tool: string): string {
  return tool.startsWith('notion-') ? tool.slice(7) : tool
}

/**
 * Canonical tool key: unprefixed, hyphenated, case-folded — so
 * "notion-update-page", "update_page" and "Update.Page" all collide.
 */
export function canonicalTool(tool: string): string {
  return stripNotionPrefix(tool).toLowerCase().replaceAll(/[-_.]+/g, '-')
}

export function parseSelfResult(text: string): SelfInfo {
  const raw = extractRawSelf(text)
  const identity: SelfInfo['identity'] = {}
  const access: Record<string, AccessState> = {}
  const upgradeUrls: Record<string, string> = {}

  if (raw?.workspace?.name) identity.workspaceName = raw.workspace.name
  if (raw?.workspace?.id) identity.workspaceId = raw.workspace.id
  if (raw?.user?.name) identity.userName = raw.user.name
  if (raw?.user?.email) identity.email = raw.user.email

  for (const [tool, entry] of Object.entries(raw?.current_tool_access ?? {})) {
    const state = entry?.status as AccessState | undefined
    if (!state || !VALID_STATES.includes(state)) continue
    const key = canonicalTool(tool)
    access[key] = state
    if (entry.upgrade_url) upgradeUrls[key] = entry.upgrade_url
  }

  if (Object.keys(access).length === 0 && raw == null) {
    // Fallback: legacy markdown shape (spike-era).
    const blockMatch = text.match(/current_tool_access[\s\S]{0,4000}/)
    for (const [, tool, state] of (blockMatch?.[0] ?? '').matchAll(
      /"?([A-Za-z0-9_-]+)"?\s*:\s*"?(available_with_limit|upgrade_required|not_enabled|available)"?/g,
    )) {
      access[canonicalTool(tool)] = state as AccessState
    }
  }
  return { identity, access, upgradeUrls }
}

function extractRawSelf(text: string): RawSelf | null {
  let candidate: unknown = null
  try {
    candidate = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        candidate = JSON.parse(text.slice(start, end + 1))
      } catch {
        return null
      }
    }
  }
  if (candidate == null || typeof candidate !== 'object') return null
  // Production wraps identity + capabilities under a top-level "self" key.
  const inner = (candidate as Record<string, unknown>)['self']
  if (inner != null && typeof inner === 'object') return inner as RawSelf
  return candidate as RawSelf
}

/** Decides whether a tool may be offered/executed for this account. */
export class CapabilityGate {
  private readonly access: Record<string, AccessState>

  constructor(access: Record<string, AccessState> = {}) {
    // Canonicalize keys on the way in so any caller-provided spelling works.
    this.access = Object.fromEntries(Object.entries(access).map(([k, v]) => [canonicalTool(k), v]))
  }

  /** True when nothing is known (server did not send the map) — fail open. */
  get isEmpty(): boolean {
    return Object.keys(this.access).length === 0
  }

  can(tool: string): { allowed: boolean; state: AccessState | 'unknown'; reason?: string } {
    const key = canonicalTool(tool)
    const state = this.access[key]
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

  /** Canonical (unprefixed, hyphenated) tool names only. */
  toolsWith(state: AccessState): string[] {
    return [
      ...new Set(
        Object.entries(this.access)
          .filter(([, s]) => s === state)
          .map(([t]) => canonicalTool(t)),
      ),
    ]
  }
}
