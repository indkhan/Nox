import type { MutationKind } from './classify'
import { detectRichPage, isSafePropertyType } from './classify'

export interface InversePlan {
  kind: 'execute-tool' | 'not-undoable'
  tool?: string
  args?: Record<string, unknown>
  reason?: string
}

export interface PreImage {
  kind: MutationKind
  pageId?: string
  markdown?: string
  richPage?: boolean
  properties?: Array<{ name: string; type: string; value: unknown }>
  moves?: Array<{ pageId: string; parentPageId: string }>
  config?: Record<string, unknown>
}

/**
 * Builds the inverse operation for a mutation given its pre-image (MVP §6.5).
 * Returns not-undoable with a plain-language reason when no safe inverse exists.
 */
export function buildInverse(toolName: string, _args: Record<string, unknown>, preImage: PreImage): InversePlan {
  switch (preImage.kind) {
    case 'move': {
      const moves = preImage.moves ?? []
      if (moves.length === 0) return { kind: 'not-undoable', reason: 'no parent was recorded' }
      return {
        kind: 'execute-tool',
        tool: 'notion-move-pages',
        args: {
          page_ids: moves.map((m) => m.pageId),
          new_parent: { type: 'page_id', page_id: moves[0].parentPageId },
        },
      }
    }

    case 'properties': {
      const restorable = (preImage.properties ?? []).filter((p) => isSafePropertyType(p.type))
      const skipped = (preImage.properties ?? []).length - restorable.length
      if (restorable.length === 0) {
        return {
          kind: 'not-undoable',
          reason: skipped > 0 ? 'only relation/rollup/formula properties changed — those cannot be restored' : 'nothing restorable was recorded',
        }
      }
      const properties: Record<string, unknown> = {}
      for (const p of restorable) properties[p.name] = p.value
      return {
        kind: 'execute-tool',
        tool: 'notion-update-page',
        args: { command: { type: 'update_properties', page_id: preImage.pageId, properties } },
      }
    }

    case 'content-replace':
    case 'content-update': {
      if (!preImage.markdown) return { kind: 'not-undoable', reason: 'the prior content was never captured' }
      if (preImage.richPage || detectRichPage(preImage.markdown)) {
        return {
          kind: 'not-undoable',
          reason: 'this page has structural blocks Notion cannot round-trip safely',
        }
      }
      return {
        kind: 'execute-tool',
        tool: 'notion-update-page',
        args: {
          data: { page_id: preImage.pageId },
          command: { type: 'replace_content', content: preImage.markdown },
        },
      }
    }

    case 'schema':
    case 'view':
      if (!preImage.config) return { kind: 'not-undoable', reason: 'the prior configuration was never captured' }
      return { kind: 'execute-tool', tool: toolName, args: preImage.config }

    default:
      // Creations and anything exotic:
      if (preImage.kind === 'create-page' || preImage.kind === 'duplicate' || preImage.kind === 'create-database' || preImage.kind === 'create-folder' || preImage.kind === 'create-comment') {
        return {
          kind: 'not-undoable',
          reason: 'Notion has no delete tool — creations stay. Open the page in Notion to remove it manually.',
        }
      }
      return { kind: 'not-undoable', reason: 'no safe inverse exists for this change' }
  }
}
