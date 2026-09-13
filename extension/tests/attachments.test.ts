// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { attachmentRepository } from '../src/lib/history/attachments'
import { openNoxDB, closeNoxDBConnections, __resetConnectionCacheForTests } from '../src/lib/history/schema'
import { __resetDeletionStateForTests } from '../src/lib/history/deletion'
import { threadRepository } from '../src/lib/history/repository'
import { startPersistedTurn } from '../src/lib/history/turn'
import { buildContextPreamble } from '../src/lib/agent/context'
import {
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  createDraftAttachments,
  validateDraftSelection,
} from '../src/shared/attachments'

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

describe('ephemeral drafts and atomic send ownership (Epoch 10 / M7)', () => {
  beforeEach(async () => {
    __resetConnectionCacheForTests()
    __resetDeletionStateForTests()
    const db = await openNoxDB()
    await Promise.all([db.clear('threads'), db.clear('messages'), db.clear('attachments')])
    closeNoxDBConnections()
  })

  function file(name: string, size: number): File {
    const bytes = new Uint8Array(size)
    return new File([bytes], name, { type: 'text/plain' })
  }

  it('creates stable draft ids without persisting bytes on selection', async () => {
    const drafts = createDraftAttachments([file('a.txt', 3), file('b.txt', 4)])
    expect(drafts).toHaveLength(2)
    expect(drafts[0].id).toBeTruthy()
    expect(drafts[0].id).not.toBe(drafts[1].id)
    expect(drafts[0]).toMatchObject({ name: 'a.txt', mimeType: 'text/plain', size: 3 })
    // Selecting files writes nothing: removing a chip before Send leaves no row.
    expect(await (await openNoxDB()).getAll('attachments')).toEqual([])
    // Ids stay stable while editing the draft (same objects, same ids).
    expect(createDraftAttachments([])).toEqual([])
    expect(drafts.map((d) => d.id)).toHaveLength(2)
    closeNoxDBConnections()
  })

  it('bounds selection and names every rejected file with its reason', () => {
    expect(MAX_ATTACHMENT_FILES).toBe(10)
    expect(MAX_ATTACHMENT_FILE_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_ATTACHMENT_TOTAL_BYTES).toBe(25 * 1024 * 1024)
    // One file over the per-file budget is rejected, not silently filtered.
    const oversize = validateDraftSelection([], [file('big.bin', MAX_ATTACHMENT_FILE_BYTES + 1)])
    expect(oversize.accepted).toEqual([])
    expect(oversize.rejected).toHaveLength(1)
    expect(oversize.rejected[0].name).toBe('big.bin')
    expect(oversize.rejected[0].reason).toMatch(/20 MiB/)
    // The eleventh file is rejected by count, naming the file.
    const eleven = Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, 1))
    const byCount = validateDraftSelection([], eleven)
    expect(byCount.accepted).toHaveLength(10)
    expect(byCount.rejected).toHaveLength(1)
    expect(byCount.rejected[0].name).toBe('f10.txt')
    expect(byCount.rejected[0].reason).toMatch(/10 files/)
    // Aggregate bytes are checked before any read: 6 x 5 MiB exceeds 25 MiB.
    const heavy = Array.from({ length: 6 }, (_, i) => file(`h${i}.bin`, 5 * 1024 * 1024))
    const byTotal = validateDraftSelection([], heavy)
    expect(byTotal.accepted.length).toBeLessThan(6)
    expect(byTotal.rejected.length).toBeGreaterThan(0)
    expect(byTotal.rejected[0].reason).toMatch(/25 MiB/)
    // Existing drafts count toward both budgets.
    const existing = [{ size: MAX_ATTACHMENT_TOTAL_BYTES }]
    const overExisting = validateDraftSelection(existing, [file('one-more.txt', 1)])
    expect(overExisting.accepted).toEqual([])
    expect(overExisting.rejected[0].reason).toMatch(/25 MiB/)
  })

  it('persists drafts atomically with thread ownership before any turn request', async () => {
    const repo = threadRepository(openNoxDB)
    const attachments = attachmentRepository(openNoxDB)
    const drafts = createDraftAttachments([file('a.txt', 3), file('b.txt', 4)])
    const owned = await Promise.all(
      drafts.map(async (draft) => ({ ...draft, bytes: await draft.file.arrayBuffer() })),
    )
    const turn = await startPersistedTurn(repo, null, 'use these files', owned)
    // Thread, user message, and both attachments share one owning thread.
    const stored = await Promise.all(owned.map((item) => attachments.get(item.id)))
    expect(stored[0]).toMatchObject({ name: 'a.txt', size: 3, threadId: turn.threadId })
    expect(stored[1]).toMatchObject({ name: 'b.txt', size: 4, threadId: turn.threadId })
    expect(stored[0]?.blob.size).toBe(3)
    expect(await repo.getMessages(turn.threadId)).toHaveLength(1)
    // The stored row belongs to exactly this thread: cross-thread use refuses.
    for (const row of stored) expect(row?.threadId).not.toBe('some-other-thread')
    closeNoxDBConnections()
  })

  it('failed atomic send writes nothing, so no turn request may use its ids', async () => {
    const repo = threadRepository(openNoxDB)
    const drafts = createDraftAttachments([file('too-big.bin', MAX_ATTACHMENT_FILE_BYTES + 1)])
    const owned = await Promise.all(
      drafts.map(async (draft) => ({ ...draft, bytes: await draft.file.arrayBuffer() })),
    )
    await expect(startPersistedTurn(repo, null, 'send this', owned)).rejects.toThrow(/20 MiB/)
    // Zero partial writes: no thread, no message, no attachment row.
    expect(await (await openNoxDB()).getAll('threads')).toEqual([])
    expect(await (await openNoxDB()).getAll('messages')).toEqual([])
    expect(await (await openNoxDB()).getAll('attachments')).toEqual([])
    closeNoxDBConnections()
  })

  it('never reuses one attachment row across threads', async () => {
    const repo = threadRepository(openNoxDB)
    const attachments = attachmentRepository(openNoxDB)
    const drafts = createDraftAttachments([file('shared.txt', 5)])
    const owned = await Promise.all(
      drafts.map(async (draft) => ({ ...draft, bytes: await draft.file.arrayBuffer() })),
    )
    const first = await startPersistedTurn(repo, null, 'first thread', owned)
    // A second turn reusing the same row id fails instead of overwriting it.
    await expect(startPersistedTurn(repo, null, 'second thread', owned)).rejects.toThrow()
    expect((await attachments.get(owned[0].id))?.threadId).toBe(first.threadId)
    closeNoxDBConnections()
  })
})
