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
  if (READ_TOOLS.has(name)) return { mutates: false, kind: 'read' }
  if (CREATION_TOOLS[name]) return { mutates: true, kind: CREATION_TOOLS[name] }
  if (name === 'notion-move-pages') return { mutates: true, kind: 'move' }

  if (name === 'notion-update-page') {
    const command = (args.command ?? args) as Record<string, unknown>
    const type = typeof command.type === 'string' ? command.type : ''
    if (/replace_content/i.test(type) || 'replace_content' in args || 'content' in args && type === '') {
      return { mutates: true, kind: 'content-replace' }
    }
    if (/properties/i.test(type)) return { mutates: true, kind: 'properties' }
    if (/update_content/i.test(type)) return { mutates: true, kind: 'content-update' }
    // Unknown update shape: treat as the most destructive plausible case.
    return { mutates: true, kind: 'content-replace' }
  }

  if (name === 'notion-update-data-source') return { mutates: true, kind: 'schema' }
  if (name === 'notion-update-view') return { mutates: true, kind: 'view' }
  if (name === 'notion-create-view') return { mutates: true, kind: 'view' }

  return { mutates: true, kind: 'unknown' }
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
