import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROACTIVE_FRACTION, TokenStore } from '../src/lib/oauth/tokens'
import type { TokenResponse } from '../src/lib/oauth/discovery'
import { memoryStore } from '../src/lib/storage'

function tokenResponse(over: Partial<TokenResponse> = {}): TokenResponse {
  return { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, ...over }
}

interface Call { store: 'local' | 'session'; keys: string[] }

/** Records set() call order across both stores to assert rotation ordering. */
function recordingStores() {
  const calls: Call[] = []
  const wrap = (name: 'local' | 'session') => {
    const base = memoryStore()
    return {
      base,
      get: base.get.bind(base),
      remove: async (keys: string | string[]) => {
        calls.push({ store: name, keys: Array.isArray(keys) ? keys : [keys] })
        await base.remove(keys)
      },
      set: async (items: Record<string, unknown>) => {
        calls.push({ store: name, keys: Object.keys(items) })
        await base.set(items)
      },
    }
  }
  const local = wrap('local')
  const session = wrap('session')
  const out = { local, session, calls }
  Object.defineProperty(local, 'data', { get: () => local.base.data })
  Object.defineProperty(session, 'data', { get: () => session.base.data })
  return out as typeof out & {
    local: typeof local & { readonly data: Record<string, unknown> }
    session: typeof session & { readonly data: Record<string, unknown> }
  }
}

describe('TokenStore', () => {
  let fetchCalls: Array<{ url: string; body: URLSearchParams }>
  let fetchImpl: typeof fetch
  let stores: ReturnType<typeof recordingStores>
  let reauthEvents: number
  let nowMs: number

  function makeStore() {
    return new TokenStore({
      session: stores.session,
      local: stores.local,
      fetchImpl,
      getClientId: async () => 'client-1',
      now: () => nowMs,
      onReauthRequired: () => {
        reauthEvents++
      },
    })
  }

  beforeEach(() => {
    fetchCalls = []
    fetchImpl = (async (url, init) => {
      fetchCalls.push({
        url: String(url),
        body: new URLSearchParams(String(init?.body ?? '')),
      })
      return new Response(
        JSON.stringify(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    stores = recordingStores()
    reauthEvents = 0
    nowMs = 1_000_000
  })

  afterEach(() => vi.useRealTimers())

  it('persists refresh token to local and access pair to session on save', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    expect(stores.local.data['notion.refresh']).toBe('rt-1')
    expect(stores.local.data['notion.workspaceId']).toBeUndefined()
    expect(stores.session.data['notion.access']).toBe('at-1')
    // refreshAt = issued + 80% lifetime
    expect(stores.session.data['notion.refreshAt']).toBe(nowMs + 3600 * 1000 * PROACTIVE_FRACTION)
  })

  it('writes the durable credential before the volatile one', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    const firstWrite = stores.calls.find((c) => c.keys.length > 0)
    expect(firstWrite?.store).toBe('local')
  })

  it('returns the access token while fresh without network calls', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    nowMs += 1000
    expect(await s.getAccessToken()).toBe('at-1')
    expect(fetchCalls).toHaveLength(0)
  })

  it('proactively refreshes once past 80% of lifetime', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    nowMs += Math.floor(3600 * 1000 * PROACTIVE_FRACTION) + 1
    expect(await s.getAccessToken()).toBe('at-2')
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body.get('grant_type')).toBe('refresh_token')
    expect(fetchCalls[0].body.get('client_id')).toBe('client-1')
  })

  it('recovers via refresh when session storage was lost (browser restart)', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await stores.session.remove(['notion.access', 'notion.refreshAt'])
    expect(await s.getAccessToken()).toBe('at-2')
  })

  it('returns null when signed out entirely', async () => {
    const s = makeStore()
    expect(await s.getAccessToken()).toBeNull()
  })

  it('coalesces concurrent refreshes into a single request', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    nowMs += Math.floor(3600 * 1000 * PROACTIVE_FRACTION) + 1
    const [a, b, c] = await Promise.all([
      s.getAccessToken(),
      s.getAccessToken(),
      s.getAccessToken(),
    ])
    expect(a).toBe('at-2')
    expect(b).toBe('at-2')
    expect(c).toBe('at-2')
    expect(fetchCalls).toHaveLength(1)
  })

  it('allows a second refresh after the first completed', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await s.refresh()
    await s.refresh()
    expect(fetchCalls).toHaveLength(2)
  })

  it('rotates both tokens on refresh', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    nowMs += Math.floor(3600 * 1000 * PROACTIVE_FRACTION) + 1
    await s.getAccessToken()
    expect(stores.local.data['notion.refresh']).toBe('rt-2')
    expect(stores.session.data['notion.access']).toBe('at-2')
  })

  it('treats invalid_grant as terminal: wipes and signals re-auth exactly once', async () => {
    fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    expect(await s.refresh()).toBe('reauth-required')
    expect(await s.hasRefreshToken()).toBe(false)
    expect((await stores.session.get())['notion.access']).toBeUndefined()
    expect(reauthEvents).toBe(1)
  })

  it('keeps old tokens on transient refresh failures', async () => {
    fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await expect(s.refresh()).rejects.toThrow(/500/)
    expect(await s.getAccessToken()).toBe('at-1') // still fresh, untouched
    expect(await s.hasRefreshToken()).toBe(true)
  })

  it('signOut revokes with the current refresh token then wipes everything', async () => {
    fetchImpl = (async (url, init) => {
      fetchCalls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await s.signOut({ revocation_endpoint: 'https://mcp.notion.com/token' })
    expect(fetchCalls[0].url).toBe('https://mcp.notion.com/token')
    expect(fetchCalls[0].body.get('token')).toBe('rt-1')
    expect(await s.hasRefreshToken()).toBe(false)
    expect((await stores.session.get())['notion.access']).toBeUndefined()
  })

  it('wipes even when revocation fails or is absent', async () => {
    fetchImpl = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await s.signOut({})
    expect(await s.hasRefreshToken()).toBe(false)
  })
})

