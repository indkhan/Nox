import type { AuthorizationServerMetadata, TokenResponse } from './discovery'
import type { KeyValueStore } from '../storage'

const K_ACCESS = 'notion.access'
const K_REFRESH_AT = 'notion.refreshAt'
const K_REFRESH = 'notion.refresh'
const K_WORKSPACE = 'notion.workspaceId'

/** Fraction of lifetime after which we proactively refresh (MVP §4.8: 80%). */
export const PROACTIVE_FRACTION = 0.8

export interface TokenStoreDeps {
  session: KeyValueStore
  local: KeyValueStore
  fetchImpl: typeof fetch
  getClientId: () => Promise<string>
  now?: () => number
  onReauthRequired?: () => void
}

export type RefreshOutcome = 'refreshed' | 'reauth-required' | 'no-token'

/**
 * Owns the Notion token lifecycle (MVP §4).
 *
 * Storage split (RESEARCH §4): access token lives in chrome.storage.session
 * (memory only), refresh token in chrome.storage.local (disk, extension-private).
 * Rotation is single-flight; on success the durable credential is written first
 * so a crash mid-rotation never destroys the ability to come back.
 */
export class TokenStore {
  private inflight: Promise<RefreshOutcome> | null = null

  constructor(private readonly deps: TokenStoreDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Persist the result of an initial authorization-code exchange. */
  async saveFromTokenResponse(token: TokenResponse): Promise<void> {
    await this.writeTokens(token)
  }

  /**
   * Returns a valid access token, refreshing proactively inside the last 20%
   * of its lifetime. Returns null when signed out / never authorized.
   */
  async getAccessToken(): Promise<string | null> {
    const stored = await this.deps.session.get([K_ACCESS, K_REFRESH_AT])
    const accessToken = stored[K_ACCESS]
    const refreshAt = stored[K_REFRESH_AT]
    if (typeof accessToken !== 'string' || !accessToken) {
      // Session storage died (browser restart) but the user may still be authorized.
      if (await this.hasRefreshToken()) {
        return (await this.refresh()) === 'refreshed'
          ? ((await this.deps.session.get(K_ACCESS))[K_ACCESS] as string)
          : null
      }
      return null
    }
    if (typeof refreshAt === 'number' && this.now >= refreshAt) {
      const outcome = await this.refresh()
      if (outcome === 'refreshed') {
        return ((await this.deps.session.get(K_ACCESS))[K_ACCESS] as string) ?? null
      }
      if (outcome === 'no-token') return null
      return null // reauth-required
    }
    return accessToken
  }

  async getWorkspaceId(): Promise<string | null> {
    const v = (await this.deps.local.get(K_WORKSPACE))[K_WORKSPACE]
    return typeof v === 'string' ? v : null
  }

  async hasRefreshToken(): Promise<boolean> {
    const v = (await this.deps.local.get(K_REFRESH))[K_REFRESH]
    return typeof v === 'string' && v.length > 0
  }

  /**
   * Refresh-token grant. Concurrent callers share one request (single-flight);
   * the promise clears when settled so a later expiry can refresh again.
   */
  refresh(): Promise<RefreshOutcome> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async doRefresh(): Promise<RefreshOutcome> {
    const stored = await this.deps.local.get(K_REFRESH)
    const refreshToken = stored[K_REFRESH]
    if (typeof refreshToken !== 'string' || !refreshToken) return 'no-token'

    let response: Response
    try {
      response = await this.deps.fetchImpl((await this.tokenEndpoint()).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: await this.deps.getClientId(),
        }),
      })
    } catch (e) {
      throw new Error(`[token-refresh] network failure: ${String(e)}`)
    }

    if (response.status === 400 || response.status === 401) {
      const body = await response.text().catch(() => '')
      if (/invalid_grant/.test(body)) {
        // Terminal per RESEARCH §2.4 — never retry; force a clean re-auth.
        await this.wipe()
        this.deps.onReauthRequired?.()
        return 'reauth-required'
      }
      throw new Error(`[token-refresh] ${response.status}: ${body.slice(0, 200)}`)
    }
    if (!response.ok) throw new Error(`[token-refresh] ${response.status}`)

    const token = (await response.json()) as TokenResponse
    if (!token.access_token) throw new Error('[token-refresh] response had no access_token')
    await this.writeTokens({ ...token, refresh_token: token.refresh_token ?? refreshToken })
    return 'refreshed'
  }

  /**
   * Ordered persistence: the refresh token (durable, rotates every time —
   * RESEARCH §2.4) lands in local storage before the short-lived pair goes to
   * session storage. A crash between the two writes still leaves us able to
   * refresh; the reverse order would not.
   */
  private async writeTokens(token: TokenResponse): Promise<void> {
    const issuedAt = this.now
    const lifetimeMs = Math.max(1, token.expires_in) * 1000
    if (token.refresh_token) {
      const items: Record<string, unknown> = { [K_REFRESH]: token.refresh_token }
      const workspaceId = extractWorkspaceId(token)
      if (workspaceId) items[K_WORKSPACE] = workspaceId
      await this.deps.local.set(items)
    }
    await this.deps.session.set({
      [K_ACCESS]: token.access_token,
      [K_REFRESH_AT]: issuedAt + Math.floor(lifetimeMs * PROACTIVE_FRACTION),
    })
  }

  /** Revoke (best-effort) then wipe both stores. */
  async signOut(metadata: Pick<AuthorizationServerMetadata, 'revocation_endpoint'>): Promise<void> {
    const refreshToken = (await this.deps.local.get(K_REFRESH))[K_REFRESH]
    if (metadata.revocation_endpoint && typeof refreshToken === 'string' && refreshToken) {
      try {
        await this.deps.fetchImpl(metadata.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: refreshToken,
            client_id: await this.deps.getClientId(),
          }),
        })
      } catch {
        /* best effort — wipe regardless */
      }
    }
    await this.wipe()
  }

  async wipe(): Promise<void> {
    await this.deps.local.remove([K_REFRESH, K_WORKSPACE])
    await this.deps.session.remove([K_ACCESS, K_REFRESH_AT])
  }

  private tokenEndpointCache: URL | null = null

  private async tokenEndpoint(): Promise<URL> {
    if (!this.tokenEndpointCache) {
      // Imported lazily by the facade; direct import here would create a cycle
      // once discovery needs tokens. Keep the constant inline instead.
      this.tokenEndpointCache = new URL('https://mcp.notion.com/token')
    }
    return this.tokenEndpointCache
  }
}

function extractWorkspaceId(token: TokenResponse): string | null {
  const raw = (token as unknown as Record<string, unknown>).workspace_id
  return typeof raw === 'string' && raw ? raw : null
}
