import type { IDBPDatabase } from 'idb'
import type { MessageRow, ThreadRow } from './schema'
import type { AttachmentRow } from '../../shared/attachments'
import { MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '../../shared/attachments'

/** Attachment bytes staged for atomic send: validated sizes, read before the transaction. */
export interface OwnedAttachmentInput {
  id: string
  name: string
  mimeType: string
  size: number
  bytes: ArrayBuffer
}

export interface ThreadRepository {
  createThread(title?: string): Promise<ThreadRow>
  /**
   * Atomically persist thread creation (when needed), the user message, and
   * the selected attachment bytes with thread ownership in one bounded
   * IndexedDB transaction (Epoch 10 / M7). The caller must read file bytes
   * and check aggregate sizes before invoking; bounds are re-enforced here
   * so an over-limit send fails with zero partial writes. Attachment rows
   * use `add`, never `put`: one row is never reused across threads.
   */
  beginTurn(threadId: string | null, userText: string, attachments?: OwnedAttachmentInput[]): Promise<{ threadId: string; userMessage: MessageRow }>
  getThread(id: string): Promise<ThreadRow | undefined>
  setCodexThreadId(id: string, codexThreadId: string): Promise<void>
  listThreads(): Promise<ThreadRow[]>
  searchThreads(query: string): Promise<Array<{ thread: ThreadRow; snippet: string }>>
  renameThread(id: string, title: string): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  deleteThread(id: string): Promise<void>
  appendMessage(threadId: string, message: Omit<MessageRow, 'id' | 'ts' | 'threadId'> & { id?: string }): Promise<MessageRow>
  getMessages(threadId: string): Promise<MessageRow[]>
  exportThread(threadId: string, format: 'json' | 'markdown'): Promise<string>
}

export function threadRepository(db: () => Promise<IDBPDatabase>): ThreadRepository {
  const uid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
  let lastMessageTimestamp = 0

  return {
    async createThread(title = 'New chat') {
      const conn = await db()
      const now = Date.now()
      const thread: ThreadRow = { id: uid(), title, createdAt: now, updatedAt: now, mode: 'ask', pinned: false }
      await conn.put('threads', thread)
      return thread
    },

    async beginTurn(threadId, userText, attachments = []) {
      if (attachments.length > MAX_ATTACHMENT_FILES) {
        throw new Error(`too many attachments: at most ${MAX_ATTACHMENT_FILES} files per turn`)
      }
      let total = 0
      for (const item of attachments) {
        if (item.size > MAX_ATTACHMENT_FILE_BYTES || item.bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES) {
          throw new Error(`"${item.name}" exceeds the 20 MiB per-file limit and was not sent.`)
        }
        if (item.bytes.byteLength !== item.size) {
          throw new Error(`"${item.name}" no longer matches its recorded size — reselect it before retrying.`)
        }
        total += item.size
      }
      if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new Error('attachments exceed the 25 MiB per-turn total and were not sent.')
      }
      // Data first, then one short atomic storage transaction — the
      // transaction is never held across file reads or network work.
      const conn = await db()
      const now = Date.now()
      lastMessageTimestamp = Math.max(now, lastMessageTimestamp + 1)
      const resolvedThreadId = threadId ?? uid()
      const userMessage: MessageRow = { id: uid(), threadId: resolvedThreadId, role: 'user', text: userText, ts: lastMessageTimestamp }
      const existing = threadId ? ((await conn.get('threads', threadId)) as ThreadRow | undefined) : undefined
      const thread: ThreadRow = existing ?? { id: resolvedThreadId, title: 'New chat', createdAt: now, updatedAt: now, mode: 'ask', pinned: false }
      const rows: AttachmentRow[] = attachments.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        bytes: item.bytes,
        threadId: resolvedThreadId,
        createdAt: now,
      }))
      const tx = conn.transaction(['threads', 'messages', 'attachments'], 'readwrite')
      await Promise.all([
        tx.objectStore('threads').put({ ...thread, updatedAt: now }),
        tx.objectStore('messages').put(userMessage),
        // `add` refuses a reused id instead of silently overwriting another
        // thread's row with new bytes.
        ...rows.map((row) => tx.objectStore('attachments').add(row)),
        tx.done,
      ])
      return { threadId: resolvedThreadId, userMessage }
    },

    async getThread(id) {
      return await (await db()).get('threads', id) as ThreadRow | undefined
    },

    async setCodexThreadId(id, codexThreadId) {
      const conn = await db()
      const thread = await conn.get('threads', id) as ThreadRow | undefined
      if (!thread) throw new Error(`thread ${id} not found`)
      await conn.put('threads', { ...thread, codexThreadId, updatedAt: Date.now() })
    },

    async listThreads() {
      const conn = await db()
      const all = (await conn.getAll('threads')) as ThreadRow[]
      return all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    },

    async searchThreads(query) {
      const conn = await db()
      const q = query.toLowerCase()
      const threads = (await conn.getAll('threads')) as ThreadRow[]
      const out: Array<{ thread: ThreadRow; snippet: string }> = []
      for (const thread of threads) {
        if (thread.title.toLowerCase().includes(q)) {
          out.push({ thread, snippet: thread.title })
          continue
        }
        // Full-text over messages, newest first; stop at first hit per thread.
        const messages = ((await conn.getAllFromIndex('messages', 'by_thread', thread.id)) as MessageRow[])
          .sort((a, b) => b.ts - a.ts)
        const hit = messages.find((m) => m.text.toLowerCase().includes(q))
        if (hit) out.push({ thread, snippet: hit.text.slice(0, 120) })
      }
      return out
    },

    async renameThread(id, title) {
      const conn = await db()
      const thread = (await conn.get('threads', id)) as ThreadRow | undefined
      if (!thread) throw new Error(`thread ${id} not found`)
      await conn.put('threads', { ...thread, title, updatedAt: Date.now() })
    },

    async setPinned(id, pinned) {
      const conn = await db()
      const thread = (await conn.get('threads', id)) as ThreadRow | undefined
      if (!thread) throw new Error(`thread ${id} not found`)
      await conn.put('threads', { ...thread, pinned })
    },

    async deleteThread(id) {
      const conn = await db()
      // Collect children first, then delete everything in one tx.
      const messages = (await conn.getAllFromIndex('messages', 'by_thread', id)) as MessageRow[]
      const journal = (await conn.getAllFromIndex('journal', 'by_thread', id)) as Array<{ id: string }>
      const tx = conn.transaction(['threads', 'messages', 'journal'], 'readwrite')
      await Promise.all([
        tx.objectStore('threads').delete(id),
        ...messages.map((m) => tx.objectStore('messages').delete(m.id)),
        ...journal.map((j) => tx.objectStore('journal').delete(j.id)),
        tx.done,
      ])
    },

    async appendMessage(threadId, message) {
      const conn = await db()
      lastMessageTimestamp = Math.max(Date.now(), lastMessageTimestamp + 1)
      const row: MessageRow = { ...message, id: message.id ?? uid(), threadId, ts: lastMessageTimestamp }
      await conn.put('messages', row)
      const thread = (await conn.get('threads', threadId)) as ThreadRow | undefined
      if (thread) await conn.put('threads', { ...thread, updatedAt: Date.now() })
      return row
    },

    async getMessages(threadId) {
      const conn = await db()
      const rows = (await conn.getAllFromIndex('messages', 'by_thread', threadId)) as MessageRow[]
      return rows.sort((a, b) => a.ts - b.ts)
    },

    async exportThread(threadId, format) {
      const conn = await db()
      const thread = (await conn.get('threads', threadId)) as ThreadRow | undefined
      if (!thread) throw new Error(`thread ${threadId} not found`)
      const messages = await this.getMessages(threadId)

      if (format === 'json') {
        return JSON.stringify({ exportedBy: 'Nox v0.1.0', thread, messages }, null, 2)
      }

      const lines = [`# ${thread.title}`, '', `_Exported by Nox · ${new Date().toISOString()}_`, '']
      for (const m of messages) {
        lines.push(m.role === 'user' ? `**You:** ${m.text}` : `**Nox:** ${m.text}`)
        lines.push('')
      }
      return lines.join('\n')
    },
  }
}
