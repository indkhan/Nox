import type { KeyValueStore } from './storage'

/** Adapts a chrome.storage area to the KeyValueStore shape used by lib/. */
export function chromeArea(area: 'session' | 'local'): KeyValueStore {
  const impl = area === 'session' ? chrome.storage.session : chrome.storage.local
  return {
    async get(keys) {
      return impl.get(keys ?? null)
    },
    async set(items) {
      await impl.set(items)
    },
    async remove(keys) {
      await impl.remove(keys)
    },
  }
}
