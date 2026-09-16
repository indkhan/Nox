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

describe('Epoch F3.2 — R5 cross-instance invalidation and preservation', () => {
  function serialLock() {
    const tails = new Map<string, Promise<void>>()
    return {
      runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const tail = tails.get(name) ?? Promise.resolve()
        const run = tail.then(fn, fn)
        tails.set(
          name,
          run.then(
            () => undefined,
            () => undefined,
          ),
        )
        return run
      },
    }
  }

  function sharedDeps(lock: ReturnType<typeof serialLock>) {
    const session = memoryStore()
    const local = memoryStore()
    const base = {
      session,
      local,
      fetchImpl: (async () =>
        new Response(JSON.stringify(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' })), {
          status: 200,
        })) as typeof fetch,
      getClientId: async () => 'client-1',
      now: () => 1_000_000,
      lock,
    }
    return { session, local, base }
  }

  it('stale attempt is rejected across instances sharing storage and locks', async () => {
    const lock = serialLock()
    const { session, local, base } = sharedDeps(lock)
    const a = new TokenStore(base)
    const b = new TokenStore({ ...base })
    const attemptA = await a.beginLogin()
    // Second panel wipes while A's consent/token exchange is still pending.
    await b.wipe()
    await expect(a.saveFromTokenResponse(tokenResponse({ access_token: 'at-A' }), attemptA)).rejects.toThrow(
      /STALE_LOGIN_ATTEMPT/,
    )
    expect(await a.getAccessToken()).toBeNull()
    expect(await b.getAccessToken()).toBeNull()
    expect((await session.get())['notion.access']).toBeUndefined()
    expect((await local.get('notion.refresh'))['notion.refresh']).toBeUndefined()
  })

  it('A then B across instances: only B survives with exact credentials', async () => {
    const lock = serialLock()
    const { base, local } = sharedDeps(lock)
    const a = new TokenStore(base)
    const b = new TokenStore({ ...base })
    const attemptA = await a.beginLogin()
    const attemptB = await b.beginLogin()
    await b.saveFromTokenResponse(tokenResponse({ access_token: 'at-B', refresh_token: 'rt-B' }), attemptB)
    await expect(a.saveFromTokenResponse(tokenResponse({ access_token: 'at-A', refresh_token: 'rt-A' }), attemptA)).rejects.toThrow(
      /STALE_LOGIN_ATTEMPT/,
    )
    expect(await a.getAccessToken()).toBe('at-B')
    expect(await b.getAccessToken()).toBe('at-B')
    expect((await local.get('notion.refresh'))['notion.refresh']).toBe('rt-B')
  })

  it('isLoginAttemptCurrent tracks wipe and replacement login', async () => {
    const lock = serialLock()
    const { base } = sharedDeps(lock)
    const s = new TokenStore(base)
    const attempt = await s.beginLogin()
    expect(await s.isLoginAttemptCurrent(attempt)).toBe(true)
    await s.wipe()
    expect(await s.isLoginAttemptCurrent(attempt)).toBe(false)
    const fresh = await s.beginLogin()
    expect(await s.isLoginAttemptCurrent(fresh)).toBe(true)
    expect(await s.isLoginAttemptCurrent(attempt)).toBe(false)
  })

  it('successful fresh attempt login still rotates via refresh', async () => {
    const lock = serialLock()
    const { base, local } = sharedDeps(lock)
    const s = new TokenStore(base)
    const attempt = await s.beginLogin()
    await s.saveFromTokenResponse(tokenResponse(), attempt)
    expect(await s.refresh()).toBe('refreshed')
    expect((await local.get('notion.refresh'))['notion.refresh']).toBe('rt-2')
  })

  it('storage failure during attempt save fails closed without false success', async () => {
    const lock = serialLock()
    const { base, local } = sharedDeps(lock)
    const s = new TokenStore(base)
    const attempt = await s.beginLogin()
    const innerSet = base.local.set.bind(base.local)
    base.local.set = async (items: Record<string, unknown>) => {
      if ('notion.access' in items || 'notion.refresh' in items) throw new Error('disk full')
      return innerSet(items)
    }
    await expect(s.saveFromTokenResponse(tokenResponse(), attempt)).rejects.toThrow(/disk full/)
    expect(await s.isLoginAttemptCurrent(attempt)).toBe(true)
    expect((await local.get('notion.refresh'))['notion.refresh']).toBeUndefined()
  })
})
