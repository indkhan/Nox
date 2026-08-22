import { Notion } from './index'
import { chromeArea } from '../chrome-storage'

/**
 * Panel-side singleton. The panel document is the runtime (RESEARCH §4), so
 * every Notion interaction in production goes through this instance.
 */
export const notion = new Notion({
  fetchImpl: (...args) => fetch(...args),
  session: chromeArea('session'),
  local: chromeArea('local'),
  redirectUri: () => chrome.identity.getRedirectURL(),
})

/** Launches the OAuth consent window via chrome.identity. */
export function launchConsentFlow(authorizeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authorizeUrl, interactive: true },
      (redirected) => {
        const e = chrome.runtime.lastError
        if (e) reject(new Error(e.message ?? 'consent flow failed'))
        else if (!redirected) reject(new Error('consent window closed before completing'))
        else resolve(redirected)
      },
    )
  })
}
