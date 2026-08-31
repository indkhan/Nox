import { describe, expect, it, vi } from 'vitest'
import { uploadLocalAttachment } from '../src/lib/attachments/upload-tool'

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
