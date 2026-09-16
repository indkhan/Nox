import type { KeyValueStore } from './storage'

/**
 * Restricts credential-bearing storage to trusted extension contexts
 * (Epoch 13 / L3). Call once at background initialization before any
 * credential use: local (refresh token, client id) and session (access
 * token, page metadata) both become unreadable to content scripts, while the
 * owner panel/background (trusted contexts) keep working. Content-script
 * page metadata still flows because it travels via runtime messages, never
 * via storage reads. Throws a compatibility error when the API is
 * unavailable instead of silently relaxing.
 */
export async function ensureTrustedStorageAccess(): Promise<void> {
  const local = chrome.storage?.local as
    | { setAccessLevel?: (opts: { accessLevel: string }) => Promise<void> }
    | undefined
  const session = chrome.storage?.session as
    | { setAccessLevel?: (opts: { accessLevel: string }) => Promise<void> }
    | undefined
  if (typeof local?.setAccessLevel !== 'function' || typeof session?.setAccessLevel !== 'function') {
    throw new Error(
      'Chrome storage access restriction unavailable in this browser — update Chrome to a supported version to keep refresh credentials out of content-script reach.',
    )
  }
  await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

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
