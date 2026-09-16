export type ActivityItem =
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'search'; id: string; status: 'running' | 'completed'; query?: string; action?: Record<string, unknown> }
  | {
      kind: 'tool'
      id: string
      tool: string
      args: Record<string, unknown>
      status: 'running' | 'completed' | 'failed' | 'unknown'
      durationMs?: number
      error?: string
      resultText?: string
      journalId?: string
      undoable?: boolean
      undoError?: string
      undone?: boolean
      /** Precise reason an applied change cannot be undone (with inspectUrl). */
      notUndoableReason?: string
      /** Set when the journal outcome is pending/unknown: no replayable undo. */
      unresolvedDetail?: string
      /** Notion target for manual inspection of an unresolved change. */
      inspectUrl?: string
      /** The user marked this unresolved entry reviewed (outcome unchanged). */
      reviewed?: boolean
    }

export type ActivityEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'web-search'; id?: string; query?: string; action?: Record<string, unknown> }
  | { kind: 'web-search-completed'; id?: string; query?: string; action?: Record<string, unknown> }
  | { kind: 'tool-call'; tool: string; args: Record<string, unknown>; callId?: string }
  | { kind: 'tool-completed'; tool?: string; callId?: string; success?: boolean; durationMs?: number; error?: string; resultText?: string }

export type ToolResultCategory = 'context' | 'table' | 'change' | 'generic'

export interface ActivitySummary {
  label: string
  actionCount: number
  durationMs: number
  status: 'active' | 'completed' | 'failed'
}

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
  if (event.kind === 'commentary') {
    const found = items.some(item => item.kind === 'commentary' && item.id === event.id)
    return found ? items.map(item => item.kind === 'commentary' && item.id === event.id ? { ...item, text: event.text } : item) : [...items, event]
  }
  if (event.kind === 'web-search' || event.kind === 'web-search-completed') {
    const id = event.id ?? (event.kind === 'web-search-completed' ? [...items].reverse().find(item => item.kind === 'search' && item.status === 'running')?.id : undefined) ?? `search-${items.length}`
    const existing = items.find(item => item.kind === 'search' && item.id === id) as Extract<ActivityItem, { kind: 'search' }> | undefined
    const next: ActivityItem = { kind: 'search', id, status: event.kind === 'web-search-completed' || existing?.status === 'completed' ? 'completed' : 'running', query: event.query ?? existing?.query, action: event.action ?? existing?.action }
    return existing ? items.map(item => item === existing ? next : item) : [...items, next]
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

export function deriveActivitySummary(items: ActivityItem[], state: { active: boolean; answerStarted: boolean; outcome?: 'failed' | 'interrupted' }): ActivitySummary {
  const actions = items.filter((item): item is Extract<ActivityItem, { kind: 'search' | 'tool' }> => item.kind === 'search' || item.kind === 'tool')
  const tools = actions.filter((item): item is Extract<ActivityItem, { kind: 'tool' }> => item.kind === 'tool')
  const durationMs = tools.reduce((total, item) => total + (item.durationMs ?? 0), 0)
  const failed = [...tools].reverse().find((item) => item.status === 'failed')
  const running = [...actions].reverse().find((item) => item.status === 'running')
  const unknown = [...tools].reverse().find((item) => item.status === 'unknown')

  if (state.outcome) return { label: state.outcome === 'failed' ? 'Response failed' : 'Response stopped', actionCount: actions.length, durationMs, status: 'failed' }
  if (failed) return { label: failedToolActivityLabel(failed.tool), actionCount: actions.length, durationMs, status: 'failed' }
  if (unknown) return { label: 'Needs review', actionCount: actions.length, durationMs, status: 'failed' }
  if (!state.active) return { label: 'Answer ready', actionCount: actions.length, durationMs, status: 'completed' }
  if (state.answerStarted) return { label: 'Writing the answer…', actionCount: actions.length, durationMs, status: 'active' }
  if (running?.kind === 'search') return { label: 'Searching the web…', actionCount: actions.length, durationMs, status: 'active' }
  if (running?.kind === 'tool') return { label: `${toolActivityLabel(running.tool, running.args)}…`, actionCount: actions.length, durationMs, status: 'active' }
  return { label: 'Understanding your request…', actionCount: actions.length, durationMs, status: 'active' }
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

/** Manual-inspection link for a Notion target page id. */
export function inspectUrlForPage(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`
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

/** Prominent copy for an unresolved journal row: pending, unknown, or undo-locked. */
export function describeUnresolvedEntry(entry: {
  status: string
  outcomeDetail?: string
  reviewedAt?: number | null
  reservedByUndoOpId?: string | null
}): string {
  if (entry.status === 'applied' && entry.reservedByUndoOpId != null) {
    return 'An undo was interrupted for this change — it is locked until reviewed. Do not retry the undo; inspect both records, then mark reviewed.'
  }
  if (entry.status === 'pending') {
    return 'Nox stopped before this change was confirmed — it may or may not have applied. Do not retry it; inspect it in Notion, then mark it reviewed to allow new work. Undo is unavailable while the outcome is unresolved.'
  }
  const extra = entry.outcomeDetail ? ` Last recorded detail: ${entry.outcomeDetail}.` : ''
  const reviewed = entry.reviewedAt != null ? ' Reviewed by user.' : ''
  return `Outcome unknown — it may or may not have applied. Do not retry it; inspect it in Notion, then mark it reviewed to allow new work. Undo is unavailable while the outcome is unresolved.${extra}${reviewed}`
}

/** Journal-driven display state for one restored or live tool row. */
export function markUnresolved(
  item: Extract<ActivityItem, { kind: 'tool' }>,
  update: { journalId: string; detail: string; inspectUrl?: string; reviewed?: boolean },
): Extract<ActivityItem, { kind: 'tool' }> {
  return {
    ...item,
    status: 'unknown',
    journalId: update.journalId,
    undoable: false,
    unresolvedDetail: update.detail,
    inspectUrl: update.inspectUrl,
    reviewed: update.reviewed,
  }
}

/** Record durable user review on the matching unresolved row; outcome unchanged. */
export function applyReviewResult(items: ActivityItem[], journalId: string): ActivityItem[] {
  return items.map((item) => item.kind === 'tool' && item.journalId === journalId && item.status === 'unknown'
    ? { ...item, reviewed: true, unresolvedDetail: `${item.unresolvedDetail ?? 'Outcome unknown.'} Reviewed by user — new work is allowed again.` }
    : item)
}

/** Attach ephemeral readback evidence to the matching unresolved row. */
export function applyReviewEvidence(items: ActivityItem[], journalId: string, evidence: string): ActivityItem[] {
  return items.map((item) => item.kind === 'tool' && item.journalId === journalId && item.status === 'unknown'
    ? { ...item, unresolvedDetail: evidence }
    : item)
}
