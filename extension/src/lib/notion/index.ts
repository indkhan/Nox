import { ClientRegistrar } from '../oauth/dcr'
import {
  fetchAuthorizationServerMetadata,
  type AuthorizationServerMetadata,
} from '../oauth/discovery'
import { TokenStore } from '../oauth/tokens'
import type { KeyValueStore } from '../storage'
import { McpClient, type McpCallResult, type McpTool } from '../mcp/client'
import { Scheduler } from '../mcp/scheduler'
import { classifyError } from '../mcp/errors'
import { CapabilityGate, parseSelfResult, type SelfInfo } from './capabilities'

/**
 * The one object the rest of the app talks to for everything Notion.
 * Assembly point for TokenStore + McpClient + Scheduler + CapabilityGate —
 * this is the only file in lib/notion allowed to know about all of them.
 */
export class Notion {
  readonly scheduler = new Scheduler()
  client: McpClient
  private metadata: AuthorizationServerMetadata | null = null
  private registrar: ClientRegistrar
  private tokenStore: TokenStore
  private gate: CapabilityGate = new CapabilityGate()
  private selfInfo: SelfInfo | null = null

  constructor(
    private readonly deps: {
      fetchImpl: typeof fetch
      session: KeyValueStore
      local: KeyValueStore
      redirectUri: () => string
    },
  ) {
    const { fetchImpl, session, local } = deps
    this.registrar = new ClientRegistrar(fetchImpl, local)
    this.tokenStore = new TokenStore({
      session,
      local,
      fetchImpl,
      getClientId: async () => {
        if (!this.metadata) await this.loadMetadata()
        return this.registrar.getClientId(this.metadata!, this.deps.redirectUri())
      },
    })
    this.client = new McpClient({ fetchImpl, getAccessToken: () => this.tokenStore.getAccessToken() })
  }

  get tokens(): TokenStore {
    return this.tokenStore
  }

  get capabilities(): CapabilityGate {
    return this.gate
  }

  get identity(): SelfInfo['identity'] | null {
    return this.selfInfo?.identity ?? null
  }

  async loadMetadata(): Promise<AuthorizationServerMetadata> {
    if (!this.metadata) {
      this.metadata = await fetchAuthorizationServerMetadata(this.deps.fetchImpl)
    }
    return this.metadata
  }

  /** Full browser flow: discovery → DCR → consent → token exchange. */
  async connect(launchConsent: (authorizeUrl: string) => Promise<string>): Promise<SelfInfo> {
    const metadata = await this.loadMetadata()
    const clientId = await this.registrar.getClientId(metadata, this.deps.redirectUri())

    const { generateCodeChallenge, generateCodeVerifier, generateState } = await import('../oauth/pkce')
    const verifier = await generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)
    const state = generateState()

    const url = new URL(metadata.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', this.deps.redirectUri())
    url.searchParams.set('scope', 'default')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('prompt', 'consent')

    const redirected = await launchConsent(url.toString())
    const back = new URL(redirected)
    const error = back.searchParams.get('error')
    if (error) throw new Error(`authorization failed: ${error}`)
    if (back.searchParams.get('state') !== state) throw new Error('OAuth state mismatch')
    const iss = back.searchParams.get('iss')
    if (iss && iss !== metadata.issuer) throw new Error(`OAuth issuer mismatch: ${iss}`)

    const tokenResponse = await exchangeCode(this.deps.fetchImpl, metadata, {
      code: back.searchParams.get('code') ?? '',
      redirectUri: this.deps.redirectUri(),
      clientId,
      codeVerifier: verifier,
    })
    await this.tokenStore.saveFromTokenResponse(tokenResponse)
    return this.refreshIdentity()
  }

  /** Dev escape hatch: import a token JSON without the consent flow. */
  async importToken(token: Parameters<TokenStore['saveFromTokenResponse']>[0]): Promise<SelfInfo> {
    await this.tokenStore.saveFromTokenResponse(token)
    return this.refreshIdentity()
  }

  /**
   * MCP handshake + identity/capability load. Safe to call repeatedly; also
   * recovers a session after the browser restarted (access token was lost but
   * the refresh token survived).
   */
  async refreshIdentity(): Promise<SelfInfo> {
    await this.client.initialize()
    const self = await this.scheduleCallTool('notion-fetch', { id: 'self' })
    const text = McpClient.resultText(self)
    this.selfInfo = parseSelfResult(text)
    this.gate = new CapabilityGate(this.selfInfo.access)
    return this.selfInfo
  }

  async listTools(): Promise<McpTool[]> {
    return this.scheduler.schedule('global', () => this.client.listTools())
  }

  /** Scheduled tool call; transient failures retry inside the scheduler. */
  scheduleCallTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    // Search has its own slower bucket; everything else rides the global one.
    const bucket = name === 'notion-search' ? 'search' : 'global'
    return this.scheduler.schedule(bucket, () => this.client.callTool(name, args))
  }

  readResource(uri: string): Promise<Array<{ uri: string; text?: string; mimeType?: string }>> {
    return this.scheduler.schedule('global', () => this.client.readResource(uri))
  }

  /** Classified failure helper for UI surfaces that catch directly. */
  explain(error: unknown): ReturnType<typeof classifyError> {
    return classifyError(error)
  }

  async signOut(): Promise<void> {
    const metadata = await this.metadata
    await this.tokenStore.signOut(metadata ?? {})
    this.gate = new CapabilityGate()
    this.selfInfo = null
    this.client = new McpClient({
      fetchImpl: this.deps.fetchImpl,
      getAccessToken: () => this.tokenStore.getAccessToken(),
    })
  }
}

async function exchangeCode(
  fetchImpl: typeof fetch,
  metadata: AuthorizationServerMetadata,
  p: { code: string; redirectUri: string; clientId: string; codeVerifier: string },
): Promise<Parameters<TokenStore['saveFromTokenResponse']>[0]> {
  const res = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.codeVerifier,
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Parameters<TokenStore['saveFromTokenResponse']>[0]
}

