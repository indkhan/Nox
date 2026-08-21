/**
 * Property-type-aware validation before writing (MVP §6.6). Invalid model
 * output gets ONE repair retry at the call site — validators here are pure.
 */

export interface NotionProperty {
  name: string
  type: string
  /** The value in the shape the MCP tool accepts, or the raw model output. */
  value?: unknown
}

export interface ValidationIssue {
  property: string
  expectedType: string
  receivedValue: unknown
  message: string
}

export function validateProperties(properties: NotionProperty[]): ValidationIssue[] {
  return properties.filter((p) => !validateOne(p.type, p.value)).map((p) => ({
    property: p.name,
    expectedType: p.type,
    receivedValue: p.value,
    message: describeIssue(p.type),
  }))
}

function validateOne(type: string, value: unknown): boolean {
  switch (String(type).toLowerCase()) {
    case 'text': case 'title': case 'rich_text':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'select': case 'status':
      return typeof value === 'string' && value.length > 0 && value.length <= 100
    case 'checkbox':
      return typeof value === 'boolean'
    case 'date':
      return (
        (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) ||
        (typeof value === 'object' && value !== null && 'start' in (value as object))
      )
    case 'multi_select':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
    default:
      // Unknown property types fail closed — never write garbage to Notion.
      return false
  }
}

function describeIssue(type: string): string {
  switch (String(type).toLowerCase()) {
    case 'number': return 'expected a finite number'
    case 'checkbox': return 'expected true or false'
    case 'select': case 'status': return 'expected a non-empty option name; new options must exist already or be created deliberately'
    case 'multi_select': return 'expected an array of option names'
    case 'date': return 'expected an ISO date string or {start,end}'
    case 'text': case 'title': case 'rich_text': return 'expected a string'
    default: return `unsupported property type "${type}" — Nox refuses to guess`
  }
}

/** One repair retry helper: gives the model the issues and re-validates. */
export async function withRepairRetry<T extends NotionProperty[]>(
  produce: () => Promise<T>,
  repair: (issues: ValidationIssue[], previous: T) => Promise<T>,
): Promise<{ properties: T; repairedOnce: boolean }> {
  const first = await produce()
  const issues = validateProperties(first)
  if (issues.length === 0) return { properties: first, repairedOnce: false }
  const second = await repair(issues, first)
  if (validateProperties(second).length > 0) {
    throw new Error('property validation failed twice — refusing to write invalid data to Notion')
  }
  return { properties: second, repairedOnce: true }
}
