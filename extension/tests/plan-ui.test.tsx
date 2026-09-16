// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { PlanCards } from '../src/sidepanel/PlanCards'
import { useNoxStore } from '../src/sidepanel/store'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(globalThis, { chrome: { runtime: { onMessage: { addListener: () => undefined } } } })
})

describe('PlanCards', () => {
  it('presents a focused plan review and resolves approval', async () => {
    let decision: string | null = null
    useNoxStore.setState({ pendingPlans: [{
      id: 'plan-1',
      plan: {
        goal: 'Track habits', recommendation: 'Reuse Daily Log',
        evidence: [{ id: 'db-1', title: 'Daily Log', kind: 'database', reason: 'Already dated' }],
        operations: [{ tool: 'notion-update-data-source', targetId: 'db-1', args: { data_source_id: 'db-1' }, summary: 'Add Completed checkbox' }],
        consequences: ['One database changes'],
      },
      resolve: (value) => { decision = value },
    }] })
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<PlanCards />))
    expect(host.querySelector('[data-testid="plan-review"]')).not.toBeNull()
    expect(host.textContent).toContain('Plan ready')
    expect(host.textContent).toContain('Reuse Daily Log')
    expect(host.textContent).toContain('Add Completed checkbox')
    expect(host.textContent).toContain('One database changes')
    const evidenceDetails = [...host.querySelectorAll('details')].find((el) => el.textContent?.includes('Inspected'))
    expect(evidenceDetails?.open).toBe(false)
    expect(evidenceDetails?.textContent).toContain('Daily Log')
    expect(host.querySelector('[data-testid="approve-plan-1"]')?.textContent).toBe('Approve and continue')
    await act(async () => (host.querySelector('[data-testid="approve-plan-1"]') as HTMLButtonElement).click())
    expect(decision).toBe('approved')
    expect(useNoxStore.getState().pendingPlans).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('shows creation references and operation arguments before consent', async () => {
    useNoxStore.setState({ pendingPlans: [{
      id: 'plan-2',
      plan: {
        goal: 'G', recommendation: 'R',
        evidence: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'E', kind: 'page', reason: 'why' }],
        operations: [
          { opId: 'mk', tool: 'notion-create-pages', args: { pages: [] }, summary: 'Create one' },
          { opId: 'use', tool: 'notion-update-page', targetId: { ref: 'mk' }, args: {}, summary: 'Edit it' },
        ],
        consequences: [],
      },
      resolve: () => undefined,
    }] })
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<PlanCards />))
    expect(host.textContent).toContain('uses the new object from step 1')
    expect(host.textContent).toContain('Operation details')
    await act(async () => root.unmount())
    useNoxStore.setState({ pendingPlans: [] })
  })
})
