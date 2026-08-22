import type { CapabilityGate } from '../notion/capabilities'

/** SQL is metered below Business + Notion AI (RESEARCH §2.5). */
export type QueryMode = 'sql' | 'view'

export function chooseQueryMode(gate: CapabilityGate): QueryMode {
  return gate.can('notion-query-data-sources').allowed && gate.can('notion-query-data-sources').state === 'available'
    ? 'sql'
    : 'view'
}

export interface QueryResultTable {
  columns: string[]
  rows: Array<Array<string | number | boolean | null>>
  totalRows: number
  groups?: Record<string, number>
}

/** Normalizes whatever the tool returned into a renderable table. */
export function toResultTable(result: { content: Array<{ type: string; text?: string }> }): QueryResultTable {
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  try {
    const parsed = JSON.parse(text) as { columns?: string[]; rows?: unknown[][]; results?: unknown[] }
    if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      return {
        columns: parsed.columns,
        rows: parsed.rows.map((r) => r.map(cellToString)),
        totalRows: parsed.rows.length,
      }
    }
    if (Array.isArray(parsed.results)) {
      return tableFromObjects(parsed.results.map((o) => (typeof o === 'object' && o !== null ? o as Record<string, unknown> : {})))
    }
  } catch {
    /* fall through to plain text */
  }
  return { columns: ['result'], rows: [[text.slice(0, 2000)]], totalRows: 1 }
}

export function tableFromObjects(objects: Array<Record<string, unknown>>): QueryResultTable {
  const columns = [...new Set(objects.flatMap((o) => Object.keys(o)))]
  return {
    columns,
    rows: objects.map((o) => columns.map((c) => cellToString(o[c]) ?? null)),
    totalRows: objects.length,
  }
}

export function groupBy(rows: QueryResultTable['rows'], columnIndex: number): Record<string, number> {
  const groups: Record<string, number> = {}
  for (const row of rows) {
    const key = String(row[columnIndex] ?? '—')
    groups[key] = (groups[key] ?? 0) + 1
  }
  return groups
}

function cellToString(v: unknown): string | number | boolean | null {
  if (v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'plain_text' in (v[0] as object)) {
    return v.map((t) => String((t as { plain_text?: string }).plain_text ?? '')).join('')
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('name' in o) return String(o.name)
  }
  return JSON.stringify(v) ?? null
}
