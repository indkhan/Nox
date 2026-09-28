import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRegistrationRequest,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
  registerClient,
  DISCOVERY_TIMEOUT_MS,
} from '../src/lib/oauth/discovery'
import { ClientRegistrar } from '../src/lib/oauth/dcr'
import { memoryStore } from '../src/lib/storage'

const PRM = {
  resource: 'https://mcp.notion.com/mcp',
  authorization_servers: ['https://mcp.notion.com'],
}

const AS = {
  issuer: 'https://mcp.notion.com',
  authorization_endpoint: 'https://mcp.notion.com/authorize',
  token_endpoint: 'https://mcp.notion.com/token',
  registration_endpoint: 'https://mcp.notion.com/register',
  code_challenge_methods_supported: ['plain', 'S256'],
  token_endpoint_auth_methods_supported: ['none'],
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.restoreAllMocks())

describe('fetchProtectedResourceMetadata', () => {
  it('hits the well-known endpoint', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes(PRM))
    expect(await fetchProtectedResourceMetadata(f)).toEqual(PRM)
    expect(f).toHaveBeenCalledWith('https://mcp.notion.com/.well-known/oauth-protected-resource/mcp', { redirect: 'error', signal: expect.any(AbortSignal) })
  })

  it('aborts a metadata response whose body stalls', async () => {
    vi.useFakeTimers()
    try {
      const f = vi.fn().mockImplementation((_url: string, init: RequestInit) => Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      }))
      const pending = fetchProtectedResourceMetadata(f)
      const rejected = expect(pending).rejects.toThrow(/aborted/)
      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws with status and body snippet on failure', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(fetchProtectedResourceMetadata(f)).rejects.toThrow(/500.*nope/s)
  })
})

describe('fetchAuthorizationServerMetadata', () => {
  it('rejects contradictory resource metadata instead of falling back', async () => {
    const f = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? { ...PRM, resource: 'https://evil.example/mcp' } : AS)))
    await expect(fetchAuthorizationServerMetadata(f)).rejects.toThrow(/resource/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('rejects unexpected endpoint origins and missing S256 support', async () => {
    const f = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? PRM : { ...AS, token_endpoint: 'https://evil.example/token' })))
    await expect(fetchAuthorizationServerMetadata(f)).rejects.toThrow(/token_endpoint/)
    const g = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? PRM : { ...AS, code_challenge_methods_supported: ['plain'] })))
    await expect(fetchAuthorizationServerMetadata(g)).rejects.toThrow(/S256/)
  })

  it('rejects malformed auth-method metadata and a mismatched issuer', async () => {
    const f = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? PRM : { ...AS, token_endpoint_auth_methods_supported: 'none' })))
    await expect(fetchAuthorizationServerMetadata(f)).rejects.toThrow(/public client/)
    const g = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? PRM : { ...AS, issuer: 'https://evil.example' })))
    await expect(fetchAuthorizationServerMetadata(g)).rejects.toThrow(/issuer/)
  })

  it('resolves a path-bearing issuer at the RFC well-known path', async () => {
    const server = 'https://mcp.notion.com/tenant'
    const f = vi.fn().mockImplementation((url: string) => Promise.resolve(jsonRes(url.includes('protected-resource') ? { ...PRM, authorization_servers: [server] } : { ...AS, issuer: server })))
    expect((await fetchAuthorizationServerMetadata(f)).issuer).toBe(server)
    expect(f.mock.calls[1][0]).toBe('https://mcp.notion.com/.well-known/oauth-authorization-server/tenant')
  })
  it('follows the protected-resource pointer to the server metadata', async () => {
    const f = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(url.includes('protected-resource') ? jsonRes(PRM) : jsonRes(AS)),
    )
    const meta = await fetchAuthorizationServerMetadata(f)
    expect(meta.issuer).toBe('https://mcp.notion.com')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('falls back to the direct well-known when PRM fails', async () => {
    const f = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('protected-resource') ? new Response('x', { status: 404 }) : jsonRes(AS),
      ),
    )
    expect((await fetchAuthorizationServerMetadata(f)).issuer).toBe('https://mcp.notion.com')
  })
})

describe('registerClient / ClientRegistrar', () => {
  it('sends an RFC 7591 public-client payload', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ client_id: 'abc123' }, 201))
    const res = await registerClient(f, AS, 'https://ext.chromiumapp.org/')
    expect(res.client_id).toBe('abc123')
    const [, init] = f.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      client_name: 'Nox',
      redirect_uris: ['https://ext.chromiumapp.org/'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    })
  })

  it('buildRegistrationRequest matches the verified shape', () => {
    expect(buildRegistrationRequest('r')).toEqual({
      client_name: 'Nox',
      redirect_uris: ['r'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
    })
  })

  it('caches client_id in local storage across calls', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ client_id: 'id-1' }, 201))
    const local = memoryStore()
    const registrar = new ClientRegistrar(f, local)
    expect(await registrar.getClientId(AS, 'r')).toBe('id-1')
    expect(await registrar.getClientId(AS, 'r')).toBe('id-1')
    expect(f).toHaveBeenCalledTimes(1)
    expect(local.data['notion.client_id']).toBe('id-1')
  })

  it('re-registers after forget()', async () => {
    let n = 0
    const f = vi.fn().mockImplementation(() => jsonRes({ client_id: `id-${++n}` }, 201))
    const registrar = new ClientRegistrar(f, memoryStore())
    await registrar.getClientId(AS, 'r')
    await registrar.forget()
    expect(await registrar.getClientId(AS, 'r')).toBe('id-2')
  })

  it('refuses to register when the server has no registration endpoint', async () => {
    const registrar = new ClientRegistrar(vi.fn(), memoryStore())
    await expect(registrar.getClientId({ ...AS, registration_endpoint: undefined }, 'r')).rejects.toThrow(
      /registration_endpoint/,
    )
  })
})
