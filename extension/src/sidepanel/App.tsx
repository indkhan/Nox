import { useEffect, useState } from 'react'
import { hydrateCurrentPage, useNoxStore } from './store'
import { ChatPanel } from './ChatPanel'
import { SettingsModal } from './SettingsModal'
import { ViewerBanner } from './Onboarding'
import { applyTheme, loadSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'
import { claimWindowRole, type WindowRole } from '../lib/history/panel'
import { installLogCapture, logInfo } from '../lib/log'
import { connectCodexAction } from './codex-connect'
import { ChevronDownIcon, GearIcon, NoxMark, PlusCircleIcon } from './Icons'

export function App() {
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const requestNewChat = useNoxStore((s) => s.requestNewChat)
  const settingsOpen = useNoxStore((s) => s.settingsOpen)
  const setSettingsOpen = useNoxStore((s) => s.setSettingsOpen)
  const [role, setRole] = useState<WindowRole>('pending')

  useEffect(() => {
    installLogCapture()
    logInfo('Panel opened')
    void hydrateCurrentPage()
    void claimWindowRole().then(setRole)
    // Auto-connect codex so the model dropdown is usable without opening Settings.
    void connectCodexAction()
    void (async () => {
      const settings = await loadSettings()
      applyTheme(settings.theme)
      if (settings.model || settings.effort) {
        agentLoop.setOverrides({ model: settings.model, effort: settings.effort })
      }
      const stored = await chrome.storage.local.get('nox_thread_title')
      const title = stored['nox_thread_title']
      if (typeof title === 'string' && title) useNoxStore.getState().setThreadTitle(title)
    })()
  }, [])

  // Amber dot on the gear until both connections are up.
  const setupIncomplete = connectionStatus !== 'connected' || codexStatus !== 'connected'

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {role === 'viewer' && <ViewerBanner />}
      <header className="flex shrink-0 items-center gap-1.5 px-3 py-2" data-testid="panel-header">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
          <NoxMark className="h-4 w-4" />
        </span>
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight" data-testid="thread-title">
          {threadTitle}
        </h1>
        <button
          onClick={() => requestNewChat()}
          aria-label="Open chat menu"
          title="New chat"
          data-testid="header-menu"
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ChevronDownIcon />
        </button>
        <span className="flex-1" />
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          title="Settings"
          data-testid="settings-button"
          className="relative rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <GearIcon />
          {setupIncomplete && !settingsOpen && (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
          )}
        </button>
        <button
          onClick={() => requestNewChat()}
          aria-label="New chat"
          title="New chat"
          data-testid="new-chat"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <PlusCircleIcon />
        </button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ChatPanel readOnly={role !== 'owner'} />
      </main>
      {settingsOpen && <SettingsModal />}
    </div>
  )
}
