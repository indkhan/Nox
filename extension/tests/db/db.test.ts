import { describe, expect, it } from 'vitest'
import { tableFromObjects, toResultTable } from '../../src/lib/db/query'

describe('query helpers', () => {
  it('normalizes structured json results into a table', () => {
    const table = toResultTable({
      content: [{ type: 'text', text: JSON.stringify({ columns: ['Name', 'Status'], rows: [['A', 'Overdue'], ['B', null]] }) }],
    })
    expect(table.totalRows).toBe(2)
    expect(table.rows[0]).toEqual(['A', 'Overdue'])
    expect(table.rows[1][1]).toBeNull()
  })

  it('builds tables from object arrays with title extraction', () => {
    const table = tableFromObjects([
      { title: [{ plain_text: 'Task A' }, { plain_text: '!' }], Status: { name: 'Overdue' } },
      { title: [{ plain_text: 'Task B' }], Status: { name: 'Todo' } },
    ])
    expect(table.columns.sort()).toEqual(['Status', 'title'])
    expect(table.rows[0][0]).toBe('Task A!')
    expect(table.rows[0][1]).toBe('Overdue')
  })
})
