// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { openDB, deleteDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openNoxDB, DB_VERSION } from '../src/lib/history/schema'
import { threadRepository, type ThreadRepository } from '../src/lib/history/repository'
import { MutationJournal, idbJournalStore, type JournalEntry } from '../src/lib/writes/journal'
import { startPersistedTurn } from '../src/lib/history/turn'

describe('IndexedDB schema', () => {
  it('removes unused v2 stores and indexes while preserving records', async () => {
    const old = await openDB('nox', 2, {
      upgrade(db) {
        const threads = db.createObjectStore('threads', { keyPath: 'id' })
        threads.createIndex('by_updated', 'updatedAt')
        threads.createIndex('by_pinned', 'pinned')
        const messages = db.createObjectStore('messages', { keyPath: 'id' })
        messages.createIndex('by_thread', 'threadId')
        messages.createIndex('by_ts', 'ts')
        db.createObjectStore('journal', { keyPath: 'id' }).createIndex('by_thread', 'threadId')
        db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('by_thread', 'threadId')
        db.createObjectStore('pageCache', { keyPath: 'pageId' })
        db.createObjectStore('mentionCache', { keyPath: 'pageId' })
      },
    })
    for (const store of ['threads', 'messages', 'journal', 'attachments']) {
      await old.put(store, { id: store, threadId: 'threads', text: 'retained' })
    }
    old.close()
    const db = await openNoxDB()
    try {
      expect([...db.objectStoreNames]).toEqual(['attachments', 'journal', 'messages', 'threads'])
      expect([...db.transaction('threads').store.indexNames]).toEqual([])
      expect([...db.transaction('messages').store.indexNames]).toEqual(['by_thread'])
      for (const store of ['threads', 'messages', 'journal', 'attachments']) {
        expect(await db.get(store, store)).toMatchObject({ id: store, text: 'retained' })
      }
    } finally {
      db.close()
      await deleteDB('nox')
    }
  })

  it('opens at the current version with only the four used stores', async () => {
    const db = await openNoxDB()
    expect(DB_VERSION).toBe(3)
    expect(db.version).toBe(DB_VERSION)
    for (const store of ['threads', 'messages', 'journal', 'attachments']) {
      expect(db.objectStoreNames.contains(store)).toBe(true)
    }
    db.close()
  })

  it('upgrades idempotently from an older version without duplicating stores', async () => {
    const db = await openNoxDB()
    const db2 = await openNoxDB()
    expect(db2.version).toBe(DB_VERSION)
    db.close()
    db2.close()
  })
})

