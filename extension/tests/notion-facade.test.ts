import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Notion } from '../src/lib/notion'
import { memoryStore } from '../src/lib/storage'

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
    current_tool_access: {
      search: { status: 'available' },
      query_meeting_notes: { status: 'upgrade_required' },
    },
  },
})

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

function rpcResult(id: number | null, result: unknown) {
  return jsonRes({ jsonrpc: '2.0', id, result })
}

describe('Notion facade', () => {
  let fetchCalls: Array<{ url: string; init?: RequestInit }>
  let fetchImpl: typeof fetch
  let local: ReturnType<typeof memoryStore>
  let session: ReturnType<typeof memoryStore>
  let notion: Notion

  function scripted(responder: (url: string, body: Record<string, unknown>) => Response) {
    fetchImpl = (async (url, init) => {
      const isJson = String(((init?.headers ?? {}) as Record<string, string>)['content-type'] ?? '').includes('json')
      const body = init?.body && isJson ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      fetchCalls.push({ url: String(url), init })
      return responder(String(url), body)
    }) as typeof fetch
    local = memoryStore()
    session = memoryStore()
    notion = new Notion({
      fetchImpl,
      session,
      local,
      redirectUri: () => 'https://ext.chromiumapp.org/',
    })
  }

  beforeEach(() => {
    fetchCalls = []
  })

  function standardServer() {
    scripted((url, body) => {
      if (url.includes('protected-resource')) return jsonRes(PRM)
      if (url.includes('oauth-authorization-server')) return jsonRes(AS)
      if (url.endsWith('/register')) return jsonRes({ client_id: 'cid-1' }, 201)
      if (url.endsWith('/token')) return jsonRes({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
      if (url.endsWith('/authorize')) throw new Error('not fetched server-side')
      if (typeof body.method === 'string') {
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id as number, result: {} }, 200, { 'mcp-session-id': 's1' })
        if (body.method === 'tools/list') return rpcResult(body.id as number, { tools: [{ name: 'notion-fetch' }] })
        if (body.method === 'tools/call') {
          const params = body.params as { name: string }
          return rpcResult(body.id as number, {
            content: [{ type: 'text', text: params.name === 'notion-fetch' ? SELF_TEXT : 'ok' }],
          })
        }
        if (body.method === 'resources/read') return rpcResult(body.id as number, { contents: [] })
        if (body.method?.startsWith('notifications/')) return new Response(null, { status: 202 })
      }
      throw new Error(`unexpected ${url}`)
    })
  }

  it('connect() walks discovery → DCR → consent → exchange → identity', async () => {
    standardServer()
    const launchConsent = vi.fn(async (authorizeUrl: string) => {
      expect(authorizeUrl).toMatch(/response_type=code/)
      expect(authorizeUrl).toMatch(/code_challenge_method=S256/)
      expect(authorizeUrl).toMatch(/client_id=cid-1/)
      const u = new URL(authorizeUrl)
      return `https://ext.chromiumapp.org/?code=xyz&state=${u.searchParams.get('state')}&iss=${encodeURIComponent('https://mcp.notion.com')}`
    })
    const info = await notion.connect(launchConsent)
    expect(launchConsent).toHaveBeenCalledOnce()
    expect(info.identity.userName).toBe('Dana')
    expect(notion.capabilities.can('notion-search').allowed).toBe(true)
    expect(local.data['notion.refresh']).toBeDefined()
  })

  it('connect() rejects on state mismatch', async () => {
    standardServer()
    const launchConsent = vi.fn(async () => 'https://ext.chromiumapp.org/?code=xyz&state=tampered')
    await expect(notion.connect(launchConsent)).rejects.toThrow(/state mismatch/)
  })

  it('connect() rejects when the server reports an error redirect', async () => {
    standardServer()
    await expect(
      notion.connect(async () => 'https://ext.chromiumapp.org/?error=access_denied'),
    ).rejects.toThrow(/access_denied/)
  })

  it('importToken() skips consent and loads identity', async () => {
    standardServer()
    const info = await notion.importToken({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    expect(info.access['search']).toBe('available')
  })

  it('scheduleCallTool routes search through the search bucket and others globally', async () => {
    standardServer()
    await notion.importToken({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    await Promise.all([
      notion.scheduleCallTool('notion-search', { query: 'a' }),
      notion.scheduleCallTool('notion-fetch', { id: 'self' }),
      notion.scheduleCallTool('notion-fetch', { id: 'x' }),
    ])
    const toolCalls = fetchCalls.filter((c) => String(c.init?.body ?? '').includes('tools/call'))
    // 1 self-fetch from importToken's identity load + the 3 scheduled calls.
    expect(toolCalls).toHaveLength(4)
  })

  it('listTools returns discovered tools after auth', async () => {
    standardServer()
    await notion.importToken({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    expect((await notion.listTools()).map((t) => t.name)).toEqual(['notion-fetch'])
  })

  it('signOut clears tokens, capabilities and identity', async () => {
    standardServer()
    await notion.importToken({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    await notion.signOut()
    expect(await notion.tokens.hasRefreshToken()).toBe(false)
    expect(notion.capabilities.isEmpty).toBe(true)
    expect(notion.identity).toBeNull()
  })

  it('explain() exposes the classifier for UI callers', () => {
    standardServer()
    expect(notion.explain(new Error('Failed to fetch')).kind).toBe('transient')
  })
})
