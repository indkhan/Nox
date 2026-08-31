import type { QueryResultTable } from '../../src/lib/db/query'

/** Compact results table with counts and optional groups (MVP §6.6). */
export function ResultsTable({ table, groupByColumn }: { table: QueryResultTable; groupByColumn?: string }) {
  const groups = groupByColumn ? computeGroups(table, groupByColumn) : null
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card" data-testid="results-table">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-line bg-inset">
              {table.columns.map((c) => (
                <th key={c} className="px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-ink-3">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 100).map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0 transition-colors duration-100 hover:bg-hover">
                {row.map((cell, j) => (
                  <td key={j} className="max-w-40 truncate px-2.5 py-1.5 text-ink-2">
                    {String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-line px-2.5 py-1 text-[10.5px] text-ink-3">
        <span>
          {table.totalRows} row{table.totalRows === 1 ? '' : 's'}
          {table.totalRows > 100 ? ' (showing 100)' : ''}
        </span>
        {groups && <span className="truncate">{Object.entries(groups).map(([k, n]) => `${k}: ${n}`).join(' · ')}</span>}
      </div>
    </div>
  )
}

function computeGroups(table: QueryResultTable, column: string): Record<string, number> | null {
  const idx = table.columns.indexOf(column)
  if (idx === -1) return null
  const out: Record<string, number> = {}
  for (const row of table.rows) {
    const key = String(row[idx])
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}
