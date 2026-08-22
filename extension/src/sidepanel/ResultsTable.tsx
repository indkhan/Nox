import type { QueryResultTable } from '../../src/lib/db/query'

/** Compact results table with counts and optional groups (MVP §6.6). */
export function ResultsTable({ table, groupByColumn }: { table: QueryResultTable; groupByColumn?: string }) {
  const groups = groupByColumn ? computeGroups(table, groupByColumn) : null
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-800" data-testid="results-table">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-950/60">
            {table.columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium text-zinc-400">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, 100).map((row, i) => (
            <tr key={i} className="border-b border-zinc-900 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="max-w-40 truncate px-2 py-1 text-zinc-300">{String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-zinc-800 px-2 py-1 text-[10px] text-zinc-500">
        <span>{table.totalRows} row{table.totalRows === 1 ? '' : 's'}{table.totalRows > 100 ? ' (showing 100)' : ''}</span>
        {groups && (
          <span>{Object.entries(groups).map(([k, n]) => `${k}: ${n}`).join(' · ')}</span>
        )}
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
