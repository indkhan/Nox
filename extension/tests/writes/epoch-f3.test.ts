import { beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from '../../src/lib/oauth/tokens'
import type { TokenResponse } from '../../src/lib/oauth/discovery'
import { memoryStore } from '../../src/lib/storage'

function tokenResponse(over: Partial<TokenResponse> = {}): TokenResponse {
  return { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, ...over }
}

function makeDeps(over: Partial<ConstructorParameters<typeof TokenStore>[0]> = {}) {
  const session = memoryStore()
  const local = memoryStore()
  return {
    session,
    local,
    fetchImpl: (async () =>
      new Response(JSON.stringify(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' })), {
        status: 200,
      })) as typeof fetch,
    getClientId: async () => 'client-1',
    now: () => 1_000_000,
    ...over,
  }
}

describe('Epoch F3.1 — R5 login-attempt generation (single instance)', () => {
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    deps = makeDeps()
  })

  it('fresh attempt login still persists credentials', async () => {
    const s = new TokenStore(deps)
    const attempt = await s.beginLogin()
    expect(typeof attempt).toBe('string')
    await s.saveFromTokenResponse(tokenResponse(), attempt)
    expect(await s.getAccessToken()).toBe('at-1')
    expect(await s.hasRefreshToken()).toBe(true)
  })

  it('late save after wipe is rejected with zero credentials', async () => {
    const s = new TokenStore(deps)
    const attempt = await s.beginLogin()
    await s.wipe()
    await expect(s.saveFromTokenResponse(tokenResponse(), attempt)).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    expect(await s.getAccessToken()).toBeNull()
    expect(await s.hasRefreshToken()).toBe(false)
    expect((await deps.session.get())['notion.access']).toBeUndefined()
  })

  it('late save after sign-out is rejected with zero credentials', async () => {
    const s = new TokenStore(deps)
    const seed = new TokenStore(deps)
    const seedAttempt = await seed.beginLogin()
    await seed.saveFromTokenResponse(tokenResponse(), seedAttempt)
    const attempt = await s.beginLogin()
    await s.signOut({})
    await expect(s.saveFromTokenResponse(tokenResponse({ access_token: 'at-late' }), attempt)).rejects.toThrow(
      /STALE_LOGIN_ATTEMPT/,
    )
    expect(await s.getAccessToken()).toBeNull()
    expect(await s.hasRefreshToken()).toBe(false)
  })

  it('older login cannot replace a newer login: A then B, complete B then A', async () => {
    const s = new TokenStore(deps)
    const attemptA = await s.beginLogin()
    const attemptB = await s.beginLogin()
    await s.saveFromTokenResponse(tokenResponse({ access_token: 'at-B', refresh_token: 'rt-B' }), attemptB)
    await expect(
      s.saveFromTokenResponse(tokenResponse({ access_token: 'at-A', refresh_token: 'rt-A' }), attemptA),
    ).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    expect(await s.getAccessToken()).toBe('at-B')
    expect(deps.local.data['notion.refresh']).toBe('rt-B')
  })
})
