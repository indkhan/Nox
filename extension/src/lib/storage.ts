/**
 * Minimal storage adapter so oauth modules stay testable without chrome.*.
 * Mirrors the get-all/keys shape of chrome.storage.Area.
 */
export interface KeyValueStore {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export function memoryStore(seed: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...seed }
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {}
      if (keys === undefined || keys === null) {
        for (const [k, v] of Object.entries(data)) out[k] = v
        return out
      }
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) if (k in data) out[k] = data[k]
      return out
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = v
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) delete data[k]
    },
  }
}
