/** Distinct, actionable failure states for the Codex path (MVP §5). */
export type BridgeHealth =
  | 'ok'
  | 'bridge-missing' // native host not installed / port refused
  | 'codex-missing' // host alive but no usable codex binary
  | 'codex-incompatible' // binary found but outside tested profile
  | 'login-expired' // codex needs `codex login`
  | 'quota-exhausted'
  | 'overloaded' // -32001 transient
  | 'unknown'

export function classifyBridgeFailure(message: string): BridgeHealth {
  const m = message.toLowerCase()
  if (/ping timed out|not installed|port disconnected|disconnected|host exited/.test(m)) return 'bridge-missing'
  if (/codex-incompatible|untested by this nox revision|nox_experimental_codex/.test(m)) return 'codex-incompatible'
  if (/codex not running|codex-missing|codex not found/.test(m)) return 'codex-missing'
  if (/login|unauthorized|auth|api key|credential/.test(m)) return 'login-expired'
  if (/quota|usage limit|credit|subscription limit/.test(m)) return 'quota-exhausted'
  if (/overloaded|-32001/.test(m)) return 'overloaded'
  return 'unknown'
}

export function healthHint(health: BridgeHealth): string {
  switch (health) {
    case 'ok':
      return ''
    case 'bridge-missing':
      return 'Nox bridge is not installed. Run: node bridge/install.mjs — then restart Chrome.'
    case 'codex-missing':
      return 'The codex CLI was not found. Install it (npm i -g @openai/codex) and try again.'
    case 'codex-incompatible':
      return 'This Codex version has not been tested with Nox. Install a supported version, or set NOX_EXPERIMENTAL_CODEX=1 before starting Chrome to opt in.'
    case 'login-expired':
      return 'Codex login expired. Run: codex login'
    case 'quota-exhausted':
      return 'Your Codex quota is exhausted for now. It resets with your plan cycle.'
    case 'overloaded':
      return 'Codex is busy right now — retry in a moment.'
    default:
      return 'Unexpected bridge problem. See the panel log for detail.'
  }
}
