import type { IDBPDatabase } from 'idb'
import type { AttachmentRow, LocalAttachment, StoredAttachment } from '../../shared/attachments'

export function attachmentRepository(db: () => Promise<IDBPDatabase>) {
  return {
    async save(file: File, threadId?: string): Promise<LocalAttachment> {
      const row: AttachmentRow = {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        bytes: await readFile(file),
        createdAt: Date.now(),
        ...(threadId ? { threadId } : {}),
      }
      await (await db()).put('attachments', row)
      return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size }
    },
    async get(id: string): Promise<StoredAttachment | undefined> {
      const row = await (await db()).get('attachments', id) as AttachmentRow | undefined
      return row ? { ...row, blob: new Blob([row.bytes], { type: row.mimeType }) } : undefined
    },
    async remove(id: string): Promise<void> {
      await (await db()).delete('attachments', id)
    },
    async removeForThread(threadId: string): Promise<void> {
      const conn = await db()
      const rows = await conn.getAllFromIndex('attachments', 'by_thread', threadId) as AttachmentRow[]
      const tx = conn.transaction('attachments', 'readwrite')
      await Promise.all([...rows.map((row) => tx.store.delete(row.id)), tx.done])
    },
  }
}

/**
 * Scoped cleanup for legacy orphan blobs (Epoch 10 / M7). Drafts selected
 * before ephemeral drafts existed were persisted with no thread linkage, so
 * thread deletion cannot attribute them to a conversation — and ownership is
 * never guessed by filename. This removes only provably unreferenced rows:
 * attachments with no `threadId` or whose thread no longer exists, excluding
 * any ids the caller still retains (e.g. the current turn's committed ids).
 * Rows owned by a live thread are always preserved. Returns the removed
 * count. No store or index migration is involved.
 */
export async function removeUnlinkedAttachments(
  db: () => Promise<IDBPDatabase>,
  retainedIds: Set<string> = new Set(),
): Promise<number> {
  const conn = await db()
  const [rows, threadKeys] = await Promise.all([
    conn.getAll('attachments') as Promise<AttachmentRow[]>,
    conn.getAllKeys('threads'),
  ])
  const live = new Set(threadKeys.map(String))
  const unlinked = rows.filter(
    (row) => !retainedIds.has(row.id) && (row.threadId == null || !live.has(row.threadId)),
  )
  if (unlinked.length === 0) return 0
  const tx = conn.transaction('attachments', 'readwrite')
  await Promise.all([...unlinked.map((row) => tx.store.delete(row.id)), tx.done])
  return unlinked.length
}

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment'))
    reader.readAsArrayBuffer(file)
  })
}
