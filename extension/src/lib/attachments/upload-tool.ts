import type { McpCallResult, McpTool } from '../mcp/client'
import type { CapabilityGate } from '../notion/capabilities'
import type { StoredAttachment } from '../../shared/attachments'
import type { DynamicTool } from '../agent/dynamic-tools'

export const UPLOAD_FILE_TOOL_NAME = 'nox-upload-local-file'
export const UPLOAD_FILE_TOOL: DynamicTool = {
  type: 'function',
  name: UPLOAD_FILE_TOOL_NAME,
  description: 'Upload a local attachment selected in this turn to Notion and return native file-block markdown.',
  inputSchema: { type: 'object', required: ['attachment_id'], properties: { attachment_id: { type: 'string' } } },
}

/** Raw provider ticket route. Never advertised to the model (08.1.4). */
export const UPLOAD_TICKET_TOOL_NAME = 'notion-create-file-upload'
const RAW_UPLOAD_TICKET_TOOLS: ReadonlySet<string> = new Set([UPLOAD_TICKET_TOOL_NAME])

/** Discovered tool names the model must never be offered directly. */
export function isRawUploadTicketTool(name: unknown): boolean {
  return typeof name === 'string' && RAW_UPLOAD_TICKET_TOOLS.has(name)
}

/**
 * Whether the upload workflow may be advertised or executed (08.1.1, 08.2.5).
 * All three must hold: the discovered tool list carries the underlying ticket
 * tool, the capability gate allows it, and the ticket envelope is verified.
 *
 * The envelope is NOT verified: the authoritative REST file-upload reference
 * (developers.notion.com, API 2026-03-11) documents create → upload_url →
 * multipart send → file_upload-id attach with no form_fields / field_name /
 * suggested_markdown fields, while the MCP ticket envelope itself has no
 * redacted live fixture. Until that fixture exists, support stays off and
 * upload fails closed everywhere with UPLOAD_UNSUPPORTED. Do not enable
 * without it.
 */
export function isUploadWorkflowSupported(discovered: McpTool[], gate: CapabilityGate): boolean {
  const ticketTool = discovered.find((tool) => isRawUploadTicketTool(tool?.name))
  if (!ticketTool || typeof ticketTool.name !== 'string') return false
  if (!gate.can(ticketTool.name).allowed) return false
  return isUploadTicketContractVerified()
}

/** False until a redacted live MCP ticket fixture verifies the envelope. */
export function isUploadTicketContractVerified(): boolean {
  return false
}

/** Clear unsupported reason, shared by advertisement and execution refusal. */
export function uploadUnsupportedMessage(): string {
  return (
    'UPLOAD_UNSUPPORTED: file upload into Notion is unavailable in this alpha — ' +
    'no verified upload-ticket contract exists yet, so no file bytes leave this browser for upload. ' +
    'Selected files stay local-only inputs; describe them from metadata instead.'
  )
}

export async function uploadLocalAttachment(attachment: StoredAttachment, deps: {
  createTicket: () => Promise<McpCallResult>
  fetchImpl: typeof fetch
  signal?: AbortSignal
}): Promise<string> {
  const ticketResult = await deps.createTicket()
  const ticket = objectResult(ticketResult)
  const uploadUrl = stringValue(ticket.upload_url ?? ticket.url)
  if (!uploadUrl || new URL(uploadUrl).protocol !== 'https:') throw new Error('Notion upload ticket must use HTTPS')
  const form = new FormData()
  const fields = objectValue(ticket.form_fields ?? ticket.fields)
  for (const [name, value] of Object.entries(fields)) if (typeof value === 'string') form.append(name, value)
  form.append(stringValue(ticket.field_name) ?? 'file', attachment.blob, attachment.name)
  const response = await deps.fetchImpl(uploadUrl, { method: 'POST', body: form, signal: deps.signal })
  if (!response.ok) throw new Error(`file upload ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const result = await response.json() as Record<string, unknown>
  const markdown = stringValue(result.suggested_markdown)
  if (!markdown) throw new Error('Notion upload returned no suggested_markdown')
  return markdown
}

function objectResult(result: McpCallResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, unknown>
  const text = result.content.find((part) => part.type === 'text' && part.text)?.text
  if (!text) throw new Error('Notion returned no upload ticket')
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('Notion returned an invalid upload ticket')
  return parsed as Record<string, unknown>
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
