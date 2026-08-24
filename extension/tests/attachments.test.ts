// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { attachmentRepository } from '../src/lib/history/attachments'
import { openNoxDB } from '../src/lib/history/schema'
import { buildContextPreamble } from '../src/lib/agent/context'

describe('local attachments', () => {
  beforeEach(async () => { await (await openNoxDB()).clear('attachments') })

  it('stores file bytes locally and exposes only metadata to the model', async () => {
    const repo = attachmentRepository(openNoxDB)
    const ref = await repo.save(new File(['hello'], 'notes.txt', { type: 'text/plain' }), 'thread-1')
    expect(ref).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain', size: 5 })
    expect((await repo.get(ref.id))?.blob.size).toBe(5)
    const context = buildContextPreamble({ attachments: [ref] })
    expect(context).toContain('<local_attachment')
    expect(context).toContain('notes.txt')
    expect(context).not.toContain('hello')
  })

  it('removes attachments with their thread', async () => {
    const repo = attachmentRepository(openNoxDB)
    const first = await repo.save(new File(['a'], 'a.txt'), 'thread-1')
    const second = await repo.save(new File(['b'], 'b.txt'), 'thread-2')
    await repo.removeForThread('thread-1')
    expect(await repo.get(first.id)).toBeUndefined()
    expect(await repo.get(second.id)).toBeDefined()
  })
})
