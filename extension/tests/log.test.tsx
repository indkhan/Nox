// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('chrome', {
  runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => ({})) },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
})

vi.mock('../src/lib/agent/panel', () => ({
  agentLoop: { setOverrides: vi.fn(), cancel: vi.fn() },
  planEngine: { invalidateApproval: vi.fn(), rejectPending: vi.fn() },
  writeGate: { approvals: { rejectAllPending: vi.fn() }, expireBaselines: vi.fn() },
  expireAgentGrants: vi.fn(),
}))
vi.mock('../src/lib/notion/panel', () => ({
  notion: { tokens: { wipe: vi.fn(async () => undefined) }, capabilities: { toolsWith: vi.fn(() => []) } },
  launchConsentFlow: vi.fn(),
}))
vi.mock('../src/lib/history/panel', () => ({
  historyRepo: { getMessages: vi.fn(async () => []), getThread: vi.fn(async () => null) },
  storageUsageBytes: vi.fn(async () => null),
  deleteAllData: vi.fn(async () => undefined),
}))
vi.mock('../src/sidepanel/ConnectionCard', () => ({ ConnectionCard: () => null }))
vi.mock('../src/sidepanel/BridgeCard', () => ({ BridgeCard: () => null }))

import { McpHttpError, McpRpcError, McpUnauthenticatedError } from '../src/lib/mcp/client'

const PROMPT_SENTINEL = 'NOX_PROMPT_SENTINEL_7f3a9c1e'
const TOKEN_SENTINEL = 'NOX_TOKEN_SENTINEL_b8e2d4f6'
const WORKSPACE_SENTINEL = 'NOX_WORKSPACE_SENTINEL_c1d2e3f4'
const UPLOAD_SENTINEL = 'https://uploads.example.invalid/NOX_UPLOAD_SENTINEL_a5b6c7d8'
const BEARER_SENTINEL = 'Bearer NOX_BEARER_SENTINEL_e9f0a1b2'
const PROVIDER_BODY_SENTINEL = 'NOX_PROVIDER_BODY_SENTINEL_1234abcd'
const QUERY_SENTINEL = 'NOX_QUERY_SENTINEL_5678efgh'
const ALL_SENTINELS = [
  PROMPT_SENTINEL,
  TOKEN_SENTINEL,
  WORKSPACE_SENTINEL,
  'NOX_UPLOAD_SENTINEL_a5b6c7d8',
  'NOX_BEARER_SENTINEL_e9f0a1b2',
  PROVIDER_BODY_SENTINEL,
  QUERY_SENTINEL,
]

function expectNoSentinels(text: string) {
  for (const s of ALL_SENTINELS) expect(text).not.toContain(s)
}

describe('diagnostic privacy (Epoch 14 / L2)', () => {
  beforeEach(async () => {
    const log = await import('../src/lib/log')
    log.clearLogs()
    vi.restoreAllMocks()
  })

  it('safe error summaries omit private sentinels while retaining hop/status codes', async () => {
    const log = await import('../src/lib/log') as unknown as Record<string, (e: unknown) => string>
    expect(typeof log.safeErrorDetail).toBe('function')
    const safeErrorDetail = log.safeErrorDetail as (e: unknown) => string

    // Provider body carrying every sentinel type must not survive.
    const http = new McpHttpError(
      500,
      `workspace ${WORKSPACE_SENTINEL} prompt ${PROMPT_SENTINEL} token ${TOKEN_SENTINEL} body ${PROVIDER_BODY_SENTINEL} query ${QUERY_SENTINEL}`,
    )
    const httpDetail = safeErrorDetail(http)
    expectNoSentinels(httpDetail)
    expect(httpDetail).toMatch(/500/)

    const rpc = new McpRpcError(-32000, `invalid arguments with ${PROMPT_SENTINEL} and ${WORKSPACE_SENTINEL}`)
    const rpcDetail = safeErrorDetail(rpc)
    expectNoSentinels(rpcDetail)
    expect(rpcDetail).toMatch(/-32000/)

    const unauth = new McpUnauthenticatedError()
    expect(safeErrorDetail(unauth)).toMatch(/unauthenticated/i)

    // OAuth hop errors retain the stage and status, never the body.
    const oauth = new Error(`[token-refresh] 400: ${PROVIDER_BODY_SENTINEL} ${TOKEN_SENTINEL}`)
    const oauthDetail = safeErrorDetail(oauth)
    expectNoSentinels(oauthDetail)
    expect(oauthDetail).toMatch(/\[token-refresh\]/)
    expect(oauthDetail).toMatch(/400/)

    // Generic errors become a category, never the raw message.
    const generic = new Error(`prompt ${PROMPT_SENTINEL} ${BEARER_SENTINEL}`)
    expectNoSentinels(safeErrorDetail(generic))
  })

  it('console capture does not retain arbitrary exception strings', async () => {
    const log = await import('../src/lib/log')
    log.installLogCapture()
    console.error(new Error(`boom ${PROMPT_SENTINEL} ${TOKEN_SENTINEL}`))
    console.warn(new Error(`warn ${WORKSPACE_SENTINEL} ${PROVIDER_BODY_SENTINEL}`))
    const text = log.formatLogs()
    expectNoSentinels(text)
  })

  it('credential-bearing objects are redacted in captured logs', async () => {
    const log = await import('../src/lib/log')
    log.installLogCapture()
    console.error({ access_token: TOKEN_SENTINEL, refresh_token: TOKEN_SENTINEL } as unknown as Error)
    console.error(`${BEARER_SENTINEL} upload ${UPLOAD_SENTINEL}` as unknown as Error)
    const text = log.formatLogs()
    expectNoSentinels(text)
  })

  it('unhandled rejections are recorded without private content', async () => {
    const log = await import('../src/lib/log')
    log.installLogCapture()
    window.dispatchEvent(
      new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve('test'),
        reason: new Error(`rejected ${PROMPT_SENTINEL} ${TOKEN_SENTINEL}`),
      }),
    )
    const text = log.formatLogs()
    expectNoSentinels(text)
  })

  it('exported logs stay useful: categories and stages survive', async () => {
    const log = await import('../src/lib/log')
    const safe = (log as unknown as Record<string, (e: unknown) => string>).safeErrorDetail
    log.logInfo('Notion connect: starting')
    log.logError(`Notion connect failed: ${safe(new McpHttpError(503, PROVIDER_BODY_SENTINEL))}`)
    log.logError(`OAuth failed: ${safe(new Error('[discovery] network failure'))}`)
    const text = log.formatLogs()
    expectNoSentinels(text)
    expect(text).toMatch(/Notion connect: starting/)
    expect(text).toMatch(/503/)
    expect(text).toMatch(/\[discovery\]/)
  })

  it('settings logs UI reminds reviewers to check for private content', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { SettingsModal } = await import('../src/sidepanel/SettingsModal')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<SettingsModal />)
      })
      expect(container.textContent).toMatch(/Review for private content before sharing/i)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
