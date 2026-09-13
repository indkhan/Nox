import type { Mode, SmallEditGrant } from '../writes/approvals'
import { normalizeId } from '../../shared/notion-page'

/** Cap on unplanned Auto effects per turn before a workspace plan is required. */
export const MAX_UNPLANNED_EFFECTS = 5

export interface SmallEditGrantInput {
  allowed: boolean
  pages: string[]
}

export function createTurnAccessState() {
  let currentMode: Mode = 'ask'
  const pages = new Set<string>()
  const attachmentIds = new Set<string>()
  let grant: SmallEditGrant = { allowed: false, pages: [] }
  let unplannedEffects = 0

  return {
    begin(mode: Mode, ids: string[], attachments: string[] = [], nextGrant?: SmallEditGrantInput) {
      currentMode = mode
      pages.clear()
      for (const id of ids) pages.add(id)
      attachmentIds.clear()
      for (const id of attachments) attachmentIds.add(id)
      // The small-edit grant is captured at Send, normalized once, bound to
      // this turn only, and available only in Auto — never inferred, never
      // persisted, and never set by model tools.
      grant = nextGrant?.allowed === true && mode === 'auto'
        ? { allowed: true, pages: nextGrant.pages.map((id) => normalizeId(id) ?? id) }
        : { allowed: false, pages: [] }
      unplannedEffects = 0
    },
    mode: (): Mode => currentMode,
    contextPages: () => new Set(pages),
    attachments: () => new Set(attachmentIds),
    smallEditGrant: (): SmallEditGrant => ({ allowed: grant.allowed, pages: [...grant.pages] }),
    /**
     * Reserve budget for unplanned Auto effects, counted by objects — a bulk
     * call counts every object, never one. Refuses past the cap so the gate
     * can demand a workspace plan before dispatch. Counts are never released,
     * not even after ambiguous dispatches.
     */
    recordUnplannedEffects: (count: number): boolean => {
      if (unplannedEffects + count > MAX_UNPLANNED_EFFECTS) return false
      unplannedEffects += count
      return true
    },
  }
}
