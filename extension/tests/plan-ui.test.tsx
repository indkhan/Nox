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
        operations: [{ tool: 'notion-update-data-source', targetId: 'db-1', summary: 'Add Completed checkbox' }],
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
    expect(host.querySelector('details')?.open).toBe(false)
    expect(host.querySelector('details')?.textContent).toContain('Daily Log')
    expect(host.querySelector('[data-testid="approve-plan-1"]')?.textContent).toBe('Approve and continue')
    await act(async () => (host.querySelector('[data-testid="approve-plan-1"]') as HTMLButtonElement).click())
    expect(decision).toBe('approved')
    expect(useNoxStore.getState().pendingPlans).toHaveLength(0)
    await act(async () => root.unmount())
  })
})
