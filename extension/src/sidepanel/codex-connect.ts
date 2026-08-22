import { useNoxStore } from './store'
import { connectCodex, bridge } from '../lib/codex/panel'
import { classifyBridgeFailure, healthHint } from '../lib/codex/health'
import { logError, logInfo } from '../lib/log'

let connecting: Promise<void> | null = null

/** Single-flight connection to the Codex bridge, mirrored into the store. */
export function connectCodexAction(): Promise<void> {
  if (useNoxStore.getState().codexStatus === 'connected') return Promise.resolve()
  if (connecting) return connecting
  connecting = connect().finally(() => { connecting = null })
  return connecting
}

async function connect(): Promise<void> {
  const setCodex = useNoxStore.getState().setCodex
  logInfo('Codex connect: starting bridge')
  setCodex({ codexStatus: 'connecting', codexHint: null })
  try {
    const session = await connectCodex()
    logInfo(`Codex connected: ${session.userAgent} (${session.models.length} models)`)
    setCodex({
      codexStatus: 'connected',
      codexVersion: session.userAgent,
      codexModelCount: session.models.length,
      codexHint: null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const health = classifyBridgeFailure(message)
    logError(`Codex connect failed: ${message}`)
    // Leave the port clean for the next attempt.
    try {
      bridge.disconnect()
    } catch {
      /* already gone */
    }
    setCodex({
      codexStatus: 'error',
      codexHint: healthHint(health) || message,
    })
  }
}
