import type { AuthorizationServerMetadata, RegistrationResponse } from './discovery'
import { registerClient } from './discovery'
import type { KeyValueStore } from '../storage'

const CLIENT_ID_KEY = 'notion.client_id'

/**
 * Dynamic client registration with a cached client_id (MVP §4.2). Each install
 * registers itself once; the id survives restarts in storage.local.
 */
export class ClientRegistrar {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly local: KeyValueStore,
  ) {}

  async getClientId(metadata: AuthorizationServerMetadata, redirectUri: string): Promise<string> {
    const cached = await this.local.get(CLIENT_ID_KEY)
    const existing = cached[CLIENT_ID_KEY]
    if (typeof existing === 'string' && existing) return existing
    const registration: RegistrationResponse = await registerClient(this.fetchImpl, metadata, redirectUri)
    if (!registration.client_id) throw new Error('DCR response contained no client_id')
    await this.local.set({ [CLIENT_ID_KEY]: registration.client_id })
    return registration.client_id
  }

  /** Dev/testing escape hatch; also used when a stale client_id must be dropped. */
  async forget(): Promise<void> {
    await this.local.remove(CLIENT_ID_KEY)
  }
}
