import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/background/dnr', () => ({
  ensureOriginStripRule: vi.fn(async () => ({ installed: true, verified: false, active: true })),
  removeOriginStripRule: vi.fn(async () => undefined),
}))

beforeEach(() => vi.resetModules())

it('keeps the latest active page when an older tab lookup completes late', async () => {
  let onActivated!: (value: { tabId: number }) => void
  let onMessage!: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean
  let releaseOld!: (value: { url: string }) => void
  let finishStorage!: () => void
  const storageReady = new Promise<void>(resolve => { finishStorage = resolve })
  const data: Record<string, unknown> = {}
  const chromeMock = {
    runtime: { id: 'ext-1', sendMessage: vi.fn(async () => undefined), onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener } } },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
    storage: {
      local: { setAccessLevel: vi.fn(() => storageReady) },
      session: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value) }),
      },
    },
    tabs: {
      onActivated: { addListener: (listener: typeof onActivated) => { onActivated = listener } },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => []),
      get: vi.fn((id: number) => id === 1
        ? new Promise(resolve => { releaseOld = resolve })
        : Promise.resolve({ url: 'https://www.notion.so/22222222222222222222222222222222' })),
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: vi.fn() } },
  }
  vi.stubGlobal('chrome', chromeMock)
  await import('../src/background/index')
  const statusResponse = vi.fn()
  expect(onMessage({ type: 'nox/get-dnr-status' }, { id: 'ext-1', url: 'chrome-extension://ext-1/src/sidepanel/index.html' }, statusResponse)).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(statusResponse).not.toHaveBeenCalled()
  finishStorage()
  await vi.waitFor(() => expect(statusResponse).toHaveBeenCalled())
  await vi.waitFor(() => expect(data['nox.currentPage']).toBeNull())
  for (const type of ['nox/get-current-page', 'nox/get-recent-pages', 'nox/get-dnr-status', 'nox/clear-dnr']) {
    const respond = vi.fn()
    expect(onMessage({ type }, { id: 'ext-1', tab: { id: 1 } }, respond)).toBe(false)
    expect(respond).not.toHaveBeenCalled()
  }
  onActivated({ tabId: 1 })
  await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'))
  onActivated({ tabId: 2 })
  await vi.waitFor(() => expect((data['nox.currentPage'] as { pageId?: string })?.pageId).toBe('22222222-2222-2222-2222-222222222222'))
  releaseOld({ url: 'https://www.notion.so/11111111111111111111111111111111' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((data['nox.currentPage'] as { pageId?: string })?.pageId).toBe('22222222-2222-2222-2222-222222222222')
})