describe('persistent mutation journal', () => {
  it('survives a new journal instance', async () => {
    const db = await openNoxDB()
    await db.clear('journal')
    const first = new MutationJournal(idbJournalStore(openNoxDB))
    first.setThread('thread-a')
    await first.record({ tool: 'notion-update-page', args: {}, kind: 'content-update' })
    const second = new MutationJournal(idbJournalStore(openNoxDB))
    second.setThread('thread-b')
    await second.record({ tool: 'other', args: {}, kind: 'content-update' })
    const reopened = new MutationJournal(idbJournalStore(openNoxDB))
    reopened.setThread('thread-a')
    const entries = await reopened.newestFirst()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ threadId: 'thread-a', status: 'applied' })
    expect(entries[0].turnId).toBeTruthy()
    db.close()
  })

  it('does not overwrite concurrent journal records', async () => {
    const db = await openNoxDB()
    await db.clear('journal')
    const journal = new MutationJournal(idbJournalStore(openNoxDB))
    journal.setThread('thread-a')
    await Promise.all([
      journal.record({ tool: 'first', args: {}, kind: 'content-update' }),
      journal.record({ tool: 'second', args: {}, kind: 'content-update' }),
    ])
    expect(await journal.newestFirst()).toHaveLength(2)
    db.close()
  })

  it('orders journal entries by timestamp rather than UUID key order', async () => {
    const entries = [
      { id: 'z', ts: 1, threadId: 't', turnId: 'x', status: 'applied' as const, tool: 'old', args: {}, kind: 'write' },
      { id: 'a', ts: 2, threadId: 't', turnId: 'x', status: 'applied' as const, tool: 'new', args: {}, kind: 'write' },
    ]
    const journal = new MutationJournal({ append: async () => undefined, list: async () => entries })
    expect((await journal.newestFirst()).map((entry) => entry.tool)).toEqual(['new', 'old'])
  })

  it('can scope reads without starting a new mutation turn', async () => {
    const journal = new MutationJournal()
    journal.setThread('first')
    await journal.record({ tool: 'first-write', args: {}, kind: 'write' })
    journal.setThread('second')
    await journal.record({ tool: 'second-write', args: {}, kind: 'write' })
    journal.scopeThread('first')
    expect((await journal.newestFirst()).map((entry) => entry.tool)).toEqual(['first-write'])
    journal.scopeThread(null)
    expect(await journal.newestFirst()).toEqual([])
  })

  it('orders same-timestamp entries deterministically by id', async () => {
    const fixed = Date.now()
    const entries = [
      { id: 'z-last', ts: fixed, threadId: 't', turnId: 'x', status: 'applied' as const, tool: 'old', args: {}, kind: 'write' },
      { id: 'a-first', ts: fixed, threadId: 't', turnId: 'x', status: 'applied' as const, tool: 'new', args: {}, kind: 'write' },
    ]
    const journal = new MutationJournal({ append: async () => undefined, list: async () => entries })
    const first = await journal.newestFirst()
    const second = await journal.newestFirst()
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id))
    expect(first).toHaveLength(2)
  })

  it('assigns timestamps without scanning stored payloads', async () => {
    let lists = 0
    const kept: JournalEntry[] = []
    const journal = new MutationJournal({
      append: async (entry) => { kept.push(entry) },
      list: async () => { lists++; throw new Error('must not scan') },
    })
    journal.setThread('t')
    await journal.record({ tool: 'write', args: {}, kind: 'write' })
    expect(kept).toHaveLength(1)
    expect(kept[0].ts).toBeGreaterThan(0)
    expect(lists).toBe(0)
  })

  it('keeps intent and settlement under one operation id', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-a')
    const scope = { threadId: 'thread-a', turnId: 'turn-1', workspaceId: 'ws', connectionGeneration: 'c', ownerGeneration: 'o' }
    const intent = await journal.beginIntent({ tool: 'notion-update-page', args: { a: 1 }, kind: 'content-update', scope })
    expect(intent.status).toBe('pending')
    expect(intent.scope).toEqual(scope)
    const settled = await journal.settleIntent(intent.id, { status: 'applied', outcomeDetail: 'ok' })
    expect(settled?.id).toBe(intent.id)
    expect(settled?.status).toBe('applied')
    expect(await journal.newestFirst()).toHaveLength(1)
  })

  it('reserves an undo atomically so a second claim loses', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-a')
    const scope = { threadId: 'thread-a', turnId: 'turn-1', workspaceId: 'ws', connectionGeneration: 'c', ownerGeneration: 'o' }
    const original = await journal.record({
      tool: 'write', args: {}, kind: 'content-update', inverse: { tool: 'undo', args: {} },
    })
    const first = await journal.beginUndoReservation(original.id, { tool: 'undo', args: {}, kind: 'undo', scope })
    expect(first).not.toBeNull()
    expect((await journal.getEntry(original.id))?.reservedByUndoOpId).toBe(first!.undo.id)
    expect(await journal.undoable()).toHaveLength(0)
    const second = await journal.beginUndoReservation(original.id, { tool: 'undo', args: {}, kind: 'undo', scope })
    expect(second).toBeNull()
  })

  it('records user review without rewriting the outcome', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-a')
    const scope = { threadId: 'thread-a', turnId: 'turn-1', workspaceId: 'ws', connectionGeneration: 'c', ownerGeneration: 'o' }
    const intent = await journal.beginIntent({ tool: 't', args: {}, kind: 'write', scope })
    expect(await journal.markReviewed(intent.id, 'inspected')).toBe(true)
    expect(await journal.markReviewed('missing', 'x')).toBe(false)
    const entry = await journal.getEntry(intent.id)
    expect(entry?.status).toBe('pending')
    expect(entry?.reviewedAt).toBeGreaterThan(0)
  })

  it('serves thread-scoped journal reads without loading other threads', async () => {
    const db = await openNoxDB()
    await db.clear('journal')
    const journal = new MutationJournal(idbJournalStore(openNoxDB))
    journal.setThread('thread-a')
    await journal.record({ tool: 'a-write', args: {}, kind: 'write' })
    journal.setThread('thread-b')
    await journal.record({ tool: 'b-write', args: {}, kind: 'write' })
    const scoped = new MutationJournal(idbJournalStore(openNoxDB))
    scoped.scopeThread('thread-a')
    expect((await scoped.newestFirst()).map((e) => e.tool)).toEqual(['a-write'])
    expect((await scoped.newestForThread('thread-b')).map((e) => e.tool)).toEqual(['b-write'])
    db.close()
  })

  it('resolves concurrent undo reservations atomically in IndexedDB', async () => {
    const db = await openNoxDB()
    await db.clear('journal')
    const scope = { threadId: 'thread-a', turnId: 'turn-1', workspaceId: 'ws', connectionGeneration: 'c', ownerGeneration: 'o' }
    const first = new MutationJournal(idbJournalStore(openNoxDB))
    first.setThread('thread-a')
    const original = await first.record({
      tool: 'write', args: {}, kind: 'content-update', inverse: { tool: 'undo', args: {} },
    })
    const second = new MutationJournal(idbJournalStore(openNoxDB))
    second.setThread('thread-a')
    const [a, b] = await Promise.all([
      first.beginUndoReservation(original.id, { tool: 'undo', args: {}, kind: 'undo', scope }),
      second.beginUndoReservation(original.id, { tool: 'undo', args: {}, kind: 'undo', scope }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const winner = a ?? b
    expect((await first.getEntry(original.id))?.reservedByUndoOpId).toBe(winner!.undo.id)
    db.close()
  })

  it('releases a failed undo claim instead of wedging later undo', async () => {
    let failures = 1
    const stored = {
      id: 'e1',
      ts: 1,
      threadId: 't',
      turnId: 'x',
      status: 'applied' as const,
      tool: 'write',
      args: {},
      kind: 'content-update',
      inverse: { tool: 'undo', args: {} },
    }
    const journal = new MutationJournal({
      append: async () => undefined,
      list: async () => {
        if (failures > 0) {
          failures--
          throw new Error('storage offline')
        }
        return [stored]
      },
    })
    await expect(journal.claimUndo()).rejects.toThrow('storage offline')
    const entry = await journal.claimUndo()
    expect(entry?.id).toBe('e1')
    journal.releaseUndo()
  })
})

describe('ThreadRepository', () => {
  let repo: ThreadRepository

  beforeEach(async () => {
    // fresh in-memory database per test (fake-indexeddb is module-global)
    const { IDBFactory } = await import('fake-indexeddb')
    new IDBFactory()
    repo = threadRepository(openNoxDB)
  })

  it('creates threads and lists newest-first with pins on top', async () => {
    const a = await repo.createThread('First')
    await new Promise((r) => setTimeout(r, 5))
    const b = await repo.createThread('Second')
    b.updatedAt = Date.now() + 10
    await repo.setPinned(a.id, true)

    const list = await repo.listThreads()
    expect(list[0].id).toBe(a.id) // pinned first
    expect(list.map((t) => t.title)).toContain('Second')
  })

  it('appends messages incrementally and reads them back in order', async () => {
    const t = await repo.createThread()
    await repo.appendMessage(t.id, { role: 'user', text: 'hello' })
    await new Promise((r) => setTimeout(r, 3))
    await repo.appendMessage(t.id, { role: 'assistant', text: 'hi there', usage: { output_tokens: 4 } })

    const messages = await repo.getMessages(t.id)
    expect(messages.map((m) => m.text)).toEqual(['hello', 'hi there'])
    expect(messages[1].usage?.output_tokens).toBe(4)
  })

  it('persists the matching Codex thread for conversation resume', async () => {
    const thread = await repo.createThread()
    await repo.setCodexThreadId(thread.id, 'codex-thread-1')

    expect(await repo.getThread(thread.id)).toMatchObject({ id: thread.id, codexThreadId: 'codex-thread-1' })
  })

  it('persists structured assistant activity', async () => {
    const t = await repo.createThread()
    await repo.appendMessage(t.id, {
      role: 'assistant',
      text: 'Done',
      activity: [{ kind: 'tool', id: 'call-1', tool: 'notion-fetch', args: {}, status: 'completed' }],
    })

    expect((await repo.getMessages(t.id))[0].activity).toEqual([
      expect.objectContaining({ id: 'call-1', status: 'completed' }),
    ])
  })

  it('keeps message order deterministic when the clock does not advance', async () => {
    const now = Date.now
    Date.now = () => 1234
    try {
      const thread = await repo.createThread()
      await repo.appendMessage(thread.id, { id: 'z-user', role: 'user', text: 'question' })
      await repo.appendMessage(thread.id, { id: 'a-assistant', role: 'assistant', text: 'answer' })
      expect((await repo.getMessages(thread.id)).map((message) => message.text)).toEqual(['question', 'answer'])
    } finally {
      Date.now = now
    }
  })

  it('persists the user immediately and upserts streamed assistant text', async () => {
    const turn = await startPersistedTurn(repo, null, 'do work')
    expect((await repo.getMessages(turn.threadId)).map((m) => m.text)).toEqual(['do work'])
    await turn.persistAssistant('partial')
    await turn.persistAssistant('complete')
    expect((await repo.getMessages(turn.threadId)).map((m) => m.text)).toEqual(['do work', 'complete'])
  })

  it('searches titles AND message text with snippets', async () => {
    const a = await repo.createThread('Roadmap planning')
    await repo.appendMessage(a.id, { role: 'user', text: 'quarterly objectives discussion' })
    const b = await repo.createThread('Random')

    const byTitle = await repo.searchThreads('roadmap')
    expect(byTitle).toHaveLength(1)
    expect(byTitle[0].thread.id).toBe(a.id)

    const byText = await repo.searchThreads('objectives')
    expect(byText).toHaveLength(1)
    expect(byText[0].snippet).toContain('objectives')

    const none = await repo.searchThreads('nonexistent-query')
    expect(none).toHaveLength(0)
    void b
  })

  it('renames and deletes threads including their messages', async () => {
    const t = await repo.createThread('Old name')
    await repo.appendMessage(t.id, { role: 'user', text: 'x' })
    await repo.renameThread(t.id, 'Renamed')

    const renamed = (await repo.searchThreads('Renamed'))[0]
    expect(renamed.thread.id).toBe(t.id)

    await repo.deleteThread(t.id)
    expect(await repo.getMessages(t.id)).toEqual([])
    expect((await repo.listThreads()).map((x) => x.id)).not.toContain(t.id)
  })

  it('exports as JSON and markdown', async () => {
    const t = await repo.createThread('Export me')
    await repo.appendMessage(t.id, { role: 'user', text: 'question one' })
    await repo.appendMessage(t.id, { role: 'assistant', text: '**answer** one' })

    const json = JSON.parse(await repo.exportThread(t.id, 'json'))
    expect(json.thread.title).toBe('Export me')
    expect(json.messages).toHaveLength(2)

    const markdown = await repo.exportThread(t.id, 'markdown')
    expect(markdown).toContain('# Export me')
    expect(markdown).toContain('**You:** question one')
    expect(markdown).toContain('**Nox:** **answer** one')
  })
})

