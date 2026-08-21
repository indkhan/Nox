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

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, init)
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
}

/** RFC 9728 §4 + Notion's verified shape (RESEARCH §2.2). */
export function fetchProtectedResourceMetadata(
  fetchImpl: typeof fetch,
  mcpOrigin: string = MCP_ORIGIN,
): Promise<ProtectedResourceMetadata> {
  return fetchJson(fetchImpl, `${mcpOrigin}/.well-known/oauth-protected-resource/mcp`)
}

/**
 * Resolves authorization-server metadata: protected-resource metadata first
 * (it lists the servers), falling back to the AS well-known directly.
 */
export async function fetchAuthorizationServerMetadata(
  fetchImpl: typeof fetch,
  mcpOrigin: string = MCP_ORIGIN,
): Promise<AuthorizationServerMetadata> {
  try {
    const prm = await fetchProtectedResourceMetadata(fetchImpl, mcpOrigin)
    const server = prm.authorization_servers[0]
    if (!server) throw new Error('no authorization_servers in protected-resource metadata')
    return await fetchJson(fetchImpl, `${server}/.well-known/oauth-authorization-server`)
  } catch (e) {
    // Direct fallback keeps us working if the PRM hop ever changes shape.
    return await fetchJson(fetchImpl, `${mcpOrigin}/.well-known/oauth-authorization-server`)
  }
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
