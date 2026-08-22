import { NativeBridge } from './native'
import { CodexClient } from './client'
import type { ModelInfo } from './client'

/** Panel-side singletons — the panel document is the runtime (RESEARCH §4). */
export const bridge = new NativeBridge(() => chrome.runtime.connectNative('com.nox.bridge'))
export const codex = new CodexClient(bridge)

export interface CodexSession {
  userAgent: string
  models: ModelInfo[]
}

/**
 * Full connect path used by the UI: ping host → initialize → model list.
 * Throws classified errors; callers surface healthHint(classifyBridgeFailure(e)).
 */
export async function connectCodex(): Promise<CodexSession> {
  // Ping proves the native host itself is installed and spawnable.
  await bridge.ping()
  const userAgent = await codex.initialize()
  const models = await codex.listModels(true)
  return { userAgent, models }
}
