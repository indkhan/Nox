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

/**
 * Local selection bounds (Epoch 10 / M7). These are product limits for the
 * composer draft, not assertions about any provider maximum: the verified
 * provider contract may require less, and upload stays disabled until that
 * contract exists.
 */
export const MAX_ATTACHMENT_FILES = 10
export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024

/**
 * An unsent draft: the `File` bytes live only in composer memory. Selecting a
 * file writes nothing to IndexedDB, so removing its chip (or starting a new
 * chat, or refreshing — unsent files are intentionally discarded) leaves no
 * row behind. The id is minted once at selection and stays stable while the
 * draft is edited.
 */
export interface DraftAttachment extends LocalAttachment {
  file: File
}

/** Mint stable draft identities for freshly picked files. Pure: no IO. */
export function createDraftAttachments(files: File[]): DraftAttachment[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    file,
  }))
}

export interface DraftRejection {
  name: string
  reason: string
}

/**
 * Enforce the selection bounds using `File.size` only — aggregate size is
 * checked before any bytes are read, and every rejected file is named with
 * its reason instead of being silently filtered.
 */
export function validateDraftSelection(
  existing: Array<{ size: number }>,
  files: File[],
): { accepted: File[]; rejected: DraftRejection[] } {
  const accepted: File[] = []
  const rejected: DraftRejection[] = []
  let count = existing.length
  let total = existing.reduce((sum, item) => sum + item.size, 0)
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
      rejected.push({ name: file.name, reason: `"${file.name}" exceeds the 20 MiB per-file limit and was not added.` })
      continue
    }
    if (count + 1 > MAX_ATTACHMENT_FILES) {
      rejected.push({ name: file.name, reason: `"${file.name}" was not added: at most 10 files may be attached to one turn.` })
      continue
    }
    if (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      rejected.push({ name: file.name, reason: `"${file.name}" was not added: attachments total at most 25 MiB per turn.` })
      continue
    }
    count++
    total += file.size
    accepted.push(file)
  }
  return { accepted, rejected }
}
