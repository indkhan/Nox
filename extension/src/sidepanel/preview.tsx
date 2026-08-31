import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Dev-only preview harness (served by `vite dev` from /preview.html).
// Stubs the chrome APIs the panel touches so it renders in a plain browser.
const noopAsync = async () => ({})
const store = new Map<string, unknown>()
const area = {
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(store)
    const wanted = typeof keys === 'string' ? [keys] : keys
    return Object.fromEntries(wanted.filter((k) => store.has(k)).map((k) => [k, store.get(k)]))
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) store.set(k, v)
  },
  remove: async (keys: string | string[]) => {
    for (const k of typeof keys === 'string' ? [keys] : keys) store.delete(k)
  },
  clear: async () => store.clear(),
}
Object.assign(globalThis, {
  chrome: {
    runtime: {
      onMessage: { addListener: () => () => {} },
      onInstalled: { addListener: () => {} },
      sendMessage: noopAsync,
      getURL: (path: string) => path,
      id: 'preview',
    },
    storage: { local: area, session: area },
    tabs: { query: async () => [], onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    identity: { getRedirectURL: () => 'https://redirect.example/' },
  },
})

const { App } = await import('./App')
const { ErrorBoundary } = await import('./ErrorBoundary')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
