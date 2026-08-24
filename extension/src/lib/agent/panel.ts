import { bridge, codex } from '../codex/panel'
import { notion } from '../notion/panel'
import { AgentLoop } from './loop'
import { ToolExecutor } from './executor'
import { buildDeveloperInstructions } from './instructions'
import { toDynamicTools } from './dynamic-tools'
import { WriteGate } from '../writes/gate'
import { MutationJournal, idbJournalStore } from '../writes/journal'
import { openNoxDB } from '../history/schema'
import type { Mode } from '../writes/approvals'
import type { MentionRef } from '../../shared/notion-page'
import { createTurnAccessState } from './turn-access'

// The store dynamically imports this module, so a static import back is cycle-free.
import { useNoxStore } from '../../sidepanel/store'

let historyThreadId: string | null = null

export function setAgentHistoryThread(threadId: string | null): void {
  historyThreadId = threadId
}

const turnAccess = createTurnAccessState()
export function prepareAgentTurn(mode: Mode, pageIds: string[]): void {
  turnAccess.begin(mode, pageIds)
}

export const writeGate = new WriteGate({
  callTool: (name, args, signal) => notion.scheduleCallTool(name, args, signal),
  fetchPageMarkdown: async (pageId, signal) => {
    const result = await notion.scheduleCallTool('notion-fetch', { id: pageId }, signal)
    return result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  },
  getMode: () => turnAccess.mode(),
  getContextSet: () => {
    const page = useNoxStore.getState().currentPage
    const ids = turnAccess.contextPages()
    if (page) ids.add(page.pageId)
    return ids
  },
  journal: new MutationJournal(idbJournalStore(openNoxDB)),
  onApproval: (approval) => useNoxStore.getState().addApproval(approval),
})

/** Production assembly: real Notion facade + real Codex client behind the gate. */
export const agentLoop = new AgentLoop({
  bridge,
  codex,
  executor: new ToolExecutor({
    callTool: async (name, args, signal, provenance) => {
      const result = (await writeGate.handle({ rid: 0, tool: name, args, namespace: null, signal, provenance })) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result?.isError && Array.isArray(result.content)) {
        // Guard/refusal outcomes flow back to the model as data (MVP §6).
        throw Object.assign(new Error(result.content.map((c) => c.text).join('\n')), { handledByGate: true })
      }
      return { content: result.content ?? [] }
    },
    assertToolAllowed: (name) => {
      const verdict = notion.capabilities.can(name)
      if (!verdict.allowed) throw new Error(`"${name}" ${verdict.reason ?? 'is unavailable'}`)
    },
  }),
  beginTurn: () => {
    writeGate.journal.setThread(historyThreadId ?? 'unscoped')
    writeGate.beginTurn()
  },
  cancelPending: () => {
    writeGate.approvals.rejectAllPending()
    for (const approval of useNoxStore.getState().pendingApprovals) useNoxStore.getState().removeApproval(approval.id)
  },
  getDynamicTools: async () => toDynamicTools(await notion.listTools(), notion.capabilities),
  developerInstructions: buildDeveloperInstructions({
    userName: notion.identity?.userName,
    workspaceName: notion.identity?.workspaceName,
  }),
})

export interface PageWithContext extends MentionRef {
  markdown?: string
}

/** Fetches a mentioned page's content for context injection (best effort). */
export async function fetchMentionContext(page: MentionRef): Promise<PageWithContext> {
  try {
    const result = await notion.scheduleCallTool('notion-fetch', { id: page.pageId })
    const markdown = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    await writeGate.rememberPageRead(page.pageId, markdown)
    return {
      ...page,
      markdown: markdown.slice(0, 8000),
    }
  } catch {
    return page // content is optional context; never block the turn on it
  }
}

