export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  msg: string
}

const MAX_ENTRIES = 500
const buffer: LogEntry[] = []
const listeners = new Set<() => void>()

function push(level: LogLevel, msg: string): void {
  buffer.push({ t: Date.now(), level, msg })
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

export function logWarn(msg: string): void {
  push('warn', msg)
}

export function logError(msg: string): void {
  push('error', msg)
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

/** Capture console.warn/error and unhandled failures into the buffer. */
export function installLogCapture(): void {
  if (installed) return
  installed = true

  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    push('warn', args.map(fmt).join(' '))
    origWarn(...args)
  }
  console.error = (...args: unknown[]) => {
    push('error', args.map(fmt).join(' '))
    origError(...args)
  }

  window.addEventListener('unhandledrejection', (e) => {
    push('error', `Unhandled rejection: ${fmt(e.reason)}`)
  })
  window.addEventListener('error', (e) => {
    push('error', `Uncaught error: ${e.message}`)
  })
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