describe('credential generations (Epoch 11 / M8)', () => {
  let fetchCalls: Array<{ url: string; body: URLSearchParams; signal?: AbortSignal }>
  let fetchImpl: typeof fetch
  let stores: ReturnType<typeof recordingStores>
  let reauthEvents: number
  let nowMs: number

  /** Mutual-exclusion lock so two TokenStore instances serialize like Web Locks. */
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

  function makeStore(lock = serialLock()) {
    return new TokenStore({
      session: stores.session,
      local: stores.local,
      fetchImpl,
      getClientId: async () => 'client-1',
      now: () => nowMs,
      lock,
      onReauthRequired: () => {
        reauthEvents++
      },
    })
  }

  function deferredTokenResponse(access: string, refresh: string) {
    let release!: (res: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    const impl = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')), signal: init?.signal as AbortSignal | undefined })
      return gate
    }) as typeof fetch
    return {
      impl,
      resolve: () =>
        release(new Response(JSON.stringify(tokenResponse({ access_token: access, refresh_token: refresh })), { status: 200 })),
    }
  }

  beforeEach(() => {
    fetchCalls = []
    fetchImpl = (async (url, init) => {
      fetchCalls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
      return new Response(JSON.stringify(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' })), { status: 200 })
    }) as typeof fetch
    stores = recordingStores()
    reauthEvents = 0
    nowMs = 1_000_000
  })

  afterEach(() => vi.useRealTimers())

  it('a refresh that resolves after sign-out writes nothing and stays signed out', async () => {
    const pending = deferredTokenResponse('at-stale', 'rt-stale')
    fetchImpl = pending.impl
    // Shared lock simulates the production shared Web Lock (`nox-credential-*`)
    // across panels: credential writes serialize, so the late refresh loses.
    const lock = serialLock()
    const s = makeStore(lock)
    await s.saveFromTokenResponse(tokenResponse())
    const refreshing = s.refresh()
    // Wait until the stale refresh has dispatched (old token in flight) before
    // the second panel signs out — otherwise the snapshot could race ahead.
    await vi.waitFor(() => expect(fetchCalls.some((c) => c.body.get('grant_type') === 'refresh_token')).toBe(true))
    // A second instance on the same storage signs out: generation bump plus
    // wipe land before the stale response resolves.
    await makeStore(lock).signOut({})
    pending.resolve()
    expect(await refreshing).toBe('no-token')
    expect(await s.hasRefreshToken()).toBe(false)
    expect((await stores.session.get())['notion.access']).toBeUndefined()
    expect(reauthEvents).toBe(0)
  })

  it('a new login wins over a stale in-flight refresh without wiping the new tokens', async () => {
    const pending = deferredTokenResponse('at-stale', 'rt-stale')
    fetchImpl = pending.impl
    const lock = serialLock()
    const s = makeStore(lock)
    await s.saveFromTokenResponse(tokenResponse())
    const refreshing = s.refresh()
    await vi.waitFor(() => expect(fetchCalls.some((c) => c.body.get('grant_type') === 'refresh_token')).toBe(true))
    await makeStore(lock).saveFromTokenResponse(tokenResponse({ access_token: 'at-new', refresh_token: 'rt-new' }))
    pending.resolve()
    expect(await refreshing).toBe('no-token')
    expect(stores.local.data['notion.refresh']).toBe('rt-new')
    expect(stores.session.data['notion.access']).toBe('at-new')
    expect(reauthEvents).toBe(0)
  })

  it('an old invalid_grant cannot wipe a newer login', async () => {
    let release!: (res: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    let dispatched = false
    fetchImpl = (async () => {
      dispatched = true
      return gate
    }) as typeof fetch
    const lock = serialLock()
    const s = makeStore(lock)
    await s.saveFromTokenResponse(tokenResponse())
    const failing = s.refresh()
    await vi.waitFor(() => expect(dispatched).toBe(true))
    await makeStore(lock).saveFromTokenResponse(tokenResponse({ access_token: 'at-new', refresh_token: 'rt-new' }))
    release(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    expect(await failing).toBe('no-token')
    expect(stores.local.data['notion.refresh']).toBe('rt-new')
    expect(stores.session.data['notion.access']).toBe('at-new')
    expect(reauthEvents).toBe(0)
  })

  it('two instances share one refresh instead of racing the token endpoint', async () => {
    const lock = serialLock()
    const a = makeStore(lock)
    const b = makeStore(lock)
    await a.saveFromTokenResponse(tokenResponse())
    const [first, second] = await Promise.all([a.refresh(), b.refresh()])
    expect(first).toBe('refreshed')
    expect(second).toBe('refreshed')
    expect(fetchCalls.filter((c) => c.body.get('grant_type') === 'refresh_token')).toHaveLength(1)
    expect(stores.local.data['notion.refresh']).toBe('rt-2')
  })

  it('clears local tokens before a hung revocation resolves', async () => {
    let releaseRevocation!: () => void
    const revocationGate = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    fetchImpl = (async (url) => {
      if (String(url).includes('revoke')) {
        await revocationGate
        return new Response(null, { status: 200 })
      }
      return new Response(JSON.stringify(tokenResponse()), { status: 200 })
    }) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    const signingOut = s.signOut({ revocation_endpoint: 'https://mcp.notion.com/revoke' })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Local sign-out is already complete while revocation still hangs.
    expect(await s.hasRefreshToken()).toBe(false)
    expect((await stores.session.get())['notion.access']).toBeUndefined()
    releaseRevocation()
    await signingOut
    expect(await s.hasRefreshToken()).toBe(false)
  })

  it('aborts a hung revocation after five seconds instead of waiting forever', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    fetchImpl = ((_url: unknown, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal | undefined
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    const signingOut = s.signOut({ revocation_endpoint: 'https://mcp.notion.com/revoke' })
    await vi.advanceTimersByTimeAsync(5000)
    await signingOut
    expect(observedSignal?.aborted).toBe(true)
    expect(await s.hasRefreshToken()).toBe(false)
  })

  it('a storage failure after remote rotation surfaces reauth-required, not success', async () => {
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    const innerSet = stores.local.set.bind(stores.local)
    let failures = 1
    stores.local.set = async (items: Record<string, unknown>) => {
      if (failures > 0 && 'notion.refresh' in items) {
        failures--
        throw new Error('disk full')
      }
      return innerSet(items)
    }
    expect(await s.refresh()).toBe('reauth-required')
    expect(reauthEvents).toBe(1)
    // The rotated server-side credential was never durably recorded.
    expect(stores.local.data['notion.refresh']).toBe('rt-1')
  })

  it('refuses malformed token responses without touching stored credentials', async () => {
    fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: '', refresh_token: 'rt-x', expires_in: -30 }), { status: 200 })) as typeof fetch
    const s = makeStore()
    await s.saveFromTokenResponse(tokenResponse())
    await expect(s.refresh()).rejects.toThrow(/token response/i)
    expect(stores.local.data['notion.refresh']).toBe('rt-1')
    expect(stores.session.data['notion.access']).toBe('at-1')
    await expect(makeStore().saveFromTokenResponse({ access_token: 'x', expires_in: Number.NaN } as TokenResponse)).rejects.toThrow(
      /token response/i,
    )
  })

  it('beginLogin invalidates an in-flight refresh so a replacement login cannot be resurrected (Epoch 11 / M8)', async () => {
    const pending = deferredTokenResponse('at-stale', 'rt-stale')
    fetchImpl = pending.impl
    const lock = serialLock()
    const s = makeStore(lock)
    await s.saveFromTokenResponse(tokenResponse())
    const refreshing = s.refresh()
    await vi.waitFor(() => expect(fetchCalls.some((c) => c.body.get('grant_type') === 'refresh_token')).toBe(true))
    // Start of a replacement login: aborts stale work and bumps generation.
    await s.beginLogin()
    await makeStore(lock).saveFromTokenResponse(tokenResponse({ access_token: 'at-new', refresh_token: 'rt-new' }))
    pending.resolve()
    expect(await refreshing).toBe('no-token')
    expect(stores.local.data['notion.refresh']).toBe('rt-new')
    expect(stores.session.data['notion.access']).toBe('at-new')
  })
})
