import { describe, expect, it } from 'vitest'
import { validateProperties, withRepairRetry, type NotionProperty } from '../../src/lib/db/validators'
import { chooseQueryMode, groupBy, tableFromObjects, toResultTable } from '../../src/lib/db/query'
import { CapabilityGate } from '../../src/lib/notion/capabilities'

describe('validateProperties', () => {
  it('accepts well-typed values per property type', () => {
    const issues = validateProperties([
      { name: 'Name', type: 'text', value: 'hello' },
      { name: 'Points', type: 'number', value: 42 },
      { name: 'Done', type: 'checkbox', value: false },
      { name: 'Status', type: 'select', value: 'In Progress' },
      { name: 'Due', type: 'date', value: '2026-09-01' },
      { name: 'Tags', type: 'multi_select', value: ['a', 'b'] },
      { name: 'Range', type: 'date', value: { start: '2026-09-01', end: '2026-09-05' } },
    ])
    expect(issues).toEqual([])
  })

  it('rejects mistyped model output', () => {
    const issues = validateProperties([
      { name: 'Points', type: 'number', value: 'lots' },
      { name: 'Done', type: 'checkbox', value: 'yes' },
      { name: 'Due', type: 'date', value: 'soon' },
      { name: 'Tags', type: 'multi_select', value: 'single' },
      { name: 'Owner', type: 'relation', value: ['x'] },
    ])
    expect(issues.map((i) => i.property)).toEqual(['Points', 'Done', 'Due', 'Tags', 'Owner'])
    expect(issues[0].message).toMatch(/finite number/)
    expect(issues.find((i) => i.expectedType === 'relation')!.message).toMatch(/refuses to guess/)
  })

  it('rejects empty select values and NaN numbers', () => {
    expect(validateProperties([{ name: 'S', type: 'select', value: '' }])).toHaveLength(1)
    expect(validateProperties([{ name: 'N', type: 'number', value: Number.NaN }])).toHaveLength(1)
  })
})

describe('withRepairRetry', () => {
  it('passes through valid output without repair', async () => {
    const out = await withRepairRetry(
      async () => [{ name: 'N', type: 'number', value: 1 }] as NotionProperty[],
      async () => [],
    )
    expect(out.repairedOnce).toBe(false)
  })

  it('repairs once when the first attempt is invalid', async () => {
    let attempts = 0
    const out = await withRepairRetry<NotionProperty[]>(
      async () => {
        attempts++
        return [{ name: 'N', type: 'number', value: attempts === 1 ? 'x' : 7 }]
      },
      async (issues, previous) => {
        expect(issues).toHaveLength(1)
        void previous
        return [{ name: 'N', type: 'number', value: 7 }]
      },
    )
    expect(out.repairedOnce).toBe(true)
    expect(out.properties).toEqual([{ name: 'N', type: 'number', value: 7 }])
  })

  it('throws when the repair also fails validation', async () => {
    await expect(
      withRepairRetry<NotionProperty[]>(
        async () => [{ name: 'N', type: 'number', value: 'x' }],
        async () => [{ name: 'N', type: 'number', value: 'still bad' }],
      ),
    ).rejects.toThrow(/failed twice/)
  })
})

describe('query helpers', () => {
  it('chooses sql only for fully available query capability', () => {
    expect(chooseQueryMode(new CapabilityGate({ 'query-data-sources': 'available' }))).toBe('sql')
    expect(chooseQueryMode(new CapabilityGate({ 'query-data-sources': 'available_with_limit' }))).toBe('view')
    expect(chooseQueryMode(new CapabilityGate())).toBe('view')
  })

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

  it('groups rows by column for board-style counts', () => {
    expect(groupBy([['a'], ['a'], ['b']], 0)).toEqual({ a: 2, b: 1 })
  })
})
