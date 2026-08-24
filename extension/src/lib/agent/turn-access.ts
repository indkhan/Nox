import type { Mode } from '../writes/approvals'

export function createTurnAccessState() {
  let currentMode: Mode = 'ask'
  const pages = new Set<string>()

  return {
    begin(mode: Mode, ids: string[]) {
      currentMode = mode
      pages.clear()
      for (const id of ids) pages.add(id)
    },
    mode: (): Mode => currentMode,
    contextPages: () => new Set(pages),
  }
}
