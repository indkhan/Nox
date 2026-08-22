export type ActivityItem =
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'search'; id: string; status: 'running' | 'completed' }
  | {
      kind: 'tool'
      id: string
      tool: string
      args: Record<string, unknown>
      status: 'running' | 'completed' | 'failed'
      durationMs?: number
      error?: string
      resultText?: string
      journalId?: string
      undoable?: boolean
      undoError?: string
      undone?: boolean
    }

export type ActivityEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'web-search' }
  | { kind: 'web-search-completed' }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed'; tool?: string; callId?: string; success?: boolean; durationMs?: number; error?: string; resultText?: string }

export type ToolResultCategory = 'context' | 'table' | 'change' | 'generic'

interface ToolPresentation {
  running: string
  completed: string
  failed: string
  category: ToolResultCategory
  followUps?: [string, string]
}

const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  'notion-fetch': { running: 'Reading', completed: 'Read', failed: 'read a page', category: 'context', followUps: ['What are the key decisions?', 'Find related pages'] },
  'notion-search': { running: 'Searching for', completed: 'Searched for', failed: 'search the workspace', category: 'table', followUps: ['Summarize these results', 'Compare the matching pages'] },
  'notion-query-data-sources': { running: 'Querying a database', completed: 'Queried a database', failed: 'query a database', category: 'table', followUps: ['Summarize these results', 'Compare the matching pages'] },
  'notion-update-page': { running: 'Updating a page', completed: 'Updated a page', failed: 'update a page', category: 'change', followUps: ['Show me what changed', 'Make another update'] },
  'notion-create-pages': { running: 'Creating pages', completed: 'Created pages', failed: 'create pages', category: 'change', followUps: ['Show me what changed', 'Make another update'] },
  'notion-move-pages': { running: 'Moving pages', completed: 'Moved pages', failed: 'move pages', category: 'change', followUps: ['Show me what changed', 'Make another update'] },
}

export function applyActivityEvent(items: ActivityItem[], event: ActivityEvent): ActivityItem[] {
  if (event.kind === 'reasoning') {
    return [...items, { kind: 'reasoning', id: `reasoning-${items.length}`, text: event.text }]
  }
  if (event.kind === 'web-search') {
    return [...items, { kind: 'search', id: `search-${items.length}`, status: 'running' }]
  }
  if (event.kind === 'web-search-completed') {
    const index = [...items].reverse().findIndex((item) => item.kind === 'search' && item.status === 'running')
    if (index === -1) return items
    const actual = items.length - 1 - index
    return items.map((item, itemIndex) => itemIndex === actual && item.kind === 'search' ? { ...item, status: 'completed' } : item)
  }
  if (event.kind === 'tool-call') {
    return [...items, {
      kind: 'tool',
      id: event.callId ?? `tool-${items.length}`,
      tool: event.tool,
      args: event.args,
      status: 'running',
    }]
  }

  const index = items.findIndex((item) => item.kind === 'tool' && (
    event.callId ? item.id === event.callId : item.status === 'running' && item.tool === event.tool
  ))
  if (index === -1) return items
  const next = [...items]
  next[index] = {
    ...next[index] as Extract<ActivityItem, { kind: 'tool' }>,
    status: event.success === false ? 'failed' : 'completed',
    durationMs: event.durationMs,
    error: event.error,
    resultText: event.resultText,
  }
  return next
}

export function toolActivityLabel(tool: string, args: Record<string, unknown>, completed = false): string {
  const named = stringArg(args, 'title', 'query', 'name')
  const presentation = toolPresentation(tool)
  if (!TOOL_PRESENTATION[tool]) return humanize(tool)
  const label = completed ? presentation.completed : presentation.running
  return named && (tool === 'notion-fetch' || tool === 'notion-search') ? `${label} “${named}”` : label
}

export function failedToolActivityLabel(tool: string): string {
  return `Failed to ${toolPresentation(tool).failed}`
}

export function toolResultCategory(tool: string): ToolResultCategory {
  return toolPresentation(tool).category
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key] as string
  return null
}

function humanize(tool: string): string {
  const text = tool.replace(/^notion[-_]/, '').replace(/[-_]+/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function followUpsForActivity(items: ActivityItem[]): string[] {
  const last = [...items].reverse().find((item): item is Extract<ActivityItem, { kind: 'tool' }> => item.kind === 'tool' && item.status === 'completed')
  if (!last) return []
  return toolPresentation(last.tool).followUps ?? []
}

function toolPresentation(tool: string): ToolPresentation {
  return TOOL_PRESENTATION[tool] ?? {
    running: humanize(tool), completed: humanize(tool), failed: humanize(tool).toLowerCase(),
    category: /update|create|move/.test(tool) ? 'change' : 'generic',
  }
}

export function applyUndoResult(items: ActivityItem[], journalId: string, error?: string): ActivityItem[] {
  return items.map((item) => item.kind === 'tool' && item.journalId === journalId
    ? error
      ? { ...item, undoable: true, undoError: error }
      : { ...item, undoable: false, undone: true, undoError: undefined, resultText: 'Change undone' }
    : item)
}
