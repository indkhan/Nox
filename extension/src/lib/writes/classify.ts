/** Mutation taxonomy for the Notion MCP tool surface (RESEARCH §2.5). */

export type MutationKind =
  | 'read'
  | 'content-replace'
  | 'content-update'
  | 'properties'
  | 'move'
  | 'duplicate'
  | 'create-page'
  | 'create-database'
  | 'create-folder'
  | 'create-comment'
  | 'schema'
  | 'view'
  | 'unknown'

export interface CallClassification {
  mutates: boolean
  kind: MutationKind
  impact?: 'low' | 'medium' | 'structural'
  requiresWorkspacePlan?: boolean
}

const READ_TOOLS = new Set([
  'notion-search',
  'notion-fetch',
  'notion-query-data-sources',
  'notion-get-users',
  'notion-get-teams',
  'notion-get-comments',
  'notion-get-async-task',
  'notion-download-attachment',
])

/** Tools whose result is a brand-new object — never undoable (no delete). */
const CREATION_TOOLS: Record<string, MutationKind> = {
  'notion-create-pages': 'create-page',
  'notion-duplicate-page': 'duplicate',
  'notion-create-database': 'create-database',
  'notion-create-folder': 'create-folder',
  'notion-create-comment': 'create-comment',
}

export function classifyToolCall(name: string, args: Record<string, unknown> = {}): CallClassification {
  if (READ_TOOLS.has(name)) return classified(false, 'read', 'low')
  if (CREATION_TOOLS[name]) {
    const kind = CREATION_TOOLS[name]
    return classified(true, kind, kind === 'create-database' ? 'structural' : 'medium')
  }
  if (name === 'notion-move-pages') return classified(true, 'move', 'structural')

  if (name === 'notion-update-page') {
    const command = (args.command ?? args) as Record<string, unknown>
    const type = typeof command.type === 'string' ? command.type : ''
    if (/replace_content/i.test(type) || 'replace_content' in args || 'content' in args && type === '') {
      return classified(true, 'content-replace', 'medium')
    }
    if (/properties/i.test(type)) return classified(true, 'properties', 'low')
    if (/update_content/i.test(type)) return classified(true, 'content-update', 'low')
    // Unknown update shape: treat as the most destructive plausible case.
    return classified(true, 'content-replace', 'medium')
  }

  if (name === 'notion-update-data-source') return classified(true, 'schema', 'structural')
  if (name === 'notion-update-view') return classified(true, 'view', 'structural')
  if (name === 'notion-create-view') return classified(true, 'view', 'structural')

  return classified(true, 'unknown', 'structural')
}

function classified(mutates: boolean, kind: MutationKind, impact: CallClassification['impact']): CallClassification {
  return { mutates, kind, impact, requiresWorkspacePlan: impact === 'structural' }
}

export function requiresWorkspacePlan(call: CallClassification, args: Record<string, unknown> = {}): boolean {
  if (call.requiresWorkspacePlan) return true
  if (call.kind !== 'create-page') return false
  const pages = args.pages ?? args.data
  return Array.isArray(pages) && pages.length > 5
}

/** Property types whose previous values can be faithfully restored (MVP §6.5). */
export const SAFE_PROPERTY_TYPES: readonly string[] = ['text', 'number', 'select', 'date', 'checkbox']

export function isSafePropertyType(type: string): boolean {
  return SAFE_PROPERTY_TYPES.includes(String(type).toLowerCase())
}

/**
 * Conservative rich-page detection: any structural block marker that the
 * markdown round trip is known to mangle (spike 0.6) marks content writes as
 * not-undoable.
 */
const RICH_MARKERS: RegExp[] = [
  /synced[_\s-]?block/i,
  /child\s+database/i,
  /\bcolumns?\s*:/i,
  /<empty-block\s*\/>/i,
  /embed/i,
]

export function detectRichPage(markdown: string): boolean {
  return RICH_MARKERS.some((re) => re.test(markdown))
}
