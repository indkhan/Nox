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

/**
 * Verified ticket contract (08.2). Field names and URL shape follow the
 * authoritative REST file-upload reference (developers.notion.com, API
 * 2026-03-11): a `file_upload` object with `id` and `upload_url`, bytes sent
 * as multipart under exactly `file`, and a `file_upload` result with an
 * `uploaded` status. There is deliberately NO form_fields / field_name /
 * suggested_markdown alias: those names have no contract evidence and are
 * refused rather than guessed.
 */
export interface VerifiedUploadContract {
  /** Exact allowed upload origins (`URL.origin` strings). Never suffixes. */
  allowedOrigins: readonly string[]
  /** Required upload-path prefix (verified provider URL shape). */
  uploadPathPrefix: string
  /** Maximum ticket/result JSON bytes accepted. */
  maxJsonBytes: number
  /** Maximum single-part body bytes accepted. */
  maxBytes: number
}

export type UploadStage = 'ticket-created' | 'bytes-dispatched' | 'upload-confirmed'

export interface UploadResult {
  fileUploadId: string
  filename: string
  /** Uploaded-but-unattached outcome text for the model turn. */
  message: string
}

export type UploadErrorCode =
  | 'ATTACHMENT_MISMATCH'
  | 'ATTACHMENT_TOO_LARGE'
  | 'UPLOAD_CANCELLED'
  | 'UPLOAD_TICKET_FAILED'
  | 'UPLOAD_TICKET_INVALID'
  | 'UPLOAD_ORIGIN_REFUSED'
  | 'UPLOAD_REDIRECT_REFUSED'
  | 'UPLOAD_FAILED'
  | 'UPLOAD_UNCONFIRMED'

/** Typed refusal for an upload that must not disclose bytes. Never retried. */
export class UploadValidationError extends Error {
  readonly code: UploadErrorCode
  constructor(code: UploadErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'UploadValidationError'
    this.code = code
  }
}

interface ValidatedTicket {
  id: string
  uploadUrl: string
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new UploadValidationError('UPLOAD_CANCELLED', 'the upload was cancelled. No bytes were sent.')
  }
}

/** Validate the ticket envelope against the verified contract. Fails closed. */
function parseTicket(result: McpCallResult, contract: VerifiedUploadContract): ValidatedTicket {
  if (result?.isError === true) {
    const detail = Array.isArray(result.content)
      ? result.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n').slice(0, 200)
      : ''
    throw new UploadValidationError(
      'UPLOAD_TICKET_FAILED',
      `the upload ticket request failed${detail ? ` (${detail})` : ''}. No bytes were sent.`,
    )
  }
  const envelope = ticketEnvelope(result, contract)
  if (envelope.object !== 'file_upload') {
    throw new UploadValidationError(
      'UPLOAD_TICKET_INVALID',
      'the ticket was not a recognized file_upload object. No bytes were sent.',
    )
  }
  if (typeof envelope.number_of_parts === 'number' && envelope.number_of_parts > 1) {
    throw new UploadValidationError(
      'UPLOAD_TICKET_INVALID',
      'multi-part tickets are not supported — only single-part uploads within the size budget. No bytes were sent.',
    )
  }
  const id = envelope.id
  if (typeof id !== 'string' || !id) {
    throw new UploadValidationError('UPLOAD_TICKET_INVALID', 'the ticket carries no file_upload id. No bytes were sent.')
  }
  const uploadUrl = envelope.upload_url
  if (typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new UploadValidationError('UPLOAD_TICKET_INVALID', 'the ticket carries no upload_url. No bytes were sent.')
  }
  let parsed: URL
  try {
    parsed = new URL(uploadUrl)
  } catch {
    throw new UploadValidationError('UPLOAD_ORIGIN_REFUSED', 'the ticket upload_url is not a parseable URL. No bytes were sent.')
  }
  if (parsed.protocol !== 'https:') {
    throw new UploadValidationError('UPLOAD_ORIGIN_REFUSED', 'the ticket upload_url is not HTTPS. No bytes were sent.')
  }
  if (parsed.username || parsed.password) {
    throw new UploadValidationError('UPLOAD_ORIGIN_REFUSED', 'the ticket upload_url embeds credentials. No bytes were sent.')
  }
  // Exact origin comparison only: suffix matching would admit lookalikes.
  if (!contract.allowedOrigins.includes(parsed.origin)) {
    throw new UploadValidationError(
      'UPLOAD_ORIGIN_REFUSED',
      `the ticket destination (${parsed.origin}) is not a verified upload origin. No bytes were sent.`,
    )
  }
  if (!parsed.pathname.startsWith(contract.uploadPathPrefix)) {
    throw new UploadValidationError('UPLOAD_ORIGIN_REFUSED', 'the ticket destination has an unexpected URL shape. No bytes were sent.')
  }
  return { id, uploadUrl }
}

