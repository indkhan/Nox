import { describe, expect, it } from 'vitest'
import { createTurnAccessState } from '../../src/lib/agent/turn-access'

describe('turn access state', () => {
  it('snapshots the selected mode for each turn', () => {
    const state = createTurnAccessState()

    state.begin('auto', [])
    expect(state.mode()).toBe('auto')

    state.begin('ask', [])
    expect(state.mode()).toBe('ask')
  })

  it('clears attached pages when the next turn has none', () => {
    const state = createTurnAccessState()

    state.begin('auto', ['old-page'])
    state.begin('auto', [])

    expect([...state.contextPages()]).toEqual([])
  })
})
