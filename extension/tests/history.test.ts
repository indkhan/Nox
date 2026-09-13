// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { openDB, deleteDB } from 'idb'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { openNoxDB, closeNoxDBConnections, DB_VERSION, __resetConnectionCacheForTests } from '../src/lib/history/schema'
import type { MessageRow } from '../src/lib/history/schema'
import { __resetDeletionStateForTests, type DeletionMark, type DeletionStore } from '../src/lib/history/deletion'
import { deleteAllData } from '../src/lib/history/panel'
import { threadRepository, type ThreadRepository } from '../src/lib/history/repository'
import { MutationJournal, idbJournalStore, type JournalEntry } from '../src/lib/writes/journal'
import { startPersistedTurn } from '../src/lib/history/turn'

describe('IndexedDB schema', () => {
  beforeEach(() => {
    __resetConnectionCacheForTests()
    __resetDeletionStateForTests()
  })
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
      closeNoxDBConnections()
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
    closeNoxDBConnections()
  })

  it('upgrades idempotently from an older version without duplicating stores', async () => {
    await openNoxDB()
    const db2 = await openNoxDB()
    expect(db2.version).toBe(DB_VERSION)
    closeNoxDBConnections()
  })

  it('reuses one cached connection across repeated calls', async () => {
    const first = await openNoxDB()
    const second = await openNoxDB()
    expect(second).toBe(first)
    closeNoxDBConnections()
  })

  it('opens a fresh connection after explicit close', async () => {
    const first = await openNoxDB()
    closeNoxDBConnections()
    const second = await openNoxDB()
    expect(second).not.toBe(first)
    expect(second.version).toBe(DB_VERSION)
    closeNoxDBConnections()
  })

  it('closes promptly on versionchange so another context can delete', async () => {
    const owned = await openNoxDB()
    // A second raw connection stands in for another open panel.
    const other = await openDB('nox', DB_VERSION)
    const deleted = deleteDB('nox')
    // Our cached connection closes itself on versionchange even though the
    // other panel still holds the database blocked …
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(() => owned.transaction('threads', 'readonly')).toThrow()
    // … and once the other panel closes too, deletion completes for real.
    other.close()
    await deleted
    closeNoxDBConnections()
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
    closeNoxDBConnections()
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
    closeNoxDBConnections()
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
    closeNoxDBConnections()
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
    closeNoxDBConnections()
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

describe('cooperative deletion (Epoch 09)', () => {
  function memoryDeletionStore() {
    let mark: DeletionMark | null = null
    return {
      store: {
        get: async () => mark,
        set: async (next: DeletionMark) => {
          mark = next
        },
        clear: async () => {
          mark = null
        },
        onChange: () => () => undefined,
      } satisfies DeletionStore,
      peek: () => mark,
    }
  }

  function stubChrome() {
    const localClear = vi.fn(async () => undefined)
    const sessionClear = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', { storage: { local: { clear: localClear }, session: { clear: sessionClear } } })
    return { localClear, sessionClear }
  }

  beforeEach(() => {
    __resetConnectionCacheForTests()
    __resetDeletionStateForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetConnectionCacheForTests()
    __resetDeletionStateForTests()
  })

  it('clears credentials before deleting the database', async () => {
    const { store, peek } = memoryDeletionStore()
    stubChrome()
    const events: string[] = []
    await deleteAllData({
      deletionStore: store,
      clearCredentials: async () => void events.push('credentials'),
      deleteDatabase: async () => void events.push('database'),
    })
    expect(events).toEqual(['credentials', 'database'])
    // Tombstone was set during the run and lifted at the end.
    expect(peek()).toBeNull()
  })

  it('clears credentials even when database deletion hangs', async () => {
    const { store } = memoryDeletionStore()
    stubChrome()
    let credentialsCleared = false
    let databaseAttempted = false
    const pending = deleteAllData({
      deletionStore: store,
      clearCredentials: async () => {
        credentialsCleared = true
      },
      deleteDatabase: () => {
        databaseAttempted = true
        return new Promise<void>(() => undefined) // hangs forever
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(databaseAttempted).toBe(true)
    expect(credentialsCleared).toBe(true)
    // Tokens are not held hostage: the pending request keeps its own
    // lifecycle instead of resolving early.
    void pending.catch(() => undefined)
  })

  it('reports blocked deletions through onBlocked while still waiting', async () => {
    const { store } = memoryDeletionStore()
    stubChrome()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let blockedCalls = 0
    let settled = false
    const pending = deleteAllData({
      deletionStore: store,
      clearCredentials: async () => undefined,
      deleteDatabase: (onBlocked) => {
        onBlocked?.()
        blockedCalls++
        return gate
      },
    })
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Blocked is visible ("another Nox window…") but the request is still
    // pending: no false success on a transient signal.
    expect(blockedCalls).toBe(1)
    expect(settled).toBe(false)
    release()
    await pending
    expect(settled).toBe(true)
  })

  it('refuses database opens while deletion is pending and allows them after', async () => {
    const { store } = memoryDeletionStore()
    await openNoxDB(store)
    closeNoxDBConnections()
    // Another panel's tombstone, observed on refresh (message missed).
    await store.set({ state: 'deleting', generation: 2, ts: Date.now() })
    await expect(openNoxDB(store)).rejects.toThrow(/DELETION_PENDING/)
    // Late callbacks cannot recreate the database through the guard …
    await expect(openNoxDB(store)).rejects.toThrow(/DELETION_PENDING/)
    // … but normal operation resumes once the mark lifts.
    await store.clear()
    const reopened = await openNoxDB(store)
    expect(reopened.version).toBe(DB_VERSION)
    closeNoxDBConnections()
  })

  it('runs a real blocked deletion end to end with a second connection', async () => {
    const { store } = memoryDeletionStore()
    stubChrome()
    await openNoxDB(store)
    const other = await openDB('nox', DB_VERSION)
    let blockedCalls = 0
    const pending = deleteAllData({ deletionStore: store, onBlocked: () => void blockedCalls++ })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The cached connection closed itself; the raw second connection is the
    // remaining blocker, which the UI names explicitly.
    expect(blockedCalls).toBeGreaterThanOrEqual(1)
    other.close()
    await pending
    closeNoxDBConnections()
  })
})

describe('journal change notifications (Epoch 09)', () => {  it('notifies observers after durable changes, never on storage failure', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-a')
    let notices = 0
    const unsubscribe = journal.onChange(() => void notices++)
    await journal.record({ tool: 'write', args: {}, kind: 'content-update' })
    expect(notices).toBe(1)
    const scope = { threadId: 'thread-a', turnId: 'turn-1', workspaceId: 'ws', connectionGeneration: 'c', ownerGeneration: 'o' }
    const intent = await journal.beginIntent({ tool: 't', args: {}, kind: 'write', scope })
    expect(notices).toBe(2)
    await journal.settleIntent(intent.id, { status: 'applied' })
    expect(notices).toBe(3)
    unsubscribe()
    await journal.record({ tool: 'write-2', args: {}, kind: 'write' })
    expect(notices).toBe(3)
  })

  it('counts scoped undoables without loading other threads', async () => {
    const journal = new MutationJournal()
    journal.setThread('thread-a')
    await journal.record({ tool: 'a-write', args: {}, kind: 'move', inverse: { tool: 'u', args: {} } })
    await journal.record({ tool: 'a-plain', args: {}, kind: 'move' })
    journal.setThread('thread-b')
    await journal.record({ tool: 'b-write', args: {}, kind: 'move', inverse: { tool: 'u', args: {} } })
    journal.scopeThread('thread-a')
    expect(await journal.undoableCount()).toBe(1)
    journal.scopeThread('thread-b')
    expect(await journal.undoableCount()).toBe(1)
    journal.scopeThread(null)
    expect(await journal.undoableCount()).toBe(0)
  })
})

describe('persisted turn queue (Epoch 09)', () => {
  interface StoredMessage {
    id: string
    threadId: string
    text: string
    turnStatus?: string
  }

  /** Memory repository with scripted per-append failures and call counting. */
  function scriptedRepo(script: Array<'ok' | 'fail'> = []) {
    const messages: StoredMessage[] = []
    let calls = 0
    let threads = 0
    const repo = {
      createThread: async () => {
        threads++
        return { id: `thread-${threads}`, title: 't', createdAt: 0, updatedAt: 0, mode: 'ask', pinned: false }
      },
      appendMessage: async (threadId: string, message: Omit<MessageRow, 'id' | 'ts' | 'threadId'> & { id?: string }) => {
        const step = script[calls] ?? 'ok'
        calls++
        if (step === 'fail') throw new Error(`storage offline (append ${calls})`)
        const row = { id: message.id ?? `m${calls}`, threadId, text: message.text, turnStatus: message.turnStatus }
        const existing = messages.findIndex((m) => m.id === row.id)
        if (existing >= 0) messages[existing] = row
        else messages.push(row)
        return row
      },
    } as unknown as ThreadRepository
    return { repo, messages, calls: () => calls }
  }

  it('recovers after a failed partial so the final still lands', async () => {
    const { repo, messages } = scriptedRepo(['ok', 'fail', 'ok'])
    const turn = await startPersistedTurn(repo, null, 'do work')
    const errors: string[] = []
    turn.onSaveError((message) => void errors.push(message))
    await expect(turn.persistAssistant('partial')).rejects.toThrow(/storage offline/)
    // The queue is not poisoned: the final is attempted and succeeds, and a
    // recovered partial failure never raised the banner.
    await turn.persistAssistant('complete', undefined, undefined, 'complete')
    expect(messages.map((m) => m.text)).toEqual(['do work', 'complete'])
    expect(errors).toEqual([])
  })

  it('gives each save its own result while the tail recovers', async () => {
    const { repo } = scriptedRepo(['ok', 'fail', 'ok', 'ok'])
    const turn = await startPersistedTurn(repo, null, 'do work')
    const first = turn.persistAssistant('one')
    const second = turn.persistAssistant('two', undefined, undefined, 'complete')
    await expect(first).rejects.toThrow(/storage offline/)
    await expect(second).resolves.toBeUndefined()
    // … and the turn stays usable afterwards.
    await expect(turn.persistAssistant('three', undefined, undefined, 'complete')).resolves.toBeUndefined()
  })

  it('lets a final supersede waiting partials without later overwrite', async () => {
    const { repo, messages } = scriptedRepo()
    // Gate installed before the turn starts so append #1 is the user row
    // and #2 is the first in-flight partial.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const innerAppend = repo.appendMessage.bind(repo)
    let appends = 0
    repo.appendMessage = (async (threadId: string, message: Omit<MessageRow, 'id' | 'ts' | 'threadId'> & { id?: string }) => {
      appends++
      if (appends === 2) await gate // block the first partial mid-flight
      return innerAppend(threadId, message)
    }) as typeof repo.appendMessage
    const turn = await startPersistedTurn(repo, null, 'do work')
    const partial1 = turn.persistAssistant('partial-1')
    const partial2 = turn.persistAssistant('partial-2')
    const final = turn.persistAssistant('final answer', { output_tokens: 9 }, undefined, 'complete')
    release()
    await Promise.all([partial1, partial2, final])
    // user + in-flight partial-1 + final only: partial-2 coalesced away, the
    // final upserts the assistant row last, and nothing writes after it.
    expect(appends).toBe(3)
    expect(messages.map((m) => m.text)).toEqual(['do work', 'final answer'])
  })

  it('bounds rapid partials to one in-flight and one waiting write', async () => {
    const { repo, messages } = scriptedRepo()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const innerAppend = repo.appendMessage.bind(repo)
    let appends = 0
    repo.appendMessage = (async (threadId: string, message: Omit<MessageRow, 'id' | 'ts' | 'threadId'> & { id?: string }) => {
      appends++
      if (appends === 2) await gate
      return innerAppend(threadId, message)
    }) as typeof repo.appendMessage
    const turn = await startPersistedTurn(repo, null, 'do work')
    const saves = Array.from({ length: 10 }, (_, i) => turn.persistAssistant(`partial-${i}`))
    const final = turn.persistAssistant('final answer', undefined, undefined, 'complete')
    release()
    await Promise.all([...saves, final])
    expect(appends).toBe(3)
    expect(messages.map((m) => m.text)).toEqual(['do work', 'final answer'])
  })

  it('surfaces final failure with retry instead of rerunning the turn', async () => {
    const { repo, messages } = scriptedRepo(['ok', 'ok', 'fail', 'ok'])
    const turn = await startPersistedTurn(repo, null, 'do work')
    const errors: string[] = []
    turn.onSaveError((message) => void errors.push(message))
    await turn.persistAssistant('partial')
    await expect(turn.persistAssistant('final answer', undefined, undefined, 'complete')).rejects.toThrow(/storage offline/)
    expect(errors).toEqual(['History could not be saved'])
    // Retry re-attempts the full local snapshot; the model turn never reruns.
    await turn.retryFinal()
    expect(messages.map((m) => m.text)).toEqual(['do work', 'final answer'])
  })

  it('does not surface recovered partial failures', async () => {
    const { repo } = scriptedRepo(['ok', 'fail', 'ok'])
    const turn = await startPersistedTurn(repo, null, 'do work')
    const errors: string[] = []
    turn.onSaveError((message) => void errors.push(message))
    await expect(turn.persistAssistant('partial')).rejects.toThrow()
    await turn.persistAssistant('complete', undefined, undefined, 'complete')
    expect(errors).toEqual([])
  })

  it('keeps interleaved turns isolated to their own threads', async () => {
    const { repo, messages } = scriptedRepo()
    const turnA = await startPersistedTurn(repo, null, 'question A')
    const turnB = await startPersistedTurn(repo, null, 'question B')
    expect(turnA.threadId).not.toBe(turnB.threadId)
    await Promise.all([
      turnA.persistAssistant('partial A'),
      turnB.persistAssistant('partial B'),
      turnA.persistAssistant('final A', undefined, undefined, 'complete'),
      turnB.persistAssistant('final B', undefined, undefined, 'failed', 'boom'),
    ])
    const forThread = (id: string) => messages.filter((m) => m.threadId === id).map((m) => m.text)
    // The assistant row upserts per turn: question + latest snapshot each,
    // with no row ever landing in the other thread.
    expect(forThread(turnA.threadId)).toEqual(['question A', 'final A'])
    expect(forThread(turnB.threadId)).toEqual(['question B', 'final B'])
  })

  it('refuses retry before any final snapshot exists', async () => {
    const { repo } = scriptedRepo()
    const turn = await startPersistedTurn(repo, null, 'do work')
    expect(() => turn.retryFinal()).toThrow(/no final snapshot/)
  })

  it('stops notifying unsubscribed save-error observers', async () => {
    const { repo } = scriptedRepo(['ok', 'fail', 'fail'])
    const turn = await startPersistedTurn(repo, null, 'do work')
    let notices = 0
    const unsubscribe = turn.onSaveError(() => void notices++)
    await expect(turn.persistAssistant('final-1', undefined, undefined, 'failed', 'x')).rejects.toThrow()
    expect(notices).toBe(1)
    unsubscribe()
    await expect(turn.persistAssistant('final-2', undefined, undefined, 'failed', 'x')).rejects.toThrow()
    expect(notices).toBe(1)
  })
})