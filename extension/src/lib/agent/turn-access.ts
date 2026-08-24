import type { Mode } from '../writes/approvals'

export function createTurnAccessState() {
  let currentMode: Mode = 'ask'
  const pages = new Set<string>()
  const attachmentIds = new Set<string>()

  return {
    begin(mode: Mode, ids: string[], attachments: string[] = []) {
      currentMode = mode
      pages.clear()
      for (const id of ids) pages.add(id)
      attachmentIds.clear()
      for (const id of attachments) attachmentIds.add(id)
    },
    mode: (): Mode => currentMode,
    contextPages: () => new Set(pages),
    attachments: () => new Set(attachmentIds),
  }
}
