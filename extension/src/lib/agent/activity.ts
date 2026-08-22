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
    }

export type ActivityEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'web-search' }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed'; tool?: string; callId?: string; success?: boolean; durationMs?: number; error?: string }

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
  }
  return next
}
