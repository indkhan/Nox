/** LIVE diagnostics for the exact hops connect() uses before consent. Opt-in. */
import { describe, expect, it } from 'vitest'
import { fetchAuthorizationServerMetadata } from '../../src/lib/oauth/discovery'
import { ClientRegistrar } from '../../src/lib/oauth/dcr'
import { memoryStore } from '../../src/lib/storage'

const run = process.env.NOX_LIVE === '1'

const REDIRECT = 'https://mocebdbngeojcjenigojedapolmpafeo.chromiumapp.org/'
const EXT_ID = 'mocebdbngeojcjenigojedapolmpafeo'

describe.skipIf(!run)('LIVE connect preflight', () => {
  it('hop 1 — discovery', async () => {
    const meta = await fetchAuthorizationServerMetadata((...a) => fetch(...a))
    expect(meta.authorization_endpoint).toMatch(/^https:\/\/mcp\.notion\.com\/authorize$/)
    expect(meta.registration_endpoint).toBeTruthy()
  }, 20_000)

  it('hop 2 — DCR with the pinned redirect URI', async () => {
    const local = memoryStore()
    const registrar = new ClientRegistrar((...a) => fetch(...a), local)
    const meta = await fetchAuthorizationServerMetadata((...a) => fetch(...a))
    const clientId = await registrar.getClientId(meta, REDIRECT)
    expect(clientId).toMatch(/^[A-Za-z0-9_-]+$/) // Notion ids may contain _ and -
  }, 30_000)

  it('hop 3 — browser Origin is still rejected (DNR rule is load-bearing)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const t = JSON.parse(
      readFileSync(resolve(__dirname, '../../../spikes/.notion-token.json'), 'utf8'),
    ) as { access_token: string }
    // Auth check fires before the Origin check (RESEARCH §2.1), so a valid
    // token + browser Origin is required to see the 403 Invalid Origin.
    const res = await fetch('https://mcp.notion.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${t.access_token}`,
        origin: `chrome-extension://${EXT_ID}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/invalid origin/i)
  }, 20_000)

  it('hop 4 — cached-token path (no Origin) still initializes', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const t = JSON.parse(
      readFileSync(resolve(__dirname, '../../../spikes/.notion-token.json'), 'utf8'),
    ) as { access_token: string }
    const res = await fetch('https://mcp.notion.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${t.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(200)
  }, 20_000)
})
