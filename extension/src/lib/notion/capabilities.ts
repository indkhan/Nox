import { classifyToolCall } from '../writes/classify'

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

export type AccessState = 'available' | 'available_with_limit' | 'upgrade_required' | 'plan_required' | 'full_version_required' | 'not_enabled'

const VALID_STATES: readonly AccessState[] = [
  'available',
  'available_with_limit',
  'upgrade_required',
  'plan_required',
  'full_version_required',
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
  restrictedParameters: Record<string, Record<string, string>>
}

interface RawSelf {
  workspace?: { id?: string; name?: string }
  user?: { id?: string; name?: string; email?: string }
  current_tool_access?: Record<string, { status?: string; upgrade_url?: string; restricted_parameters?: Record<string, string> }>
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
  const restrictedParameters: Record<string, Record<string, string>> = {}

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
    if (entry.restricted_parameters && typeof entry.restricted_parameters === 'object') {
      restrictedParameters[key] = Object.fromEntries(Object.entries(entry.restricted_parameters)
        .filter(([path, reason]) => path && typeof reason === 'string'))
    }
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
  return { identity, access, upgradeUrls, restrictedParameters }
}

/** Dedicated notion-get-tool-access response, separate from fetch-self identity. */
export function parseToolAccessResult(text: string): SelfInfo {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('invalid Notion tool access response') }
  if (!raw || typeof raw !== 'object' || !('current_tool_access' in raw) ||
      typeof raw.current_tool_access !== 'object' || raw.current_tool_access === null) {
    throw new Error('invalid Notion tool access response')
  }
  return parseSelfResult(JSON.stringify({ self: raw }))
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
  private readonly restrictedParameters: Record<string, Record<string, string>>

  constructor(access: Record<string, AccessState> = {}, private readonly completeMap = false, restrictions: Record<string, Record<string, string>> = {}) {
    // Canonicalize keys on the way in so any caller-provided spelling works.
    this.access = Object.fromEntries(Object.entries(access).map(([k, v]) => [canonicalTool(k), v]))
    this.restrictedParameters = Object.fromEntries(Object.entries(restrictions).map(([k, v]) => [canonicalTool(k), v]))
  }

  /** True when nothing is known (server did not send the map). */
  get isEmpty(): boolean {
    return Object.keys(this.access).length === 0
  }

  can(tool: string, args?: Record<string, unknown>): { allowed: boolean; state: AccessState | 'unknown'; reason?: string } {
    const key = canonicalTool(tool)
    const state = this.access[key]
    if (!state) {
      const allowed = !this.completeMap && !classifyToolCall(tool, args).mutates
      return { allowed, state: 'unknown', reason: allowed ? undefined : 'not advertised for this connection' }
    }
    for (const [path, reason] of Object.entries(this.restrictedParameters[key] ?? {})) {
      const value = path.split('.').reduce<unknown>((current, part) =>
        current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, args)
      if (value == null || value === false || value === '' || Array.isArray(value) && value.length === 0) continue
      if (path === 'sort' && value === 'relevance') continue
      if (path === 'filters.teamspace_ids' && Array.isArray(value) && new Set(value).size <= 1) continue
      return { allowed: false, state, reason: `${path}: ${reason}` }
    }
    switch (state) {
      case 'available':
        return { allowed: true, state }
      case 'available_with_limit':
        return { allowed: true, state, reason: 'limited by your Notion plan' }
      case 'upgrade_required':
      case 'plan_required':
        if (key === 'ai-search') return { allowed: true, state, reason: 'Notion-only keyword fallback' }
        return { allowed: false, state, reason: 'requires a higher Notion plan' }
      case 'full_version_required':
        return { allowed: false, state, reason: 'requires a higher Notion plan' }
      case 'not_enabled':
        return { allowed: false, state, reason: 'not enabled for this connection' }
    }
  }

  restrictionsFor(tool: string): string {
    return Object.entries(this.restrictedParameters[canonicalTool(tool)] ?? {})
      .map(([path, reason]) => `${path}: ${reason}`).join('; ')
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
