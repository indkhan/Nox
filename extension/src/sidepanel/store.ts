import { create } from 'zustand'
import type { CurrentPage } from '../shared/notion-page'
import { isNoxMessage } from '../shared/messages'
import type { Mode } from './Composer'

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

  pendingApprovals: Array<{ id: number; tool: string; summary: string; payloadJson: string; reasons: string[]; targetUrl?: string; reversibility: string }>
  addApproval: (a: { id: number; tool: string; summary: string; payloadJson: string; reasons: string[]; targetUrl?: string; reversibility: string }) => void
  removeApproval: (id: number) => void

  threadTitle: string
  setThreadTitle: (title: string) => void

  /** Bumped by the header "new chat" button; ChatPanel watches it to reset the view. */
  newChatTick: number
  requestNewChat: () => void

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

  mode: 'ask',
  setMode: (mode) => {
    set({ mode })
    // Keep the write gate's escalation mode in sync (E6).
    void import('../lib/agent/panel').then(({ setAgentMode }) => setAgentMode(mode))
  },

  pendingApprovals: [],
  addApproval: (a) => set((s) => ({ pendingApprovals: [...s.pendingApprovals, a] })),
  removeApproval: (id) => set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.id !== id) })),

  threadTitle: 'New chat',
  setThreadTitle: (threadTitle) => set({ threadTitle }),

  newChatTick: 0,
  requestNewChat: () => set((s) => ({ newChatTick: s.newChatTick + 1 })),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))

chrome.runtime.onMessage.addListener((message) => {
  if (isNoxMessage(message) && message.type === 'nox/current-page-changed') {
    useNoxStore.getState().setCurrentPage(message.page)
  }
})

export async function hydrateCurrentPage(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'nox/get-current-page' })
  if (response && typeof response === 'object' && 'page' in response) {
    useNoxStore.getState().setCurrentPage(
      (response as { page: CurrentPage | null }).page,
    )
  }
}
