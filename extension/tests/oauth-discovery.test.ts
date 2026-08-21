import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRegistrationRequest,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
  registerClient,
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
    expect(f).toHaveBeenCalledWith('https://mcp.notion.com/.well-known/oauth-protected-resource/mcp', undefined)
  })

  it('throws with status and body snippet on failure', async () => {
    const f = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(fetchProtectedResourceMetadata(f)).rejects.toThrow(/500.*nope/s)
  })
})

describe('fetchAuthorizationServerMetadata', () => {
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
