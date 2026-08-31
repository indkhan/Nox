import type { McpCallResult } from '../mcp/client'
import type { StoredAttachment } from '../../shared/attachments'
import type { DynamicTool } from '../agent/dynamic-tools'

export const UPLOAD_FILE_TOOL_NAME = 'nox-upload-local-file'
export const UPLOAD_FILE_TOOL: DynamicTool = {
  type: 'function',
  name: UPLOAD_FILE_TOOL_NAME,
  description: 'Upload a local attachment selected in this turn to Notion and return native file-block markdown.',
  inputSchema: { type: 'object', required: ['attachment_id'], properties: { attachment_id: { type: 'string' } } },
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
