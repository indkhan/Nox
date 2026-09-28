import { describe, expect, it } from 'vitest'
import { classifyBridgeFailure, healthHint } from '../../src/lib/codex/health'

describe('classifyBridgeFailure', () => {
  it.each([
    ['bridge ping timed out — is the native host installed?', 'bridge-missing'],
    ['bridge port disconnected', 'bridge-missing'],
    ['codex not running (state=dead)', 'codex-missing'],
    ['Codex 0.157.1 is untested by this Nox revision. Set NOX_EXPERIMENTAL_CODEX=1 to opt in.', 'codex-incompatible'],
    ['[-32000] Please run codex login first', 'login-expired'],
    ['You have hit your usage limit', 'quota-exhausted'],
    ['[-32001] Server overloaded; retry later', 'overloaded'],
  ])('classifies %s → %s', (message, expected) => {
    expect(classifyBridgeFailure(message)).toBe(expected)
  })

  it('falls back to unknown', () => {
    expect(classifyBridgeFailure('something weird')).toBe('unknown')
  })
})

describe('healthHint', () => {
  it('gives an actionable command for each state', () => {
    expect(healthHint('bridge-missing')).toMatch(/install\.mjs/)
    expect(healthHint('codex-missing')).toMatch(/npm i -g @openai\/codex/)
    expect(healthHint('codex-incompatible')).toMatch(/NOX_EXPERIMENTAL_CODEX=1/)
    expect(healthHint('login-expired')).toMatch(/codex login/)
    expect(healthHint('overloaded')).toMatch(/retry/i)
  })

  it('is empty when healthy', () => {
    expect(healthHint('ok')).toBe('')
  })
})
