import type { AuthorizationServerMetadata, TokenResponse } from './discovery'
import type { KeyValueStore } from '../storage'

const K_ACCESS = 'notion.access'
const K_REFRESH_AT = 'notion.refreshAt'
const K_REFRESH = 'notion.refresh'
const K_WORKSPACE = 'notion.workspaceId'
/**
 * Persisted credential generation (Epoch 11 / M8). Every new authorization
 * mints one; sign-out, wipe, and replacement logins invalidate it. Refresh
 * and login writes re-check it inside the credential lock, so a stale
 * response from another panel can never overwrite newer credentials.
 */
const K_GEN = 'notion.credGen'

/** Fraction of lifetime after which we proactively refresh (MVP §4.8: 80%). */
export const PROACTIVE_FRACTION = 0.8

/** Best-effort revocation must never hold local sign-out hostage (M8). */
export const REVOCATION_TIMEOUT_MS = 5000

/** Fallback token endpoint for direct (non-facade) use; production refresh
 * always goes through the validated discovered endpoint (Epoch 11 / M8). */
const DEFAULT_TOKEN_ENDPOINT = 'https://mcp.notion.com/token'

/**
 * Mutual exclusion for credential state. Production uses a shared browser
 * Web Lock so separate panels serialize; without Web Lock support (tests,
 * workers) the body runs directly and generation checks still fail closed.
 */
export interface CredentialLock {
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T>
}

export function webCredentialLock(): CredentialLock {
  return {
    runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
      if (locks?.request) return locks.request(name, { mode: 'exclusive' }, () => fn()) as unknown as Promise<T>
      return fn()
    },
  }
}

/** Short lock around credential persistence/clears — never across network. */
const WRITE_LOCK = 'nox-credential-write'
/** Separate lock serializing refresh across permitted callers. */
const REFRESH_LOCK = 'nox-credential-refresh'

export interface TokenStoreDeps {
  session: KeyValueStore
  local: KeyValueStore
  fetchImpl: typeof fetch
  getClientId: () => Promise<string>
  now?: () => number
  onReauthRequired?: () => void
  lock?: CredentialLock
  /**
   * Validated discovered token endpoint for the refresh grant. The Notion
   * facade supplies this from authorization-server metadata; direct
   * construction falls back to the documented default.
   */
  getTokenEndpoint?: () => Promise<string>
}

export type RefreshOutcome = 'refreshed' | 'reauth-required' | 'no-token'

/**
 * Owns the Notion token lifecycle (MVP §4).
 *
 * Storage split (RESEARCH §4): access token lives in chrome.storage.session
 * (memory only), refresh token in chrome.storage.local (disk, extension-private).
 * Rotation is single-flight per instance and serialized across instances;
 * on success the durable credential is written first so a crash mid-rotation
 * never destroys the ability to come back.
 *
 * Every write is scoped to a persisted credential generation: sign-out, wipe,
 * and replacement logins invalidate it first, so a late response from an
 * older authorization is discarded instead of resurrecting credentials (M8).
 */
export class TokenStore {
  private inflight: Promise<RefreshOutcome> | null = null
  private refreshAbort: AbortController | null = null
  private reauthHandler: (() => void) | null = null

