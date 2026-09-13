import { describe, expect, it, vi } from 'vitest'
import {
  UPLOAD_TICKET_TOOL_NAME,
  isRawUploadTicketTool,
  isUploadTicketContractVerified,
  isUploadWorkflowSupported,
  uploadLocalAttachment,
  uploadUnsupportedMessage,
} from '../src/lib/attachments/upload-tool'
import { CapabilityGate } from '../src/lib/notion/capabilities'

describe('upload workflow support (Epoch 08)', () => {
  const ticketTool = { name: UPLOAD_TICKET_TOOL_NAME, description: 'Ticket', inputSchema: { type: 'object' } }

  it('names the raw ticket route so advertisement can exclude it', () => {
    expect(isRawUploadTicketTool(UPLOAD_TICKET_TOOL_NAME)).toBe(true)
    expect(isRawUploadTicketTool('notion-search')).toBe(false)
    expect(isRawUploadTicketTool(null)).toBe(false)
  })

  it('withholds support without a verified ticket contract, even when discovered and allowed', () => {
    expect(isUploadTicketContractVerified()).toBe(false)
    expect(isUploadWorkflowSupported([ticketTool], new CapabilityGate())).toBe(false)
  })

  it('withholds support when the ticket tool is undiscovered or capability-gated', () => {
    expect(isUploadWorkflowSupported([], new CapabilityGate())).toBe(false)
    expect(
      isUploadWorkflowSupported([ticketTool], new CapabilityGate({ 'create-file-upload': 'upgrade_required' })),
    ).toBe(false)
  })

  it('explains the unsupported state without promising a future upload', () => {
    expect(uploadUnsupportedMessage()).toMatch(/UPLOAD_UNSUPPORTED/)
    expect(uploadUnsupportedMessage()).toMatch(/no verified upload-ticket contract/)
    expect(uploadUnsupportedMessage()).toMatch(/local-only/)
  })
})

describe('uploadLocalAttachment', () => {
  it('uses only a Notion-issued HTTPS upload ticket and returns suggested markdown', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://uploads.notion.com/file')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify({ suggested_markdown: '<file src="attachment:1">notes.txt</file>' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await uploadLocalAttachment({ id: 'a1', name: 'notes.txt', mimeType: 'text/plain', size: 5, blob: new Blob(['hello']), createdAt: 1 }, {
      createTicket: async () => ({ content: [], structuredContent: { upload_url: 'https://uploads.notion.com/file', field_name: 'file', form_fields: { token: 'abc' } } }),
      fetchImpl,
    })
    expect(result).toContain('<file')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects non-HTTPS upload tickets', async () => {
    await expect(uploadLocalAttachment({ id: 'a1', name: 'x', mimeType: 'text/plain', size: 1, blob: new Blob(['x']), createdAt: 1 }, {
      createTicket: async () => ({ content: [{ type: 'text', text: JSON.stringify({ upload_url: 'http://localhost/x' }) }] }),
      fetchImpl: fetch,
    })).rejects.toThrow(/HTTPS/)
  })
})
