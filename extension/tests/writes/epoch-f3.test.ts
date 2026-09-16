import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenStore } from '../../src/lib/oauth/tokens'
import type { TokenResponse } from '../../src/lib/oauth/discovery'
import { memoryStore } from '../../src/lib/storage'
import { Notion } from '../../src/lib/notion'

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

describe('Epoch F3.3 — R5 facade and completion binding', () => {
  const PRM = { resource: 'https://mcp.notion.com/mcp', authorization_servers: ['https://mcp.notion.com'] }
  const AS = {
    issuer: 'https://mcp.notion.com',
    authorization_endpoint: 'https://mcp.notion.com/authorize',
    token_endpoint: 'https://mcp.notion.com/token',
    registration_endpoint: 'https://mcp.notion.com/register',
  }
  const SELF_TEXT = JSON.stringify({
    title: 'Acme',
    self: {
      workspace: { id: '11111111-2222-3333-4444-555555555555', name: 'Acme' },
      user: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Dana', email: 'dana@example.com' },
    },
  })

  function jsonRes(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status })
  }

  function rpcResult(id: number | null, result: unknown) {
    return jsonRes({ jsonrpc: '2.0', id, result })
  }

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

  interface FacadeHarness {
    notion: Notion
    session: ReturnType<typeof memoryStore>
    local: ReturnType<typeof memoryStore>
    tokenHits: string[]
    identityCalls: number
  }

  function makeFacade(opts: { holdSelfFetch?: { gate: Promise<void>; firstOnly?: boolean }; lock?: ReturnType<typeof serialLock> } = {}): FacadeHarness {
    const session = memoryStore()
    const local = memoryStore()
    const tokenHits: string[] = []
    let identityCalls = 0
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      const bodyText = String((init as { body?: unknown })?.body ?? '')
      let body: Record<string, unknown> = {}
      try {
        body = bodyText.startsWith('{') ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      if (u.includes('protected-resource')) return jsonRes(PRM)
      if (u.includes('oauth-authorization-server')) return jsonRes(AS)
      if (u.endsWith('/register')) return jsonRes({ client_id: 'cid-1' }, 201)
      if (u.endsWith('/token')) {
        tokenHits.push(u)
        const params = new URLSearchParams(bodyText)
        const grant = params.get('grant_type')
        if (grant === 'authorization_code') return jsonRes({ access_token: `at-${tokenHits.length}`, refresh_token: `rt-${tokenHits.length}`, expires_in: 3600 })
        return jsonRes({ access_token: 'at-r', refresh_token: 'rt-r', expires_in: 3600 })
      }
      if (typeof body.method === 'string') {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id as number, result: {} })
        if (body.method === 'tools/call') {
          const params = body.params as { name?: string }
          if (params?.name === 'notion-fetch') {
            identityCalls++
            // Hold only the first self fetch (attempt A's identity) so a
            // newer login B can still complete while A is in flight.
            if (opts.holdSelfFetch && (!opts.holdSelfFetch.firstOnly || identityCalls === 1)) {
              await opts.holdSelfFetch.gate
            }
            return rpcResult(body.id as number, { content: [{ type: 'text', text: SELF_TEXT }] })
          }
          return rpcResult(body.id as number, { content: [{ type: 'text', text: 'ok' }] })
        }
        if ((body.method as string).startsWith('notifications/')) return new Response(null, { status: 202 })
      }
      throw new Error(`unexpected ${u}`)
    }) as typeof fetch
    const notion = new Notion({
      fetchImpl,
      session,
      local,
      redirectUri: () => 'https://ext.chromiumapp.org/',
      lock: opts.lock,
    } as Parameters<typeof Notion>[0])
    return { notion, session, local, tokenHits, get identityCalls() { return identityCalls } }
  }

  function deferred<T = void>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  function consentFor(authorizeUrl: string): string {
    const u = new URL(authorizeUrl)
    const state = u.searchParams.get('state') ?? 's'
    return `https://ext.chromiumapp.org/?code=xyz&state=${state}&iss=${encodeURIComponent('https://mcp.notion.com')}`
  }

  it('held consent plus wipe rejects with zero credentials and no identity', async () => {
    const h = makeFacade()
    const connBefore = h.notion.connectionGeneration
    const consentGate = deferred<string>()
    let authorizeUrl = ''
    const connecting = h.notion.connect(async (url) => {
      authorizeUrl = url
      return consentGate.promise
    })
    // Wait until consent is actually pending (discovery + DCR done).
    for (let i = 0; i < 500 && !authorizeUrl; i++) await new Promise((r) => setTimeout(r, 0))
    expect(authorizeUrl).toMatch(/response_type=code/)
    await h.notion.tokens.wipe()
    consentGate.resolve(consentFor(authorizeUrl))
    await expect(connecting).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    expect(await h.notion.tokens.hasRefreshToken()).toBe(false)
    expect(await h.notion.tokens.getAccessToken()).toBeNull()
    expect(h.notion.identity).toBeNull()
    expect(h.notion.capabilities.isEmpty).toBe(true)
    expect(h.notion.connectionGeneration).toBe(connBefore)
  })

  it('A then B on one facade: only B survives with exact transport counts', async () => {
    const h = makeFacade()
    const gateA = deferred<string>()
    const gateB = deferred<string>()
    let urlA = ''
    let urlB = ''
    const pA = h.notion.connect(async (url) => {
      urlA = url
      return gateA.promise
    })
    // Second login starts after the first captured its attempt (both pending consent).
    await new Promise((r) => setTimeout(r, 10))
    const pB = h.notion.connect(async (url) => {
      urlB = url
      return gateB.promise
    })
    for (let i = 0; i < 500 && (!urlA || !urlB); i++) await new Promise((r) => setTimeout(r, 0))
    gateB.resolve(consentFor(urlB))
    const infoB = await pB
    expect(infoB.identity.userName).toBe('Dana')
    gateA.resolve(consentFor(urlA))
    await expect(pA).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    // B's credentials survive; A's late exchange never overwrote them.
    expect(await h.notion.tokens.getAccessToken()).toContain('at-')
    expect(h.notion.identity?.userName).toBe('Dana')
    // Both attempts reached the token endpoint, but only B's save committed.
    expect(h.tokenHits.filter((u) => u.endsWith('/token'))).toHaveLength(2)
  })

  it('stale identity completion after a newer login does not report connected', async () => {
    const releaseSelf = deferred<void>()
    const h = makeFacade({ holdSelfFetch: { gate: releaseSelf.promise, firstOnly: true } })
    const gateA = deferred<string>()
    let urlA = ''
    const pA = h.notion.connect(async (url) => {
      urlA = url
      return gateA.promise
    })
    for (let i = 0; i < 500 && !urlA; i++) await new Promise((r) => setTimeout(r, 0))
    gateA.resolve(consentFor(urlA))
    // A's token exchange + save complete, then identity (self fetch) holds.
    for (let i = 0; i < 500 && h.tokenHits.length < 1; i++) await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 500 && h.identityCalls < 1; i++) await new Promise((r) => setTimeout(r, 0))
    const connDuring = h.notion.connectionGeneration
    // Newer login B completes fully while A's identity is still in flight.
    const infoB = await h.notion.connect(async (url) => consentFor(url))
    expect(infoB.identity.userName).toBe('Dana')
    const connB = h.notion.connectionGeneration
    expect(connB).not.toBe(connDuring)
    releaseSelf.resolve()
    await expect(pA).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    // B's session survives; the stale completion did not disconnect it.
    expect(await h.notion.tokens.hasRefreshToken()).toBe(true)
    expect(h.notion.identity?.userName).toBe('Dana')
    expect(h.notion.connectionGeneration).toBe(connB)
  })

  it('fresh login still connects with identity and bumps generation', async () => {
    const h = makeFacade()
    const before = h.notion.connectionGeneration
    const info = await h.notion.connect(async (url) => consentFor(url))
    expect(info.identity.userName).toBe('Dana')
    expect(h.notion.identity?.userName).toBe('Dana')
    expect(h.notion.connectionGeneration).not.toBe(before)
    expect(await h.notion.tokens.hasRefreshToken()).toBe(true)
  })

  it('A then B across facades sharing storage and locks: only B survives', async () => {
    const session = memoryStore()
    const local = memoryStore()
    const lock = serialLock()
    const mk = () =>
      new Notion({
        fetchImpl: (async (url: unknown, init?: RequestInit) => {
          const u = String(url)
          const bodyText = String((init as { body?: unknown })?.body ?? '')
          let body: Record<string, unknown> = {}
          try {
            body = bodyText.startsWith('{') ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
          } catch {
            body = {}
          }
          if (u.includes('protected-resource')) return jsonRes(PRM)
          if (u.includes('oauth-authorization-server')) return jsonRes(AS)
          if (u.endsWith('/register')) return jsonRes({ client_id: 'cid-1' }, 201)
          if (u.endsWith('/token')) return jsonRes({ access_token: `at-${u.length}-${Math.random().toString(36).slice(2, 6)}`, refresh_token: 'rt-shared', expires_in: 3600 })
          if (typeof body.method === 'string') {
            if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id as number, result: {} })
            if (body.method === 'tools/call') return rpcResult(body.id as number, { content: [{ type: 'text', text: SELF_TEXT }] })
            if ((body.method as string).startsWith('notifications/')) return new Response(null, { status: 202 })
          }
          throw new Error(`unexpected ${u}`)
        }) as typeof fetch,
        session,
        local,
        redirectUri: () => 'https://ext.chromiumapp.org/',
        lock,
      } as Parameters<typeof Notion>[0])
    const fa = mk()
    const fb = mk()
    const gateA = deferred<string>()
    let urlA = ''
    const pA = fa.connect(async (url) => {
      urlA = url
      return gateA.promise
    })
    for (let i = 0; i < 500 && !urlA; i++) await new Promise((r) => setTimeout(r, 0))
    const infoB = await fb.connect(async (url) => consentFor(url))
    expect(infoB.identity.userName).toBe('Dana')
    gateA.resolve(consentFor(urlA))
    await expect(pA).rejects.toThrow(/STALE_LOGIN_ATTEMPT/)
    expect(await fb.tokens.hasRefreshToken()).toBe(true)
    expect(fb.identity?.userName).toBe('Dana')
  })
})