/** Extract the ticket object from structured content or bounded JSON text. */
function ticketEnvelope(result: McpCallResult, contract: VerifiedUploadContract): Record<string, unknown> {
  if (result?.structuredContent != null && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>
  }
  const text = Array.isArray(result?.content)
    ? result.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n')
    : ''
  if (new TextEncoder().encode(text).length > contract.maxJsonBytes) {
    throw new UploadValidationError('UPLOAD_TICKET_INVALID', 'the ticket payload exceeds the size budget. No bytes were sent.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UploadValidationError('UPLOAD_TICKET_INVALID', 'the ticket payload is not recognized JSON. No bytes were sent.')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UploadValidationError('UPLOAD_TICKET_INVALID', 'the ticket payload is not a recognized object. No bytes were sent.')
  }
  return parsed as Record<string, unknown>
}

/** Verify the send response confirms the attributed upload. Fails closed. */
function parseConfirmation(text: string, ticketId: string): { id: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UploadValidationError('UPLOAD_UNCONFIRMED', 'the upload response was not recognized JSON, so success cannot be confirmed.')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UploadValidationError('UPLOAD_UNCONFIRMED', 'the upload response was not a recognized object, so success cannot be confirmed.')
  }
  const record = parsed as Record<string, unknown>
  if (record.object !== 'file_upload' || record.status !== 'uploaded') {
    throw new UploadValidationError(
      'UPLOAD_UNCONFIRMED',
      'the provider did not confirm an uploaded file_upload object, so success cannot be claimed.',
    )
  }
  if (record.id !== ticketId) {
    throw new UploadValidationError('UPLOAD_UNCONFIRMED', 'the confirmed upload id does not match the ticket, so attribution failed.')
  }
  return { id: record.id as string }
}

/** Read a provider body with a hard byte budget (Content-Length is advisory). */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  code: 'UPLOAD_FAILED' | 'UPLOAD_UNCONFIRMED' | 'UPLOAD_TICKET_INVALID',
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UploadValidationError(code, 'the provider body exceeds the size budget.')
  }
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new UploadValidationError(code, 'the provider body exceeds the size budget.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export async function uploadLocalAttachment(
  attachment: StoredAttachment,
  deps: {
    createTicket: () => Promise<McpCallResult>
    fetchImpl: typeof fetch
    /** Verified ticket contract. No default: the caller must prove verification. */
    contract: VerifiedUploadContract
    signal?: AbortSignal
    onStage?: (stage: UploadStage) => void
  },
): Promise<UploadResult> {
  throwIfAborted(deps.signal)
  if (attachment.blob.size !== attachment.size) {
    throw new UploadValidationError(
      'ATTACHMENT_MISMATCH',
      'the stored file no longer matches its recorded size — reselect it before retrying. No bytes were sent.',
    )
  }
  if (attachment.size > deps.contract.maxBytes) {
    throw new UploadValidationError(
      'ATTACHMENT_TOO_LARGE',
      `the file is ${attachment.size} bytes, above the ${deps.contract.maxBytes}-byte single-part budget. No bytes were sent.`,
    )
  }
  let ticketResult: McpCallResult
  try {
    ticketResult = await deps.createTicket()
  } catch (error) {
    if (deps.signal?.aborted) throw new UploadValidationError('UPLOAD_CANCELLED', 'the upload was cancelled before dispatch. No bytes were sent.')
    throw error
  }
  // Stop on cancellation between stages: a validated ticket is never used
  // after the turn moved on.
  throwIfAborted(deps.signal)
  const ticket = parseTicket(ticketResult, deps.contract)
  deps.onStage?.('ticket-created')
  throwIfAborted(deps.signal)
  const form = new FormData()
  // The verified contract sends exactly one field: the bytes under `file`.
  // No form_fields / field_name aliases exist in the provider contract.
  form.append('file', attachment.blob, attachment.name)
  let response: Response
  try {
    // Redirects are never followed and no Authorization header is ever set:
    // the session bearer must not travel to another origin, and a redirect
    // target must never receive bytes.
    response = await deps.fetchImpl(ticket.uploadUrl, { method: 'POST', body: form, signal: deps.signal, redirect: 'manual' })
  } catch (error) {
    if (deps.signal?.aborted) throw new UploadValidationError('UPLOAD_CANCELLED', 'the upload was cancelled during dispatch. The outcome is unknown — inspect before retrying.')
    // Unknown POST outcome is never retried: the bytes may have landed.
    throw error
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new UploadValidationError(
      'UPLOAD_REDIRECT_REFUSED',
      'the upload endpoint answered with a redirect, which was rejected before any bytes reached its destination. No retry was attempted.',
    )
  }
  if (!response.ok) {
    const snippet = await readBoundedText(response, deps.contract.maxJsonBytes, 'UPLOAD_FAILED').catch(() => '')
    throw new UploadValidationError(
      'UPLOAD_FAILED',
      `file upload ${response.status}${snippet ? `: ${snippet.slice(0, 200)}` : ''}. No retry was attempted.`,
    )
  }
  deps.onStage?.('bytes-dispatched')
  const confirmation = await readBoundedText(response, deps.contract.maxJsonBytes, 'UPLOAD_UNCONFIRMED')
  const result = parseConfirmation(confirmation, ticket.id)
  deps.onStage?.('upload-confirmed')
  return {
    fileUploadId: result.id,
    filename: attachment.name,
    message:
      `UPLOADED_NOT_ATTACHED: "${attachment.name}" (file_upload ${result.id}) reached Notion storage ` +
      `but is attached to no page. Attach it with a separate page edit before the upload expires; ` +
      `do not present the upload as a completed page change.`,
  }
}
