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
