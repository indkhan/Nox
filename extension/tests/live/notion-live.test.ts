/**
 * LIVE smoke test for the Notion facade — hits production mcp.notion.com.
 * Opt-in: NOX_LIVE=1 pnpm vitest run tests/live/notion-live.test.ts
 * Read-only only (initialize / tools/list / notion-fetch self). Never mutates.
 * Token: spikes/.notion-token.json. If a refresh rotates it, we write it back.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Notion } from '../../src/lib/notion'
import { memoryStore } from '../../src/lib/storage'

const run = process.env.NOX_LIVE === '1'
const d = it.skip ?? it
const live = run ? it : d

const TOKEN_PATH = resolve(__dirname, '../../../spikes/.notion-token.json')

function loadToken(): { access_token: string; refresh_token?: string; expires_in: number; expires_at?: number } {
  return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
}

function saveToken(token: unknown): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
}

describe.skipIf(!run)('LIVE Notion MCP', () => {
  const session = memoryStore()
  const local = memoryStore()
  let notion: Notion

  function freshNotion(): Notion {
    return new Notion({
      fetchImpl: (...args) => fetch(...args),
      session,
      local,
      redirectUri: () => 'https://live-test.invalid/',
    })
  }

  function importCached(): ReturnType<Notion['importToken']> {
    notion = freshNotion()
    const t = loadToken()
    if (t.expires_at && Date.now() > t.expires_at - 120_000) {
      throw new Error('cached token expired — re-run spikes/notion-auth.mjs')
    }
    return notion.importToken(t)
  }

  live('imports the cached token and loads identity + capabilities', async () => {
    const info = await importCached()
    expect(info.access['fetch']).toBe('available')
    expect(info.access['query-meeting-notes']).toBe('upgrade_required')
    expect(info.identity.workspaceName || info.identity.userName || info.identity.email).toBeTruthy()
  }, 30_000)

  live('lists the documented tool surface', async () => {
    await importCached()
    const tools = await notion.listTools()
    expect(tools.length).toBeGreaterThanOrEqual(15)
    const names = tools.map((t) => t.name)
    for (const required of ['notion-search', 'notion-fetch', 'notion-update-page']) {
      expect(names).toContain(required)
    }
  }, 30_000)

  live('notion-fetch self returns identity text parseable by our gate', async () => {
    await importCached()
    const res = await notion.scheduleCallTool('notion-fetch', { id: 'self' })
    expect(res.isError ?? false).toBe(false)
    expect(McpText(res)).toMatch(/workspace/i)
  }, 30_000)

  // If a proactive refresh rotated the refresh token during this suite,
  // persist it so later runs (and the spikes) keep working.
  afterAll(async () => {
    const refreshToken = local.data['notion.refresh']
    if (typeof refreshToken === 'string' && refreshToken) {
      const t = loadToken()
      if (t.refresh_token !== refreshToken) saveToken({ ...t, refresh_token: refreshToken })
    }
  })
})

function McpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
}
