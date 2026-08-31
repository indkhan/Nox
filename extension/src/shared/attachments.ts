export interface LocalAttachment {
  id: string
  name: string
  mimeType: string
  size: number
}

export interface StoredAttachment extends LocalAttachment {
  threadId?: string
  blob: Blob
  createdAt: number
}

export interface AttachmentRow extends Omit<StoredAttachment, 'blob'> {
  bytes: ArrayBuffer
}
