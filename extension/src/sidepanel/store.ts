import { create } from 'zustand'
import type { CurrentPage } from '../shared/notion-page'
import { isCurrentPageChangedMessage, isExpectedBackgroundSender, isValidCurrentPage } from '../shared/messages'
import type { Mode } from './Composer'
import type { ApprovalDisplay } from '../lib/writes/approvals'
import type { PendingWorkspacePlan } from '../lib/architect/plan-engine'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface NotionIdentityView {
  workspaceName?: string
  userName?: string
  email?: string
}

interface NoxState {
  currentPage: CurrentPage | null
  setCurrentPage: (page: CurrentPage | null) => void

  connectionStatus: ConnectionStatus
  identity: NotionIdentityView | null
  limitations: Array<{ tool: string; reason: string }>
  connectionError: string | null
  setConnection: (update: Partial<Pick<NoxState, 'connectionStatus' | 'identity' | 'limitations' | 'connectionError'>>) => void

  codexStatus: ConnectionStatus | 'unknown'
  codexVersion: string | null
  codexModelCount: number
  codexHint: string | null
  setCodex: (update: Partial<Pick<NoxState, 'codexStatus' | 'codexVersion' | 'codexModelCount' | 'codexHint'>>) => void

  mode: Mode
  setMode: (mode: Mode) => void

  pendingApprovals: ApprovalDisplay[]
  addApproval: (a: ApprovalDisplay) => void
  removeApproval: (id: number) => void

  pendingPlans: PendingWorkspacePlan[]
  addPlan: (plan: PendingWorkspacePlan) => void
  removePlan: (id: string) => void

  threadTitle: string
  setThreadTitle: (title: string) => void

  /** Bumped by the header "new chat" button; ChatPanel watches it to reset the view. */
  newChatTick: number
  requestNewChat: () => void

  openThreadRequest: { id: string; nonce: number } | null
  requestOpenThread: (id: string) => void

  agentBusy: boolean
  setAgentBusy: (busy: boolean) => void

  activeThreadId: string | null
  setActiveThreadId: (id: string | null) => void

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}

export const useNoxStore = create<NoxState>((set) => ({
  currentPage: null,
  setCurrentPage: (page) => set({ currentPage: page }),

  connectionStatus: 'disconnected',
  identity: null,
  limitations: [],
  connectionError: null,
  setConnection: (update) => set(update),

  codexStatus: 'unknown',
  codexVersion: null,
  codexModelCount: 0,
  codexHint: null,
  setCodex: (update) => set(update),

  mode: 'auto',
  setMode: (mode) => set({ mode }),

  pendingApprovals: [],
  addApproval: (a) => set((s) => ({ pendingApprovals: [...s.pendingApprovals, a] })),
  removeApproval: (id) => set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.id !== id) })),

  pendingPlans: [],
  addPlan: (plan) => set((s) => ({ pendingPlans: [...s.pendingPlans, plan] })),
  removePlan: (id) => set((s) => ({ pendingPlans: s.pendingPlans.filter((plan) => plan.id !== id) })),

  threadTitle: 'New chat',
  setThreadTitle: (threadTitle) => set({ threadTitle }),

  newChatTick: 0,
  requestNewChat: () => set((s) => ({ newChatTick: s.newChatTick + 1 })),

  openThreadRequest: null,
  requestOpenThread: (id) => set((s) => ({ openThreadRequest: { id, nonce: (s.openThreadRequest?.nonce ?? 0) + 1 } })),

  agentBusy: false,
  setAgentBusy: (agentBusy) => set({ agentBusy }),

  activeThreadId: null,
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))

// Panel accepts current-page updates only from the expected extension
// background context and re-validates the full payload (Epoch 13 / L3).
// Unknown discriminants are rejected; title/icon remain untrusted labels.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isExpectedBackgroundSender(sender, chrome.runtime.id)) return
  if (isCurrentPageChangedMessage(message)) {
    useNoxStore.getState().setCurrentPage(message.page)
  }
})

export async function hydrateCurrentPage(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'nox/get-current-page' })
  if (response && typeof response === 'object' && 'page' in response) {
    const page = (response as { page: unknown }).page
    if (isValidCurrentPage(page)) {
      useNoxStore.getState().setCurrentPage(page)
    }
  }
}
