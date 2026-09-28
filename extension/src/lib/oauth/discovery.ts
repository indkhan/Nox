export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported?: string[]
  resource_name?: string
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in: number
  scope?: string
}

export interface RegistrationRequest {
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: ['authorization_code', 'refresh_token']
  response_types: ['code']
  application_type: 'native'
}

export interface RegistrationResponse {
  client_id: string
  client_id_issued_at?: number
  redirect_uris?: string[]
  token_endpoint_auth_method?: string
}

const MCP_ORIGIN = 'https://mcp.notion.com'
export const DISCOVERY_TIMEOUT_MS = 15_000

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: 'error' })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        /* body unreadable */
      }
      throw new Error(`GET ${url} → ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** RFC 9728 §4 + Notion's verified shape (RESEARCH §2.2). */
export function fetchProtectedResourceMetadata(
  fetchImpl: typeof fetch,
  mcpOrigin: string = MCP_ORIGIN,
): Promise<ProtectedResourceMetadata> {
  return fetchJson<ProtectedResourceMetadata>(fetchImpl, `${mcpOrigin}/.well-known/oauth-protected-resource/mcp`).then(prm => {
    if (prm?.resource !== `${mcpOrigin}/mcp` || !Array.isArray(prm.authorization_servers) || !prm.authorization_servers.length) {
      throw new Error('invalid protected resource metadata: resource or authorization_servers')
    }
    return prm
  })
}

/**
 * Resolves authorization-server metadata: protected-resource metadata first
 * (it lists the servers), falling back to the AS well-known directly.
 */
export async function fetchAuthorizationServerMetadata(
  fetchImpl: typeof fetch,
  mcpOrigin: string = MCP_ORIGIN,
): Promise<AuthorizationServerMetadata> {
  let server = mcpOrigin
  try {
    const prm = await fetchProtectedResourceMetadata(fetchImpl, mcpOrigin)
    server = prm.authorization_servers[0]
  } catch (error) {
    // Only absence permits legacy direct discovery; contradictory metadata fails closed.
    if (!(error instanceof Error) || !/→ 404/.test(error.message)) throw error
  }
  const issuer = new URL(server)
  if (issuer.origin !== mcpOrigin || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error('invalid authorization server issuer')
  const wellKnown = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`
  const meta = await fetchJson<AuthorizationServerMetadata>(fetchImpl, wellKnown)
  if (!meta || meta.issuer !== server || !Array.isArray(meta.code_challenge_methods_supported) ||
      !meta.code_challenge_methods_supported.includes('S256') ||
      !Array.isArray(meta.token_endpoint_auth_methods_supported) ||
      !meta.token_endpoint_auth_methods_supported.includes('none')) {
    throw new Error('invalid authorization server metadata: issuer, S256, or public client support')
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
    const value = meta[key]
    if (!value) continue
    let endpoint: URL
    try { endpoint = new URL(value) } catch { throw new Error(`invalid ${key}`) }
    if (endpoint.origin !== issuer.origin || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error(`invalid ${key}`)
    }
  }
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) throw new Error('missing OAuth endpoint')
  return meta
}

export function buildRegistrationRequest(redirectUri: string): RegistrationRequest {
  return {
    client_name: 'Nox',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'native',
  }
}

/** RFC 7591 dynamic client registration — public client, no secret (RESEARCH §2.2/§2.3). */
export async function registerClient(
  fetchImpl: typeof fetch,
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
): Promise<RegistrationResponse> {
  if (!metadata.registration_endpoint) {
    throw new Error('server advertises no registration_endpoint; DCR unavailable')
  }
  return fetchJson(fetchImpl, metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildRegistrationRequest(redirectUri)),
  })
}
