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
import { UPLOAD_FILE_TOOL_NAME, UPLOAD_TICKET_TOOL_NAME, uploadUnsupportedMessage } from '../attachments/upload-tool'
import { normalizePageFetch } from '../notion/page-content'
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
export function prepareAgentTurn(mode: Mode, pageIds: string[], attachmentIds: string[] = [], grant?: { allowed: boolean; pages: string[] }): void {
  turnAccess.begin(mode, pageIds, attachmentIds, grant)
}

/**
 * Expire per-turn grants without starting a turn (Epoch 11): reconnect and
 * sign-out drop stale Auto/upload approvals so the next Send re-captures
 * explicit consent.
 */
export function expireAgentGrants(): void {
  turnAccess.invalidate()
}

export const writeGate = new WriteGate({
  callTool: (name, args, signal) => notion.scheduleCallTool(name, args, signal),
  fetchPageMarkdown: async (pageId, signal) => {
    const result = await notion.scheduleCallTool('notion-fetch', { id: pageId }, signal)
    // A tool-declared failure is never page content: surface it so the guard
    // refuses instead of snapshotting error text as a baseline.
    if (result.isError) throw new Error(result.content.map((c) => c.text ?? '').join('\n') || 'the page read failed')
    return result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  },
  getMode: () => turnAccess.mode(),
  getContextSet: () => turnAccess.contextPages(),
  journal: new MutationJournal(idbJournalStore(openNoxDB)),
  onApproval: (approval) => useNoxStore.getState().addApproval(approval),
  authorizeStructuralChange: (effect, scope) => planEngine.authorize(effect, scope),
  checkPlanReservation: (reservationId, scope) => planEngine.checkReservation(reservationId, scope),
  consumePlanReservation: (reservationId, resultText) => void planEngine.consume(reservationId, resultText),
  ownership: {
    isOwner: () => getWindowRole() === 'owner',
    getOwnerGeneration: () => getOwnerGeneration(),
    getConnectionGeneration: () => notion.connectionGeneration,
  },
  getWorkspaceId: () => notion.identity?.workspaceId ?? null,
  getSmallEditGrant: () => turnAccess.smallEditGrant(),
  recordUnplannedEffects: (count) => turnAccess.recordUnplannedEffects(count),
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
        // Explicit human approval is required in both Ask and Auto modes:
        // a proposed plan never authorizes itself.
        const decision = await planEngine.request(args, {
          workspaceId: notion.identity?.workspaceId ?? null,
          connectionGeneration: notion.connectionGeneration,
          threadId: historyThreadId,
          turnId: writeGate.journal.captureScope().turnId,
        })
        return { content: [{ type: 'text', text: decision === 'approved' ? 'PLAN_APPROVED: execute only the listed operations.' : 'PLAN_REJECTED: no changes were authorized.' }] }
      }
      if (name === UPLOAD_FILE_TOOL_NAME) {
        // Selected-file identity first: only an id chosen in this turn that
        // resolves to a stored row with intact metadata may proceed — a model
        // can never name an arbitrary attachment in history. Every refusal
        // below happens before ticket creation, transport, and journaling.
        const id = typeof args.attachment_id === 'string' ? args.attachment_id : ''
        if (!turnAccess.attachments().has(id)) throw new Error('ATTACHMENT_UNAVAILABLE: select this file in the current turn first.')
        const attachment = await attachments.get(id)
        if (!attachment) throw new Error('ATTACHMENT_UNAVAILABLE: local file was not found.')
        if (attachment.blob.size !== attachment.size) {
          throw new Error('ATTACHMENT_CHANGED: the stored file no longer matches its recorded size — reselect it before retrying.')
        }
        if (attachment.threadId != null && historyThreadId != null && attachment.threadId !== historyThreadId) {
          throw new Error('ATTACHMENT_UNAVAILABLE: this file belongs to a different conversation.')
        }
        // Capability recheck at execution: a stale advertised tool fails safe.
        const ticketAccess = notion.capabilities.can(UPLOAD_TICKET_TOOL_NAME)
        if (!ticketAccess.allowed) {
          throw new Error(`UPLOAD_UNAVAILABLE: the Notion connection does not support file upload (${ticketAccess.reason ?? ticketAccess.state}). No bytes were sent.`)
        }
        // Epoch 08: no verified MCP ticket contract exists, so the workflow
        // stays disabled everywhere. The owner/serial effect path, exact
        // consent, and durable journal in runEffectExclusive remain the
        // boundary the enabled flow must use; nothing reaches them yet.
        throw new Error(uploadUnsupportedMessage())
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
    planEngine.invalidateApproval()
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
  /** Provider completeness of the read behind `markdown`, when established. */
  remoteStatus?: 'complete' | 'partial' | 'unavailable'
}

/** Fetches a mentioned page's content for context injection (best effort). */
export async function fetchMentionContext(page: MentionRef, signal?: AbortSignal): Promise<PageWithContext> {
  try {
    const result = await notion.scheduleCallTool('notion-fetch', { id: page.pageId }, signal)
    if (result.isError) throw new Error(result.content.map(c => c.text ?? '').join('\n'))
    signal?.throwIfAborted()
    // Judge completeness from the full envelope (never error text as
    // content); partial reads stay available for analysis but establish no
    // replacement baseline. Unrecognized/unavailable payloads are reported
    // as unavailable rather than fed to the model as page content.
    await writeGate.rememberNormalizedRead(page.pageId, result)
    let remoteStatus: PageWithContext['remoteStatus']
    try {
      remoteStatus = normalizePageFetch(page.pageId, result).status
    } catch (error) {
      return { ...page, error: error instanceof Error ? error.message : String(error) }
    }
    const markdown = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    return {
      ...page,
      markdown,
      remoteStatus,
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { ...page, error: error instanceof Error ? error.message : String(error) } // content is optional context; never block the turn on it
  }
}

