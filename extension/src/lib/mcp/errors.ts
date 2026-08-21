import { McpHttpError, McpRpcError, McpUnauthenticatedError } from './client'

export type NoxErrorKind =
  | 'unauthenticated'
  | 'dnr-missing'
  | 'rate-limited'
  | 'transient'
  | 'plan-gated'
  | 'workspace-mismatch'
  | 'not-found'
  | 'invalid-args'
  | 'unknown'

export interface ClassifiedError {
  kind: NoxErrorKind
  /** What the user sees in the UI. */
  userMessage: string
  /** What the model hears as a tool result (MVP: errors are data, not crashes). */
  modelMessage: string
  retryable: boolean
}

const PLAN_RE = /upgrade_required|requires a paid|not (?:included|available) on your plan|business plan|upgrade to/i
const PERMISSION_RE = /permission denied|unauthorized for this (?:page|user)|does not (?:have access|not have permission)|access denied|restricted/i

/**
 * Maps every failure shape we can meet into one taxonomy so the UI and the
 * agent loop never string-match again.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof McpUnauthenticatedError) {
    return {
      kind: 'unauthenticated',
      userMessage: 'Notion is disconnected. Reconnect to continue.',
      modelMessage: 'ERROR: Notion is not connected. Tell the user to reconnect Notion from the panel.',
      retryable: false,
    }
  }

  if (error instanceof McpHttpError) {
    if (error.status === 401) {
      return {
        kind: 'unauthenticated',
        userMessage: 'The Notion session expired.',
        modelMessage: 'ERROR: Notion authorization expired; the client will refresh and may ask the user to reconnect.',
        retryable: false,
      }
    }
    if (error.status === 403 && /invalid origin/i.test(error.bodyText)) {
      return {
        kind: 'dnr-missing',
        userMessage: 'Nox could not apply its network rules. Reload the extension and try again.',
        modelMessage: 'ERROR: request blocked by browser network policy. The user must reload the extension.',
        retryable: false,
      }
    }
    if (error.status === 429) {
      return { kind: 'rate-limited', userMessage: 'Notion is rate-limiting us — slowing down.', modelMessage: 'ERROR: rate limited by Notion; retry shortly.', retryable: true }
    }
    if (error.status === 404) {
      return { kind: 'not-found', userMessage: 'That page or database was not found.', modelMessage: 'ERROR: target not found. It may have been deleted or the id is wrong.', retryable: false }
    }
    if (error.status >= 500) {
      return { kind: 'transient', userMessage: 'Notion had a temporary problem.', modelMessage: 'ERROR: Notion server error; retry.', retryable: true }
    }
    if (error.status === 403 || PLAN_RE.test(error.bodyText)) {
      return planOrWorkspace(error.bodyText)
    }
    return { kind: 'unknown', userMessage: `Notion returned HTTP ${error.status}.`, modelMessage: `ERROR: Notion HTTP ${error.status}.`, retryable: false }
  }

  if (error instanceof McpRpcError) {
    if (error.code === -32001) {
      return { kind: 'transient', userMessage: 'Notion is busy — retrying.', modelMessage: 'ERROR: server overloaded; retry.', retryable: true }
    }
    if (PLAN_RE.test(error.message)) return planOrWorkspace(error.message)
    if (PERMISSION_RE.test(error.message)) return workspaceMismatch()
    if (error.code === -32602 || /validation|invalid argument/i.test(error.message)) {
      return { kind: 'invalid-args', userMessage: 'The request was malformed.', modelMessage: `ERROR: invalid arguments — ${error.message}`, retryable: false }
    }
    return { kind: 'unknown', userMessage: error.message, modelMessage: `ERROR: ${error.message}`, retryable: false }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/failed to fetch|network|load failed/i.test(message)) {
    return { kind: 'transient', userMessage: 'Network problem reaching Notion.', modelMessage: 'ERROR: network failure; retry.', retryable: true }
  }
  if (PLAN_RE.test(message)) return planOrWorkspace(message)
  if (PERMISSION_RE.test(message)) return workspaceMismatch()
  return { kind: 'unknown', userMessage: message, modelMessage: `ERROR: ${message}`, retryable: false }
}

function planOrWorkspace(detail: string): ClassifiedError {
  if (PERMISSION_RE.test(detail)) return workspaceMismatch()
  return {
    kind: 'plan-gated',
    userMessage: 'This action needs a higher Notion plan.',
    modelMessage: 'ERROR: this capability requires a Notion plan upgrade. Explain the limitation instead of retrying.',
    retryable: false,
  }
}

function workspaceMismatch(): ClassifiedError {
  return {
    kind: 'workspace-mismatch',
    userMessage:
      "This page may belong to a different workspace than the one Nox is connected to. Check that you're viewing the connected workspace, or reconnect with the right account.",
    modelMessage:
      'ERROR: access denied on this page. It likely belongs to a different workspace than the connected integration. Do not retry; tell the user.',
    retryable: false,
  }
}

