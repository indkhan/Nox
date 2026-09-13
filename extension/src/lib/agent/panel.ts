import { bridge, codex } from '../codex/panel'
import { notion } from '../notion/panel'
import { AgentLoop } from './loop'
import { ToolExecutor } from './executor'
import { buildDeveloperInstructions } from './instructions'
import { toDynamicTools } from './dynamic-tools'
import { WriteGate } from '../writes/gate'
import { MutationJournal, idbJournalStore } from '../writes/journal'
import { openNoxDB } from '../history/schema'
import { getOwnerGeneration, getWindowRole } from '../history/panel'
import type { Mode } from '../writes/approvals'
import type { MentionRef } from '../../shared/notion-page'
import { createTurnAccessState } from './turn-access'
import { PlanEngine } from '../architect/plan-engine'
import { WORKSPACE_PLAN_TOOL_NAME } from '../architect/tool'
import { UPLOAD_FILE_TOOL_NAME, uploadLocalAttachment } from '../attachments/upload-tool'
import { attachmentRepository } from '../history/attachments'

// The store dynamically imports this module, so a static import back is cycle-free.
import { useNoxStore } from '../../sidepanel/store'

let historyThreadId: string | null = null

export function setAgentHistoryThread(threadId: string | null): void {
  historyThreadId = threadId
}

const turnAccess = createTurnAccessState()
export const planEngine = new PlanEngine(
  (plan) => useNoxStore.getState().addPlan(plan),
  (id) => useNoxStore.getState().removePlan(id),
)
const attachments = attachmentRepository(openNoxDB)
export function prepareAgentTurn(mode: Mode, pageIds: string[], attachmentIds: string[] = []): void {
  turnAccess.begin(mode, pageIds, attachmentIds)
}

export const writeGate = new WriteGate({
  callTool: (name, args, signal) => notion.scheduleCallTool(name, args, signal),
  fetchPageMarkdown: async (pageId, signal) => {
    const result = await notion.scheduleCallTool('notion-fetch', { id: pageId }, signal)
    return result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  },
  getMode: () => turnAccess.mode(),
  getContextSet: () => turnAccess.contextPages(),
  journal: new MutationJournal(idbJournalStore(openNoxDB)),
  onApproval: (approval) => useNoxStore.getState().addApproval(approval),
  authorizeStructuralChange: (name, args) => planEngine.authorize(name, args),
  ownership: {
    isOwner: () => getWindowRole() === 'owner',
    getOwnerGeneration: () => getOwnerGeneration(),
    getConnectionGeneration: () => notion.connectionGeneration,
  },
  getWorkspaceId: () => notion.identity?.workspaceId ?? null,
  assertToolAllowed: (tool) => {
    const verdict = notion.capabilities.can(tool)
    if (!verdict.allowed) throw new Error(`"${tool}" ${verdict.reason ?? 'is unavailable'}`)
  },
})

/** Production assembly: real Notion facade + real Codex client behind the gate. */
export const agentLoop = new AgentLoop({
  bridge,
  codex,
  executor: new ToolExecutor({
    callTool: async (name, args, signal, provenance) => {
      if (name === WORKSPACE_PLAN_TOOL_NAME) {
        const decision = await planEngine.request(args, turnAccess.mode() === 'auto')
        return { content: [{ type: 'text', text: decision === 'approved' ? 'PLAN_APPROVED: execute only the listed operations.' : 'PLAN_REJECTED: no changes were authorized.' }] }
      }
      if (name === UPLOAD_FILE_TOOL_NAME) {
        const id = typeof args.attachment_id === 'string' ? args.attachment_id : ''
        if (!turnAccess.attachments().has(id)) throw new Error('ATTACHMENT_UNAVAILABLE: select this file in the current turn first.')
        const attachment = await attachments.get(id)
        if (!attachment) throw new Error('ATTACHMENT_UNAVAILABLE: local file was not found.')
        // Upload ticket + bytes share the serial mutation boundary with
        // forward writes and undo, under the same owner lease, scope, and
        // durable intent. Intent args carry file metadata only, never bytes.
        const markdown = await writeGate.runEffectExclusive(() => uploadLocalAttachment(attachment, {
          createTicket: () => notion.scheduleCallTool('notion-create-file-upload', { filename: attachment.name, content_type: attachment.mimeType }, signal),
          fetchImpl: fetch,
          signal,
        }), signal, {
          tool: UPLOAD_FILE_TOOL_NAME,
          args: { attachment_id: id, name: attachment.name, size: attachment.size, content_type: attachment.mimeType },
          kind: 'upload',
        })
        return { content: [{ type: 'text', text: `UPLOAD_COMPLETE: insert this exact native block markdown into the requested page:\n${markdown}` }] }
      }
      const result = (await writeGate.handle({ rid: 0, tool: name, args, namespace: null, signal, provenance })) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result?.isError && Array.isArray(result.content)) {
        // Guard/refusal outcomes flow back to the model as data (MVP §6).
        throw new Error(result.content.map((c) => c.text).join('\n'))
      }
      return { content: result.content ?? [] }
    },
    assertToolAllowed: (name) => {
      const verdict = notion.capabilities.can(name)
      if (!verdict.allowed) throw new Error(`"${name}" ${verdict.reason ?? 'is unavailable'}`)
    },
  }),
  beginTurn: () => {
    // A null thread leaves the journal unscopable: mutations are refused
    // until persistence recovers, instead of journaling under 'unscoped'.
    writeGate.journal.setThread(historyThreadId)
    writeGate.beginTurn()
    planEngine.beginTurn(crypto.randomUUID())
  },
  endTurn: () => {
    writeGate.endTurn()
  },
  isUndoActive: () => writeGate.isUndoActive(),
  cancelPending: () => {
    writeGate.approvals.rejectAllPending()
    planEngine.rejectPending()
    for (const approval of useNoxStore.getState().pendingApprovals) useNoxStore.getState().removeApproval(approval.id)
  },
  getDynamicTools: async () => toDynamicTools(await notion.listTools(), notion.capabilities),
  developerInstructions: (settings) => buildDeveloperInstructions({
    webSearchEnabled: settings.webSearchEnabled,
    availableTools: settings.dynamicTools?.map(t => (t as { name: string }).name),
    userName: notion.identity?.userName,
    workspaceName: notion.identity?.workspaceName,
  }),
})

export interface PageWithContext extends MentionRef {
  markdown?: string
  error?: string
}

/** Fetches a mentioned page's content for context injection (best effort). */
export async function fetchMentionContext(page: MentionRef, signal?: AbortSignal): Promise<PageWithContext> {
  try {
    const result = await notion.scheduleCallTool('notion-fetch', { id: page.pageId }, signal)
    if (result.isError) throw new Error(result.content.map(c => c.text ?? '').join('\n'))
    signal?.throwIfAborted()
    const markdown = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    await writeGate.rememberPageRead(page.pageId, markdown)
    return {
      ...page,
      markdown,
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { ...page, error: error instanceof Error ? error.message : String(error) } // content is optional context; never block the turn on it
  }
}

