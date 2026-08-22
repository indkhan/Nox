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
    }

export type ActivityEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'web-search' }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed'; tool?: string; callId?: string; success?: boolean; durationMs?: number; error?: string; resultText?: string }

export function applyActivityEvent(items: ActivityItem[], event: ActivityEvent): ActivityItem[] {
  if (event.kind === 'reasoning') {
    return [...items, { kind: 'reasoning', id: `reasoning-${items.length}`, text: event.text }]
  }
  if (event.kind === 'web-search') {
    return [...items, { kind: 'search', id: `search-${items.length}`, status: 'running' }]
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
  const labels: Record<string, [string, string]> = {
    'notion-fetch': ['Reading', 'Read'],
    'notion-search': ['Searching for', 'Searched for'],
    'notion-update-page': ['Updating a page', 'Updated a page'],
    'notion-create-pages': ['Creating pages', 'Created pages'],
    'notion-query-data-sources': ['Querying a database', 'Queried a database'],
    'notion-move-pages': ['Moving pages', 'Moved pages'],
  }
  const pair = labels[tool]
  if (!pair) return humanize(tool)
  const label = pair[completed ? 1 : 0]
  return named && (tool === 'notion-fetch' || tool === 'notion-search') ? `${label} “${named}”` : label
}

export function failedToolActivityLabel(tool: string): string {
  const labels: Record<string, string> = {
    'notion-fetch': 'read a page',
    'notion-search': 'search the workspace',
    'notion-update-page': 'update a page',
    'notion-create-pages': 'create pages',
    'notion-query-data-sources': 'query a database',
    'notion-move-pages': 'move pages',
  }
  return `Failed to ${labels[tool] ?? humanize(tool).toLowerCase()}`
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
  if (last.tool === 'notion-search' || last.tool === 'notion-query-data-sources') {
    return ['Summarize these results', 'Compare the matching pages']
  }
  if (last.tool === 'notion-fetch') return ['What are the key decisions?', 'Find related pages']
  if (/update|create|move/.test(last.tool)) return ['Show me what changed', 'Make another update']
  return []
}
