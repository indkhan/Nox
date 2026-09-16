import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
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
  const CONTRACT = {
    allowedOrigins: ['https://api.notion.com'],
    uploadPathPrefix: '/v1/file_uploads/',
    maxJsonBytes: 64 * 1024,
    maxBytes: 20 * 1024 * 1024,
  }
  const TICKET_ID = '44444444-4444-4444-8444-444444444444'
  const TICKET_URL = `https://api.notion.com/v1/file_uploads/${TICKET_ID}/send`

  function fixture(name: string): unknown {
    return JSON.parse(readFileSync(`tests/fixtures/notion/${name}`, 'utf8'))
  }
  function attachment() {
    return { id: 'a1', name: 'notes.txt', mimeType: 'text/plain', size: 5, blob: new Blob(['hello']), createdAt: 1 }
  }
  function ticketResult(payload: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  it('posts bytes to the verified ticket origin and reports uploaded-but-unattached', async () => {
    const stages: string[] = []
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify(fixture('upload-result.json')), { status: 200 })
    }) as unknown as typeof fetch
    const result = await uploadLocalAttachment(attachment(), {
      createTicket: async () => ticketResult(fixture('upload-ticket.json')),
      fetchImpl,
      contract: CONTRACT,
      onStage: (stage) => void stages.push(stage),
    })
    expect(result).toMatchObject({ fileUploadId: TICKET_ID, filename: 'notes.txt' })
    expect(result.message).toMatch(/UPLOADED_NOT_ATTACHED/)
    expect(result.message).toContain(TICKET_ID)
    expect(result.message).toMatch(/attached to no page/)
    expect(stages).toEqual(['ticket-created', 'bytes-dispatched', 'upload-confirmed'])
    // Exactly one byte dispatch, to the verified origin only …
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(TICKET_URL)
    expect(seen[0].init?.method).toBe('POST')
    // … with the verified single `file` field and no bearer token anywhere.
    const form = seen[0].init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect([...form.keys()]).toEqual(['file'])
    expect(seen[0].init?.headers).toBeUndefined()
  })

  it('refuses wrong origins, lookalikes, credentials, and non-HTTPS tickets', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    for (const [label, upload_url] of [
      ['foreign host', 'https://files.example.com/send'],
      ['suffix lookalike', 'https://api.notion.com.evil.example/v1/file_uploads/x/send'],
      ['embedded credentials', `https://user:pass@api.notion.com/v1/file_uploads/x/send`],
      ['plain http', 'http://api.notion.com/v1/file_uploads/x/send'],
      ['unexpected shape', 'https://api.notion.com/v1/pages/x'],
    ] as const) {
      await expect(
        uploadLocalAttachment(attachment(), {
          createTicket: async () => ticketResult({ object: 'file_upload', id: TICKET_ID, upload_url }),
          fetchImpl,
          contract: CONTRACT,
        }),
        label,
      ).rejects.toThrow(/UPLOAD_ORIGIN_REFUSED/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects redirects at the transport level before bytes reach the target', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(String(url))
      expect(init?.redirect).toBe('manual')
      return new Response(null, { status: 307, headers: { location: 'https://files.example.com/stolen' } })
    }) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ticketResult(fixture('upload-ticket.json')),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/UPLOAD_REDIRECT_REFUSED/)
    // The redirect target never receives bytes.
    expect(seen).toEqual([TICKET_URL])
  })

  it('rejects tool-error tickets without touching the transport', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ({ content: [{ type: 'text', text: 'slow down' }], isError: true }),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/UPLOAD_TICKET_FAILED/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects malformed, oversize, and multi-part tickets without transport', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const cases: Array<[string, unknown]> = [
      ['non-object', 'just a string'],
      ['wrong object', { object: 'page', id: TICKET_ID }],
      ['missing id', { object: 'file_upload', upload_url: TICKET_URL }],
      ['missing url', { object: 'file_upload', id: TICKET_ID }],
      ['multi-part', { object: 'file_upload', id: TICKET_ID, upload_url: TICKET_URL, number_of_parts: 3 }],
      // Guessed legacy aliases carry no contract evidence and are refused.
      ['legacy aliases only', { upload_url: undefined, url: TICKET_URL, form_fields: {}, field_name: 'file' }],
    ]
    for (const [label, payload] of cases) {
      await expect(
        uploadLocalAttachment(attachment(), {
          createTicket: async () =>
            typeof payload === 'string' ? { content: [{ type: 'text', text: payload }] } : ticketResult(payload),
          fetchImpl,
          contract: CONTRACT,
        }),
        label,
      ).rejects.toThrow(/UPLOAD_TICKET_INVALID/)
    }
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ({ content: [{ type: 'text', text: `{"object":"file_upload","pad":"${'x'.repeat(70 * 1024)}"}` }] }),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/UPLOAD_TICKET_INVALID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops on cancellation between stages without dispatching bytes', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => {
          controller.abort()
          return ticketResult(fixture('upload-ticket.json'))
        },
        fetchImpl,
        contract: CONTRACT,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/UPLOAD_CANCELLED/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses before ticket creation when already cancelled', async () => {
    const createTicket = vi.fn(async () => ticketResult(fixture('upload-ticket.json')))
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket,
        fetchImpl: fetch,
        contract: CONTRACT,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/UPLOAD_CANCELLED/)
    expect(createTicket).not.toHaveBeenCalled()
  })

  it('never retries an ambiguous dispatch failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up after commit')
    }) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ticketResult(fixture('upload-ticket.json')),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/socket hang up/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces provider rejections once with a bounded detail', async () => {
    const fetchImpl = vi.fn(async () => new Response('downstream failure', { status: 500 })) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ticketResult(fixture('upload-ticket.json')),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/UPLOAD_FAILED.*500/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses unconfirmed and misattributed results instead of claiming success', async () => {
    const fetchImplFor = (payload: unknown) =>
      (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
    const base = {
      createTicket: async () => ticketResult(fixture('upload-ticket.json')),
      contract: CONTRACT,
    }
    await expect(
      uploadLocalAttachment(attachment(), { ...base, fetchImpl: fetchImplFor({ object: 'file_upload', id: TICKET_ID, status: 'pending' }) }),
    ).rejects.toThrow(/UPLOAD_UNCONFIRMED/)
    await expect(
      uploadLocalAttachment(attachment(), { ...base, fetchImpl: fetchImplFor({ object: 'file_upload', id: 'other-id', status: 'uploaded' }) }),
    ).rejects.toThrow(/UPLOAD_UNCONFIRMED/)
    await expect(
      uploadLocalAttachment(attachment(), { ...base, fetchImpl: fetchImplFor({ object: 'page', id: TICKET_ID }) }),
    ).rejects.toThrow(/UPLOAD_UNCONFIRMED/)
  })

  it('refuses oversize provider bodies without buffering them', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(70 * 1024), { status: 200, headers: { 'content-length': String(70 * 1024) } })) as unknown as typeof fetch
    await expect(
      uploadLocalAttachment(attachment(), {
        createTicket: async () => ticketResult(fixture('upload-ticket.json')),
        fetchImpl,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/UPLOAD_UNCONFIRMED/)
  })

  it('refuses attachments whose bytes no longer match stored metadata', async () => {
    const createTicket = vi.fn(async () => ticketResult(fixture('upload-ticket.json')))
    await expect(
      uploadLocalAttachment({ ...attachment(), size: 6 }, {
        createTicket,
        fetchImpl: fetch,
        contract: CONTRACT,
      }),
    ).rejects.toThrow(/ATTACHMENT_MISMATCH/)
    expect(createTicket).not.toHaveBeenCalled()
  })
})
