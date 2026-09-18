export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  msg: string
}

const MAX_ENTRIES = 500
/** Bounded event text: categories and safe codes stay, bodies never do. */
export const MAX_LOG_MESSAGE_CHARS = 500
/** Max tool-arg keys named in one trace line; keeps logging O(1). */
export const MAX_TRACE_ARG_KEYS = 8
/** Max tool names named in one plan-trace line. */
export const MAX_TRACE_TOOLS = 10
/** Max error-message chars kept after the safe category; keeps lines short. */
export const MAX_ERROR_DETAIL_CHARS = 200
const buffer: LogEntry[] = []
const listeners = new Set<() => void>()

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer [redacted]'],
  [/("access_token"\s*:\s*")[^"]*(")/g, '$1[redacted]$2'],
  [/("refresh_token"\s*:\s*")[^"]*(")/g, '$1[redacted]$2'],
  [/("code_verifier"\s*:\s*")[^"]*(")/g, '$1[redacted]$2'],
  [/\b(access_token|refresh_token|code_verifier|code_challenge|id_token)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1=[redacted]'],
  [/\b(authorization\s*[:=]\s*)([^\s,}]+)/gi, '$1[redacted]'],
  [/\b(upload_url)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1=[redacted]'],
  [/\b(form_fields?)\b[^,}\n]*/gi, '$1=[redacted]'],
  [/https?:\/\/[^\s"'`,}]+/g, '[url]'],
]

/** Defense-in-depth credential redaction; the primary rule is to never log private content. */
export function redactCredentials(text: string): string {
  let out = text
  for (const [re, replacement] of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, replacement)
  }
  return out
}

export function sanitizeLogMessage(msg: string): string {
  const redacted = redactCredentials(msg)
  return redacted.length > MAX_LOG_MESSAGE_CHARS
    ? `${redacted.slice(0, MAX_LOG_MESSAGE_CHARS)}…`
    : redacted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Safe structured summary for an error (Epoch 14 / L2): bounded event
 * category, hop/stage, and safe status/error code only. Never includes
 * arguments, inverse Markdown, page titles, upload URLs/form fields, bearer
 * tokens, provider body strings, or source queries. Unknown errors become a
 * generic category.
 */
export function safeErrorDetail(error: unknown): string {
  if (error == null) return 'unknown error'
  const rec = isRecord(error) ? (error as Record<string, unknown>) : null
  const name = typeof rec?.name === 'string' ? (rec.name as string) : ''

  if (name === 'McpUnauthenticatedError') return 'notion-unauthenticated'
  if (name === 'McpHttpError' && typeof rec?.status === 'number') {
    const status = rec.status as number
    if (status === 401) return 'mcp http 401 [unauthenticated]'
    if (status === 403) {
      const body = typeof rec.bodyText === 'string' ? (rec.bodyText as string) : ''
      return /invalid origin/i.test(body)
        ? 'mcp http 403 [dnr-missing]'
        : 'mcp http 403 [forbidden]'
    }
    if (status === 404) return 'mcp http 404 [not-found]'
    if (status === 429) return 'mcp http 429 [rate-limited]'
    if (status >= 500) return `mcp http ${status} [transient]`
    return `mcp http ${status} [http-error]`
  }
  if (name === 'McpRpcError' && typeof rec?.code === 'number') {
    const code = rec.code as number
    const message = typeof rec.message === 'string' ? (rec.message as string) : ''
    let hint = 'error'
    if (/upgrade_required|requires a paid|not (?:included|available) on your plan/i.test(message)) hint = 'plan-gated'
    else if (/permission denied|unauthorized|access denied|restricted/i.test(message)) hint = 'workspace-mismatch'
    else if (code === -32001) hint = 'transient'
    else if (code === -32602) hint = 'invalid-args'
    return `mcp rpc ${code} [${hint}]`
  }
  if (name === 'McpBodyTooLargeError') {
    const budget = typeof rec?.budgetBytes === 'number' ? ` ${(rec.budgetBytes as number)} bytes` : ''
    return `mcp oversize${budget} [bounded]`
  }
  if (name === 'McpMalformedResponseError') return 'mcp malformed response [error]'
  if (name === 'UncertainDispatchError') return 'uncertain dispatch [unknown]'

  if (error instanceof Error) {
    const message = error.message ?? ''
    const stageMatch = /^\[([A-Za-z0-9\-_+/]+)\]/.exec(message)
    if (stageMatch) {
      const stage = stageMatch[1].length <= 32 ? stageMatch[1] : 'stage'
      const codeMatch = /\b(\d{3})\b/.exec(message)
      return codeMatch ? `[${stage}] ${codeMatch[1]}` : `[${stage}] error`
    }
    return 'error [unknown]'
  }
  return 'error [unknown]'
}

function push(level: LogLevel, msg: string): void {
  buffer.push({ t: Date.now(), level, msg: sanitizeLogMessage(msg) })
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* listener errors never break logging */
    }
  }
}

export function logInfo(msg: string): void {
  push('info', msg)
}

export function logError(msg: string): void {
  push('error', msg)
}

/**
 * Verbose turn trace (safe by construction): logs event categories, counts,
 * and key/tool names only — never arg values, titles, prompts, answers, or
 * workspace ids. Every line stays short so the turn path costs one bounded
 * push and cannot slow the program.
 */
export function describeArgKeys(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'args=?'
  const keys = Object.keys(args as Record<string, unknown>).slice(0, MAX_TRACE_ARG_KEYS)
  const total = Object.keys(args as Record<string, unknown>).length
  const names = keys.map((k) => (k.length <= 32 ? k : k.slice(0, 32))).join(',')
  return total > keys.length ? `keys=[${names},…] n=${total}` : `keys=[${names}] n=${total}`
}

export function describeToolNames(tools: unknown[]): string {
  const names = tools
    .filter((t): t is string => typeof t === 'string')
    .map((t) => (t.length <= 48 ? t : t.slice(0, 48)))
    .slice(0, MAX_TRACE_TOOLS)
  return tools.length > names.length ? `[${names.join(',')},…] n=${tools.length}` : `[${names.join(',')}] n=${tools.length}`
}

/**
 * Error line with detail: the safe category plus the redacted, truncated
 * error message. Credential patterns are still redacted and the message
 * suffix is bounded, so this stays one cheap push — but unlike the bare
 * category, it shows what actually failed. Review before sharing: the
 * message can name workspace content.
 */
export function detailedErrorText(error: unknown): string {
  const category = safeErrorDetail(error)
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!raw || !raw.trim()) return category
  const clean = sanitizeLogMessage(raw.trim())
  const short = clean.length > MAX_ERROR_DETAIL_CHARS ? `${clean.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : clean
  return short === category ? category : `${category} — ${short}`
}

export function getLogs(): readonly LogEntry[] {
  return buffer
}

export function clearLogs(): void {
  buffer.length = 0
  for (const fn of listeners) fn()
}

export function subscribeLogs(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function formatLogs(): string {
  if (buffer.length === 0) return '(no log entries)'
  return buffer
    .map((e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.msg}`)
    .join('\n')
}

export async function copyLogs(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(formatLogs())
    return true
  } catch {
    return false
  }
}

let installed = false

/**
 * Capture console.warn/error and unhandled failures into the buffer without
 * retaining arbitrary exception strings (Epoch 14 / L2). Known errors become
 * safe structured metadata; unknown errors become a generic category.
 * Credential patterns are redacted defense-in-depth. Copy remains
 * user-initiated; no telemetry or automatic submission is introduced.
 */
export function installLogCapture(): void {
  if (installed) return
  installed = true

  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    push('warn', args.map(toSafeConsolePart).join(' '))
    origWarn(...args)
  }
  console.error = (...args: unknown[]) => {
    push('error', args.map(toSafeConsolePart).join(' '))
    origError(...args)
  }

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason
    push('error', `Unhandled rejection: ${safeErrorDetail(reason)}`)
  })
  window.addEventListener('error', () => {
    push('error', 'Uncaught error [unknown]')
  })
}

function toSafeConsolePart(value: unknown): string {
  if (value instanceof Error) return safeErrorDetail(value)
  if (typeof value === 'string') return sanitizeLogMessage(value)
  if (isRecord(value)) {
    const rec = value as Record<string, unknown>
    if (typeof rec.message === 'string' && typeof rec.name === 'string') {
      return safeErrorDetail(
        Object.assign(new Error(rec.message), {
          name: rec.name,
          ...(typeof rec.status === 'number' ? { status: rec.status } : {}),
          ...(typeof rec.code === 'number' ? { code: rec.code } : {}),
          ...(typeof rec.bodyText === 'string' ? { bodyText: rec.bodyText } : {}),
          ...(typeof rec.budgetBytes === 'number' ? { budgetBytes: rec.budgetBytes } : {}),
        }),
      )
    }
    try {
      return sanitizeLogMessage(JSON.stringify(value))
    } catch {
      return 'unloggable value [redacted]'
    }
  }
  try {
    return sanitizeLogMessage(String(value))
  } catch {
    return 'unloggable value [redacted]'
  }
}
