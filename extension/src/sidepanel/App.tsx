import { useEffect, useState } from 'react'
import { hydrateCurrentPage, useNoxStore } from './store'
import { ChatPanel } from './ChatPanel'
import { SettingsModal } from './SettingsModal'
import { ViewerBanner } from './Onboarding'
import { applyTheme, loadSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'
import { claimWindowRole, type WindowRole } from '../lib/history/panel'
import { defaultDeletionStore, watchDeletionChanges } from '../lib/history/deletion'
import { installLogCapture, logInfo } from '../lib/log'
import { connectCodexAction, ensureCodexLifecycleSubscribed, reconnectCodexAction } from './codex-connect'
import { restoreNotionAction, watchCredentialSignout, wireNotionReauthHandler } from './notion-connect'
import { GearIcon, NoxMark, PlusCircleIcon } from './Icons'
import { ThreadMenu } from './ThreadMenu'
import { SetupScreen } from './SetupScreen'

export function App() {
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const codexVersion = useNoxStore((s) => s.codexVersion)
  const activeThreadId = useNoxStore((s) => s.activeThreadId)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const requestNewChat = useNoxStore((s) => s.requestNewChat)
  const settingsOpen = useNoxStore((s) => s.settingsOpen)
  const setSettingsOpen = useNoxStore((s) => s.setSettingsOpen)
  const [role, setRole] = useState<WindowRole>('pending')
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const agentBusy = useNoxStore((s) => s.agentBusy)

  function hydrateSettings() {
    setSettingsReady(false)
    setSettingsError(null)
    void (async () => {
      try {
        const settings = await loadSettings()
        applyTheme(settings.theme)
        agentLoop.setOverrides({ webSearchEnabled: settings.webSearchEnabled, model: settings.model, effort: settings.effort, serviceTier: settings.serviceTier })
        setSettingsReady(true)
        const stored = await chrome.storage.local.get('nox_thread_title')
        const title = stored['nox_thread_title']
        if (typeof title === 'string' && title) useNoxStore.getState().setThreadTitle(title)
      } catch (error) {
        setSettingsError(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  useEffect(() => {
    installLogCapture()
    logInfo('Panel opened')
    void hydrateCurrentPage()
    void claimWindowRole().then(setRole)
    hydrateSettings()
    wireNotionReauthHandler()
    const unwatchCredentials = watchCredentialSignout()
    // Deletion tombstone push for this already-open panel; the tombstone
    // itself (checked on every database open) covers missed events.
    const unwatchDeletion = watchDeletionChanges(defaultDeletionStore())
    return () => {
      unwatchCredentials()
      unwatchDeletion()
    }
  }, [])

  useEffect(() => {
    if (role === 'owner') {
      ensureCodexLifecycleSubscribed()
      void connectCodexAction()
      void restoreNotionAction()
    }
  }, [role])

  // Amber dot on the gear until both connections are up.
  const setupIncomplete = connectionStatus !== 'connected' || codexStatus !== 'connected'
  // After a connection loss, keep the interrupted conversation visible with a
  // reconnect banner instead of replacing it with a blank setup screen (L6).
  // Initial onboarding (never connected, no history) still uses SetupScreen.
  const hasPriorSession = codexVersion != null || activeThreadId != null || threadTitle !== 'New chat'
  const showSetupScreen = role === 'owner' && setupIncomplete && !hasPriorSession

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {role === 'viewer' && <ViewerBanner />}
      <header className="flex shrink-0 items-center gap-1.5 px-3 py-2" data-testid="panel-header">
        <NoxMark className="h-6 w-6 shrink-0 rounded-md" />
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight" data-testid="thread-title">
          {threadTitle}
        </h1>
        {role === 'owner' && <ThreadMenu disabled={agentBusy} />}
        <span className="flex-1" />
        {role === 'owner' && <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          disabled={agentBusy}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          title="Settings"
          data-testid="settings-button"
          className="relative rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GearIcon />
          {setupIncomplete && !settingsOpen && (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
          )}
        </button>}
        {role === 'owner' && <button
          onClick={() => requestNewChat()}
          disabled={agentBusy}
          aria-label="New chat"
          title="New chat"
          data-testid="new-chat"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusCircleIcon />
        </button>}
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {settingsError ? <section className="m-3 rounded-md border border-amber-700/60 bg-amber-950/30 p-3 text-sm" role="alert">
          <p>Could not load settings: {settingsError}</p>
          <button onClick={hydrateSettings} className="mt-2 rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">Retry</button>
        </section> : !settingsReady ? <p className="p-3 text-sm text-zinc-400" role="status">Loading settings…</p>
          : showSetupScreen
          ? <SetupScreen />
          : <>
              {role === 'owner' && setupIncomplete && hasPriorSession && <ReconnectBanner />}
              <ChatPanel readOnly={role !== 'owner'} />
            </>}
      </main>
      {settingsOpen && role === 'owner' && <SettingsModal />}
    </div>
  )
}

/**
 * Reconnect banner (Epoch 11 / L6): after a connection loss, the interrupted
 * conversation stays visible with explicit reconnect controls. Send stays
 * disabled in ChatPanel until both transports report connected.
 */
function ReconnectBanner() {
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const connectionError = useNoxStore((s) => s.connectionError)
  const codexHint = useNoxStore((s) => s.codexHint)
  const parts: string[] = []
  if (codexStatus !== 'connected') parts.push(`Codex ${codexStatus}`)
  if (connectionStatus !== 'connected') parts.push(`Notion ${connectionStatus}`)
  return (
    <section
      className="mx-3 mt-2 shrink-0 rounded-md border border-amber-700/60 bg-amber-950/30 p-2 text-xs text-amber-200"
      role="alert"
      data-testid="reconnect-banner"
    >
      <p>
        Connection lost ({parts.join(' · ') || 'reconnecting'}). Your visible history is preserved and no turn was
        replayed.
        {connectionError ? ` Notion: ${connectionError}` : ''}
        {codexHint ? ` Codex: ${codexHint}` : ''}
      </p>
      <span className="mt-1.5 flex gap-2">
        {codexStatus !== 'connected' && (
          <button
            onClick={() => void reconnectCodexAction()}
            disabled={codexStatus === 'connecting'}
            data-testid="banner-reconnect-codex"
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            {codexStatus === 'connecting' ? 'Reconnecting…' : 'Reconnect Codex'}
          </button>
        )}
        {connectionStatus !== 'connected' && (
          <button
            onClick={() => void restoreNotionAction()}
            disabled={connectionStatus === 'connecting'}
            data-testid="banner-reconnect-notion"
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            {connectionStatus === 'connecting' ? 'Reconnecting…' : 'Reconnect Notion'}
          </button>
        )}
      </span>
    </section>
  )
}
