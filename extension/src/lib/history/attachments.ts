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

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment'))
    reader.readAsArrayBuffer(file)
  })
}
