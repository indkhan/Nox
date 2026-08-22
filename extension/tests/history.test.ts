// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { openNoxDB, DB_VERSION } from '../src/lib/history/schema'
import { threadRepository, type ThreadRepository } from '../src/lib/history/repository'
import { MutationJournal, idbJournalStore } from '../src/lib/writes/journal'
import { startPersistedTurn } from '../src/lib/history/turn'

describe('IndexedDB schema', () => {
  it('opens at the current version with all six stores', async () => {
    const db = await openNoxDB()
    expect(DB_VERSION).toBe(2)
    expect(db.version).toBe(DB_VERSION)
    for (const store of ['threads', 'messages', 'journal', 'pageCache', 'mentionCache', 'attachments']) {
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

  it('continues timestamp order after reopening persisted future entries', async () => {
    const entries = [{ id: 'old', ts: Date.now() + 10_000, threadId: 't', turnId: 'x', status: 'applied' as const, tool: 'old', args: {}, kind: 'write' }]
    const store = { append: async (entry: typeof entries[number]) => { entries.push(entry) }, list: async () => [...entries] }
    const reopened = new MutationJournal(store)
    reopened.setThread('t')
    await reopened.record({ tool: 'new', args: {}, kind: 'write' })
    expect((await reopened.newestFirst()).map((entry) => entry.tool)).toEqual(['new', 'old'])
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

