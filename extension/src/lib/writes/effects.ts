import { classifyToolCall, requiresWorkspacePlan, type MutationKind } from './classify'
import { normalizeId } from '../../shared/notion-page'

/** Per-operation canonical payload budget (UTF-8 bytes of the stable JSON). */
export const MAX_OPERATION_BYTES = 512 * 1024
/** Maximum nesting depth of a canonical payload. */
export const MAX_CANONICAL_DEPTH = 20
/** Maximum entries in any effect list (bulk arrays). */
export const MAX_EFFECT_LIST_ENTRIES = 100

/** Nox-internal control fields a model proposal must never carry. */
const RESERVED_ROOT_FIELDS = new Set(['__nox_expected_hash'])

export type EffectValidationCode = 'UNSUPPORTED_EFFECT' | 'INVALID_ARGUMENTS' | 'PAYLOAD_TOO_LARGE'

/** Typed refusal for a proposal that must not reach consent or transport. */
export class EffectValidationError extends Error {
  readonly code: EffectValidationCode
  constructor(code: EffectValidationCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'EffectValidationError'
    this.code = code
  }
}

/**
 * One validated operation: the canonical tool name, the complete canonical
 * execution arguments, every affected existing target, parent/destination,
 * affected-object count, risk category, and plan/baseline necessity. Parsed
 * once at admission and reused by approval, guard, journaling, and dispatch.
 */
export interface ValidatedEffect {
  tool: string
  args: Record<string, unknown>
  kind: MutationKind
  targets: string[]
  parents: string[]
  count: number
  risk: 'low' | 'medium' | 'structural'
  needsPlan: boolean
  needsBaseline: boolean
}

/**
 * Validate a model-proposed mutation before consent. Rejects reserved
 * internal fields, unbounded payloads, and shape mismatches; returns the
 * frozen canonical effect that approval displays and dispatch executes.
 * Journal-sourced inverse executions bypass this (they are exact-matched
 * against stored inverses instead).
 */
export function validateEffect(tool: string, args: Record<string, unknown>): ValidatedEffect {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new EffectValidationError('INVALID_ARGUMENTS', 'mutation arguments must be an object')
  }
  for (const field of RESERVED_ROOT_FIELDS) {
    if (Object.hasOwn(args, field)) {
      throw new EffectValidationError('INVALID_ARGUMENTS', `model proposals must not carry the internal field ${field}`)
    }
  }
  const canonical = canonicalizeArgs(args)
  // injected_request is stripped without ceremony: it is not an authority
  // signal and never reaches consent, journal, or transport. (Only the
  // trusted undo hash above is a refusal; see the stripping test.)
  delete canonical.injected_request
  const classification = classifyToolCall(tool, canonical)
  const adapter = ADAPTERS[tool]
  if (!adapter) {
    throw new EffectValidationError('UNSUPPORTED_EFFECT', `"${tool}" is not a supported effect shape and cannot be authorized`)
  }
  const parsed = adapter(canonical)
  return {
    tool,
    args: canonical,
    kind: classification.kind,
    targets: parsed.targets,
    parents: parsed.parents,
    count: parsed.count,
    risk: classification.impact ?? 'medium',
    needsPlan: requiresWorkspacePlan(classification, canonical),
    needsBaseline: classification.kind === 'content-replace' || classification.kind === 'content-update',
  }
}

/** Content replacement and destructive transforms need extra user attention. */
export function isDestructiveKind(kind: MutationKind): boolean {
  return kind === 'content-replace' || kind === 'move' || kind === 'schema' || kind === 'view' || kind === 'duplicate'
}

/**
 * Deep-copy into canonical form: sorted object keys, JSON-only values, and
 * the per-operation bounds. Throws instead of truncating — an oversized or
 * non-JSON proposal is refused, never silently reduced and executed.
 */
export function canonicalizeArgs(value: unknown): Record<string, unknown> {
  const canonical = canonicalizeValue(value, 0, new WeakSet()) as Record<string, unknown> | null
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new EffectValidationError('INVALID_ARGUMENTS', 'mutation arguments must be an object')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(canonical)).length
  if (bytes > MAX_OPERATION_BYTES) {
    throw new EffectValidationError('PAYLOAD_TOO_LARGE', `canonical payload is ${bytes} bytes, above the ${MAX_OPERATION_BYTES}-byte per-operation budget`)
  }
  return canonical
}

function canonicalizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EffectValidationError('INVALID_ARGUMENTS', 'non-finite numbers are not JSON arguments')
    }
    return value
  }
  if (value === undefined) return undefined
  if (typeof value !== 'object') {
    throw new EffectValidationError('INVALID_ARGUMENTS', 'only JSON values may appear in mutation arguments')
  }
  if (seen.has(value)) {
    throw new EffectValidationError('INVALID_ARGUMENTS', 'cyclic arguments cannot be frozen for consent')
  }
  if (depth >= MAX_CANONICAL_DEPTH) {
    throw new EffectValidationError('PAYLOAD_TOO_LARGE', `arguments nest deeper than ${MAX_CANONICAL_DEPTH} levels`)
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_EFFECT_LIST_ENTRIES) {
        throw new EffectValidationError('PAYLOAD_TOO_LARGE', `an effect list holds ${value.length} entries, above the ${MAX_EFFECT_LIST_ENTRIES}-entry budget`)
      }
      return value.map((entry) => canonicalizeValue(entry, depth + 1, seen) ?? null)
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = canonicalizeValue((value as Record<string, unknown>)[key], depth + 1, seen)
      if (entry !== undefined) out[key] = entry
    }
    return out
  } finally {
    seen.delete(value)
  }
}

interface ParsedTargets {
  targets: string[]
  parents: string[]
  count: number
}

type Adapter = (args: Record<string, unknown>) => ParsedTargets

/** Explicit per-tool adapters over known fields — never a recursive id scan. Missing required identity throws INVALID_ARGUMENTS. */
const ADAPTERS: Record<string, Adapter> = {
  'notion-update-page': (args) => {
    const page = idString((args.data as Record<string, unknown> | undefined)?.page_id ?? args.page_id)
    if (!page) throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-update-page" requires a page target')
    return { targets: [page], parents: [], count: 1 }
  },
  'notion-move-pages': (args) => {
    const targets = idList(args.page_ids) ?? idListFromObjects(args.pages) ?? []
    const single = idString((args.data as Record<string, unknown> | undefined)?.page_id ?? args.page_id)
    if (single) targets.push(single)
    if (targets.length === 0) {
      throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-move-pages" requires at least one moved page')
    }
    return { targets, parents: parentList(args.parent ?? args.destination), count: targets.length }
  },
  'notion-create-pages': (args) => {
    const pages = args.pages ?? args.data
    if (pages !== undefined && !Array.isArray(pages)) {
      throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-create-pages" pages must be a list')
    }
    const entries = Array.isArray(pages) ? pages : []
    const targets: string[] = []
    const parents: string[] = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-create-pages" entries must be objects')
      }
      const record = entry as Record<string, unknown>
      for (const id of [record.page_id, record.id, record.data_source_id, record.database_id, record.view_id]) {
        const parsed = idString(id)
        if (parsed) targets.push(parsed)
      }
      parents.push(...parentList(record.parent))
    }
    const topParent = parentList(args.parent)
    return { targets, parents: [...topParent, ...parents], count: entries.length }
  },
  'notion-duplicate-page': (args) => {
    const source = idString((args.data as Record<string, unknown> | undefined)?.page_id ?? args.page_id)
    if (!source) throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-duplicate-page" requires a source page')
    return { targets: [source], parents: parentList(args.parent), count: 1 }
  },
  'notion-create-database': (args) => ({ targets: [], parents: parentList(args.parent), count: 1 }),
  'notion-create-folder': (args) => ({ targets: [], parents: parentList(args.parent), count: 1 }),
  'notion-create-comment': (args) => {
    const page = idString((args.data as Record<string, unknown> | undefined)?.page_id ?? args.page_id)
    if (!page) throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-create-comment" requires a page target')
    return { targets: [page], parents: [], count: 1 }
  },
  'notion-update-data-source': (args) => {
    const ids = [idString(args.data_source_id), idString(args.database_id)].filter((id): id is string => id != null)
    if (ids.length === 0) {
      throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-update-data-source" requires a data-source target')
    }
    return { targets: ids, parents: [], count: ids.length }
  },
  'notion-update-view': (args) => {
    const view = idString(args.view_id)
    if (!view) throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-update-view" requires a view target')
    return { targets: [view], parents: [], count: 1 }
  },
  'notion-create-view': (args) => {
    const parents = [idString(args.database_id), idString(args.data_source_id)].filter((id): id is string => id != null)
    if (parents.length === 0) {
      throw new EffectValidationError('INVALID_ARGUMENTS', '"notion-create-view" requires a database target')
    }
    return { targets: [], parents, count: 1 }
  },
}

/** Normalize a verified identifier, passing through other non-empty strings untouched. */
function idString(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  return normalizeId(value) ?? value
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const entry of value) {
    const id = idString(entry)
    if (!id) return null
    ids.push(id)
  }
  return ids
}

function idListFromObjects(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = idString(entry)
      if (!id) return null
      ids.push(id)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    const id = idString(record.page_id ?? record.id)
    if (!id) return null
    ids.push(id)
  }
  return ids
}

function parentList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') {
    const id = idString(value)
    return id ? [id] : []
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const id = idString(record.page_id ?? record.id)
    return id ? [id] : []
  }
  return []
}
