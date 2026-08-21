import { create } from 'zustand'
import type { CurrentPage } from '../shared/notion-page'
import { isNoxMessage } from '../shared/messages'

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
}

export const useNoxStore = create<NoxState>((set) => ({
  currentPage: null,
  setCurrentPage: (page) => set({ currentPage: page }),

  connectionStatus: 'disconnected',
  identity: null,
  limitations: [],
  connectionError: null,
  setConnection: (update) => set(update),
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
