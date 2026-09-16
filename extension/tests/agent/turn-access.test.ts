import { describe, expect, it } from 'vitest'
import { createTurnAccessState, MAX_UNPLANNED_EFFECTS } from '../../src/lib/agent/turn-access'

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

  it('captures a normalized small-edit grant at send in Auto only', () => {
    const state = createTurnAccessState()
    state.begin('auto', ['p1'], [], { allowed: true, pages: ['A1B2C3D4E5F64789ABCDEF0123456789'] })
    expect(state.smallEditGrant()).toEqual({
      allowed: true,
      pages: ['a1b2c3d4-e5f6-4789-abcd-ef0123456789'],
    })

    state.begin('ask', ['p1'], [], { allowed: true, pages: ['p1'] })
    expect(state.smallEditGrant().allowed).toBe(false)
  })

  it('resets the grant for the next turn', () => {
    const state = createTurnAccessState()
    state.begin('auto', ['p1'], [], { allowed: true, pages: ['p1'] })
    state.begin('auto', ['p1'])
    expect(state.smallEditGrant()).toEqual({ allowed: false, pages: [] })
  })

  it('caps unplanned effects at five counted objects without release', () => {
    expect(MAX_UNPLANNED_EFFECTS).toBe(5)
    const state = createTurnAccessState()
    state.begin('auto', [])
    expect(state.recordUnplannedEffects(2)).toBe(true)
    expect(state.recordUnplannedEffects(2)).toBe(true)
    expect(state.recordUnplannedEffects(2)).toBe(false)
    expect(state.recordUnplannedEffects(1)).toBe(true)
    expect(state.recordUnplannedEffects(1)).toBe(false)
  })
})
