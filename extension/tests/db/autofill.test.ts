import { describe, expect, it, vi } from 'vitest'
import { AutofillRun, buildAutofillPreview, type AutofillTask } from '../../src/lib/db/autofill'

function tasks(n: number): AutofillTask[] {
  return Array.from({ length: n }, (_, i) => ({ rowId: `row-${i}`, rowTitle: `Row ${i}` }))
}

describe('buildAutofillPreview', () => {
  it('flags confirmation above the 25-row threshold', () => {
    expect(buildAutofillPreview(tasks(10), 'Status', 'p').needsConfirmation).toBe(false)
    expect(buildAutofillPreview(tasks(26), 'Status', 'p').needsConfirmation).toBe(true)
    expect(buildAutofillPreview(tasks(26), 'Status', 'p').estimatedToolCalls).toBe(26)
  })
})

describe('AutofillRun', () => {
  it('processes every task exactly once with applied counts', async () => {
    const seen: string[] = []
    const run = new AutofillRun({
      generate: async (t) => `${t.rowId}-value`,
      apply: async (t) => void seen.push(t.rowId),
      onProgress: vi.fn(),
    })
    const outcome = await run.run(buildAutofillPreview(tasks(7), 'Status', 'classify'))
    expect(outcome.applied).toBe(7)
    expect(outcome.failed).toBe(0)
    expect(outcome.cancelled).toBe(false)
    expect(seen).toHaveLength(7)
  })

  it('never exceeds concurrency of three', async () => {
    let inFlight = 0
    let peak = 0
    const run = new AutofillRun({
      generate: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return 'v'
      },
      apply: async () => undefined,
    })
    await run.run(buildAutofillPreview(tasks(12), 'S', 'p'))
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('cancel stops before remaining applies and reports cancelled', async () => {
    const applied: string[] = []
    const run = new AutofillRun({
      generate: async (t) => {
        if (t.rowId === 'row-2') run.cancel()
        return 'v'
      },
      apply: async (t) => void applied.push(t.rowId),
    })
    const outcome = await run.run(buildAutofillPreview(tasks(20), 'S', 'p'))
    expect(outcome.cancelled).toBe(true)
    expect(applied.length).toBeLessThan(20)
    expect(outcome.applied).toBe(applied.length)
  })

  it('counts failures per row without stopping the run', async () => {
    const run = new AutofillRun({
      generate: async (t) => {
        if (t.rowId === 'row-1' || t.rowId === 'row-4') throw new Error('bad model output')
        return 'ok'
      },
      apply: async () => undefined,
    })
    const outcome = await run.run(buildAutofillPreview(tasks(6), 'S', 'p'))
    expect(outcome.applied).toBe(4)
    expect(outcome.failed).toBe(2)
    expect(outcome.errors.map((e) => e.rowId).sort()).toEqual(['row-1', 'row-4'])
  })

  it('reports progress as rows complete', async () => {
    const progress: Array<[number, number]> = []
    const run = new AutofillRun({
      generate: async () => 'v',
      apply: async () => undefined,
      onProgress: (done, total) => void progress.push([done, total]),
    })
    await run.run(buildAutofillPreview(tasks(3), 'S', 'p'))
    expect(progress.map(([d]) => d)).toEqual([1, 2, 3])
    expect(progress[0][1]).toBe(3)
  })
})