  constructor(private readonly deps: TokenStoreDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get lock(): CredentialLock {
    return this.deps.lock ?? webCredentialLock()
  }

  /** Late-wire the re-auth signal (the facade connects it to connection UI). */
  setReauthHandler(handler: (() => void) | null): void {
    this.reauthHandler = handler
  }

  private signalReauthRequired(): void {
    try {
      this.deps.onReauthRequired?.()
    } catch {
      // One failing observer must not break credential bookkeeping.
    }
    try {
      this.reauthHandler?.()
    } catch {
      // Same guarantee for the late-wired UI handler.
    }
  }

  /**
   * Starts a replacement authorization: aborts an in-flight refresh and
   * invalidates the current generation up front, so stale responses landing
   * after the new exchange cannot resurrect older credentials.
   *
   * Returns the login-attempt generation (Epoch F3 / R5). The eventual
   * `saveFromTokenResponse` for this attempt must pass it back as
   * `expectedGeneration`; saves from superseded attempts (wipe, sign-out,
   * or a newer login bumped the persisted generation meanwhile) are
   * rejected under the credential write lock with zero credential writes.
   */
  async beginLogin(): Promise<string> {
    this.refreshAbort?.abort()
    const attempt = crypto.randomUUID()
    await this.lock.runExclusive(WRITE_LOCK, async () => {
      await this.deps.local.set({ [K_GEN]: attempt })
    })
    return attempt
  }

  /**
   * Persist the result of an initial authorization-code exchange.
   *
   * When `expectedGeneration` (the attempt captured from `beginLogin`
   * before async discovery/consent) is supplied, the write commits only if
   * the persisted generation still matches it. A mismatch means sign-out,
   * wipe/delete-all, or a newer login invalidated this attempt while it
   * was in flight — the save throws STALE_LOGIN_ATTEMPT without touching
   * credentials. Without an attempt (fresh dev/import paths with no async
   * gap) the previous mint-a-new-generation behavior is preserved.
   */
  async saveFromTokenResponse(token: TokenResponse, expectedGeneration?: string): Promise<void> {
    validateTokenResponse(token)
    if (expectedGeneration !== undefined) {
      await this.lock.runExclusive(WRITE_LOCK, async () => {
        const current = (await this.deps.local.get(K_GEN))[K_GEN]
        if (current !== expectedGeneration) {
          throw new Error(
            '[login] STALE_LOGIN_ATTEMPT: superseded by sign-out, wipe, or a newer login — refusing to restore credentials',
          )
        }
        await this.writeTokens(token)
      })
      return
    }
    const generation = crypto.randomUUID()
    await this.lock.runExclusive(WRITE_LOCK, async () => {
      // New generation first: a concurrent stale refresh re-checks inside
      // the same lock and loses instead of overwriting the new login.
      await this.deps.local.set({ [K_GEN]: generation })
      await this.writeTokens(token)
    })
  }

  /**
   * True when `attempt` (captured from `beginLogin`) is still the persisted
   * credential generation. Facade/identity/UI completion checks this after
   * async work so a late result cannot restore a Connected label (F3/R5).
   */
  async isLoginAttemptCurrent(attempt: string): Promise<boolean> {
    return this.lock.runExclusive(WRITE_LOCK, async () => {
      const current = (await this.deps.local.get(K_GEN))[K_GEN]
      return current === attempt
    })
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
    // Pre-lock snapshot: an explicit refresh() always hits the network unless
    // another permitted caller refreshed while this one waited for the lock.
    // A second expiry/token read after acquiring the lock detects that race;
    // freshness alone never skips a forced refresh (M8).
    const before = await this.deps.session.get([K_ACCESS, K_REFRESH_AT])
    return this.lock.runExclusive(REFRESH_LOCK, async () => {
      const session = await this.deps.session.get([K_ACCESS, K_REFRESH_AT])
      const refreshAt = session[K_REFRESH_AT]
      const changed = session[K_ACCESS] !== before[K_ACCESS] || session[K_REFRESH_AT] !== before[K_REFRESH_AT]
      if (
        changed &&
        typeof session[K_ACCESS] === 'string' &&
        session[K_ACCESS] &&
        typeof refreshAt === 'number' &&
        this.now < refreshAt
      ) {
        return 'refreshed'
      }
      // Atomic snapshot under the short write lock: sign-out/wipe/login
      // bumps the generation and clears under the same lock, so a stale
      // refresh can never read a new generation with an old token (M8).
      const snapshot = await this.lock.runExclusive(WRITE_LOCK, async () => {
        const stored = await this.deps.local.get([K_REFRESH, K_GEN])
        return { refreshToken: stored[K_REFRESH], generation: stored[K_GEN] }
      })
      const refreshToken = snapshot.refreshToken
      if (typeof refreshToken !== 'string' || !refreshToken) return 'no-token'
      const startGeneration = snapshot.generation

      const refreshAbort = new AbortController()
      this.refreshAbort = refreshAbort
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
          signal: refreshAbort.signal,
        })
      } catch (e) {
        if (refreshAbort.signal.aborted) return 'no-token'
        throw new Error(`[token-refresh] network failure: ${String(e)}`)
      } finally {
        if (this.refreshAbort === refreshAbort) this.refreshAbort = null
      }

      if (response.status === 400 || response.status === 401) {
        const body = await response.text().catch(() => '')
        if (/invalid_grant/.test(body)) {
          // Terminal per RESEARCH §2.4 — never retry. The wipe is scoped to
          // the generation this attempt started with: an invalid_grant for an
          // older authorization must never wipe a newer login (M8).
          const scoped = await this.lock.runExclusive(WRITE_LOCK, async () => {
            const current = (await this.deps.local.get(K_GEN))[K_GEN]
            if (current !== startGeneration) return false
            await this.wipeLocked()
            return true
          })
          if (!scoped) return 'no-token'
          this.signalReauthRequired()
          return 'reauth-required'
        }
        throw new Error(`[token-refresh] ${response.status}: ${body.slice(0, 200)}`)
      }
      if (!response.ok) throw new Error(`[token-refresh] ${response.status}`)

      const token = (await response.json()) as TokenResponse
      validateTokenResponse(token)
      try {
        const written = await this.lock.runExclusive(WRITE_LOCK, async () => {
          // Recheck the persisted generation inside the write lock: a
          // sign-out, wipe, or replacement login invalidated this attempt
          // while it was in flight — discard instead of resurrecting (M8).
          const current = (await this.deps.local.get(K_GEN))[K_GEN]
          if (current !== startGeneration) return false
          await this.writeTokens({ ...token, refresh_token: token.refresh_token ?? refreshToken })
          return true
        })
        if (!written) return 'no-token'
      } catch {
        // Rotation succeeded remotely but the recovery record could not be
        // stored: the durable credential is stale, so re-authentication is
        // required. Never report plain success here.
        this.signalReauthRequired()
        return 'reauth-required'
      }
      return 'refreshed'
    })
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

  /**
   * Sign out: abort stale refresh, capture the revocation token, invalidate
   * the generation and clear local/session tokens promptly under the short
   * write lock, then revoke best-effort with a five-second timeout. Local
   * clearing happens before revocation resolves; a storage failure throws and
   * is never reported as a complete sign-out (M8).
   */
  async signOut(metadata: Pick<AuthorizationServerMetadata, 'revocation_endpoint'>): Promise<void> {
    this.refreshAbort?.abort()
    const stored = await this.deps.local.get(K_REFRESH)
    const rawRefresh = stored[K_REFRESH]
    const revocationToken = typeof rawRefresh === 'string' && rawRefresh ? rawRefresh : null
    // Invalidate first so a late refresh landing during revocation cannot
    // resurrect credentials. A storage failure here throws visibly.
    await this.lock.runExclusive(WRITE_LOCK, async () => {
      await this.deps.local.set({ [K_GEN]: crypto.randomUUID() })
      await this.deps.local.remove([K_REFRESH, K_WORKSPACE])
      await this.deps.session.remove([K_ACCESS, K_REFRESH_AT])
    })
    if (metadata.revocation_endpoint && revocationToken) {
      let clientId: string | null = null
      try {
        clientId = await this.deps.getClientId()
      } catch {
        clientId = null
      }
      if (clientId) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), REVOCATION_TIMEOUT_MS)
        try {
          await this.deps.fetchImpl(metadata.revocation_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: revocationToken, client_id: clientId }),
            signal: ctrl.signal,
          })
        } catch {
          /* best effort — local sign-out already completed */
        } finally {
          clearTimeout(timer)
        }
      }
    }
  }

  /** Wipe durable + session credentials and invalidate the generation (M8). */
  async wipe(): Promise<void> {
    this.refreshAbort?.abort()
    await this.lock.runExclusive(WRITE_LOCK, async () => {
      await this.wipeLocked()
    })
  }

  /** Generation-scoped clear; caller must hold WRITE_LOCK. */
  private async wipeLocked(): Promise<void> {
    await this.deps.local.set({ [K_GEN]: crypto.randomUUID() })
    await this.deps.local.remove([K_REFRESH, K_WORKSPACE])
    await this.deps.session.remove([K_ACCESS, K_REFRESH_AT])
  }

  private tokenEndpointCache: URL | null = null

  /**
   * Validated discovered token endpoint (M8). The Notion facade supplies it
   * from authorization-server metadata; direct construction falls back to the
   * documented default. A non-HTTPS or unparseable endpoint fails closed.
   */
  private async tokenEndpoint(): Promise<URL> {
    if (this.tokenEndpointCache) return this.tokenEndpointCache
    // When the facade supplies a discovered endpoint, validation failures
    // propagate fail-closed (never silently fall back to a hardcoded URL).
    // Direct construction without a supplier uses the documented default.
    let discovered: string | null = null
    if (this.deps.getTokenEndpoint) {
      discovered = (await this.deps.getTokenEndpoint()) ?? null
    }
    if (discovered) {
      let url: URL
      try {
        url = new URL(discovered)
      } catch {
        throw new Error('[token-refresh] invalid discovered token endpoint')
      }
      if (url.protocol !== 'https:') throw new Error('[token-refresh] invalid discovered token endpoint')
      this.tokenEndpointCache = url
      return url
    }
    if (!this.tokenEndpointCache) {
      this.tokenEndpointCache = new URL(DEFAULT_TOKEN_ENDPOINT)
    }
    return this.tokenEndpointCache
  }
}

/**
 * Fail-closed token response validation (M8): non-empty access token,
 * finite positive expiry within a sane bound, and a usable refresh token
 * when present. Malformed responses never touch stored credentials.
 */
export function validateTokenResponse(token: TokenResponse): void {
  if (!token || typeof token !== 'object') throw new Error('[token-response] invalid token response: not an object')
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('[token-response] invalid token response: missing access_token')
  }
  if (
    typeof token.expires_in !== 'number' ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0 ||
    token.expires_in > 365 * 24 * 3600
  ) {
    throw new Error('[token-response] invalid token response: bad expires_in')
  }
  if (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token)) {
    throw new Error('[token-response] invalid token response: bad refresh_token')
  }
}

function extractWorkspaceId(token: TokenResponse): string | null {
  const raw = (token as unknown as Record<string, unknown>).workspace_id
  return typeof raw === 'string' && raw ? raw : null
}
