import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNoxStore } from './store'
import { agentLoop, fetchCurrentPageContext, setAgentHistoryThread, writeGate } from '../lib/agent/panel'
import { ActivityTimeline, AssistantMarkdown, FollowUpActions } from './MessageParts'
import { applyActivityEvent, applyUndoResult, followUpsForActivity, type ActivityItem } from '../lib/agent/activity'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { ApprovalCards, UndoBar } from './ApprovalCards'
import { historyRepo } from '../lib/history/panel'
import { startPersistedTurn } from '../lib/history/turn'
import { logError, logInfo } from '../lib/log'
import { undoEntry } from '../lib/writes/undo'
import { restoreTurns } from '../lib/history/restore'

interface TurnView {
  activity: ActivityItem[]
  answer: string
  error: string | null
  pending: boolean
}

export function ChatPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [turns, setTurns] = useState<Array<{ id: string; userText: string; view: TurnView }>>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentThreadIdRef = useRef<string | null>(null)
  const lastUsageRef = useRef<Record<string, number> | null>(null)
  const historyRestoreCancelledRef = useRef(false)
  const historyGenerationRef = useRef(0)
  const currentPage = useNoxStore((s) => s.currentPage)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const setThreadTitle = useNoxStore((s) => s.setThreadTitle)
  const newChatTick = useNoxStore((s) => s.newChatTick)
  const openThreadRequest = useNoxStore((s) => s.openThreadRequest)
  const agentBusy = useNoxStore((s) => s.agentBusy)
  const setAgentBusy = useNoxStore((s) => s.setAgentBusy)
  const setActiveThreadId = useNoxStore((s) => s.setActiveThreadId)

  useEffect(() => {
    let cancelled = false
    writeGate.journal.scopeThread(null)
    void chrome.storage.local.get('nox_thread_id').then(async (stored) => {
      const threadId = stored['nox_thread_id']
      if (typeof threadId !== 'string' || !threadId) return
      const [messages, thread, journal] = await Promise.all([historyRepo.getMessages(threadId), historyRepo.getThread(threadId), writeGate.journal.newestForThread(threadId)])
      if (cancelled || historyRestoreCancelledRef.current) return
      const restored = restoreTurns(messages, journal).map((turn) => ({
        ...turn, view: { ...turn.view, activity: attachJournalEntries(turn.view.activity, journal) },
      }))
      currentThreadIdRef.current = threadId
      setActiveThreadId(threadId)
      setAgentHistoryThread(threadId)
      writeGate.journal.scopeThread(threadId)
      agentLoop.restoreThread(thread?.codexThreadId ?? null)
      if (cancelled || historyRestoreCancelledRef.current) return
      setTurns(restored)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [setActiveThreadId])

  useEffect(() => {
    if (!openThreadRequest || agentBusy) return
    const generation = ++historyGenerationRef.current
    const { id: threadId } = openThreadRequest
    void (async () => {
      const [messages, thread, journal] = await Promise.all([historyRepo.getMessages(threadId), historyRepo.getThread(threadId), writeGate.journal.newestForThread(threadId)])
      if (!thread || generation !== historyGenerationRef.current || busyRef.current) return
      const restored = restoreTurns(messages, journal).map((turn) => ({
        ...turn, view: { ...turn.view, activity: attachJournalEntries(turn.view.activity, journal) },
      }))
      if (generation !== historyGenerationRef.current || busyRef.current) return
      currentThreadIdRef.current = threadId
      setActiveThreadId(threadId)
      setAgentHistoryThread(threadId)
      writeGate.journal.scopeThread(threadId)
      agentLoop.restoreThread(thread.codexThreadId ?? null)
      setTurns(restored)
      setThreadTitle(thread.title)
      await chrome.storage.local.set({ nox_thread_id: threadId, nox_thread_title: thread.title })
    })().catch((error) => logError(`History open failed: ${error instanceof Error ? error.message : String(error)}`))
  }, [agentBusy, openThreadRequest, setActiveThreadId, setThreadTitle])

  // Header "new chat" button resets the conversation view.
  useEffect(() => {
    if (newChatTick === 0) return
    if (busyRef.current) return
    historyGenerationRef.current++
    historyRestoreCancelledRef.current = true
    setTurns([])
    currentThreadIdRef.current = null
    setActiveThreadId(null)
    setAgentHistoryThread(null)
    writeGate.journal.scopeThread(null)
    agentLoop.newThread()
    setThreadTitle('New chat')
    void chrome.storage.local.remove(['nox_thread_title', 'nox_thread_id'])
  }, [newChatTick, setActiveThreadId, setThreadTitle])

  const scrollToEnd = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))

  const v_error_placeholder = () => '(no content)'

  async function send(text: string) {
    if (busyRef.current || readOnly) return
    historyRestoreCancelledRef.current = true
    historyGenerationRef.current++
    if (connectionStatus !== 'connected') {
      setTurns((t) => [...t, { id: crypto.randomUUID(), userText: text, view: { activity: [], answer: '', error: 'Connect Notion first — open Settings (top right) to connect.', pending: false } }])
      return
    }
    busyRef.current = true
    setAgentBusy(true)
    setBusy(true)
    logInfo(`Send: ${text.slice(0, 120)}`)
    const turnId = crypto.randomUUID()
    setTurns((t) => [...t, { id: turnId, userText: text, view: { activity: [], answer: '', error: null, pending: true } }])
    const patch = (fn: (v: TurnView) => TurnView) =>
      setTurns((all) => all.map((turn) => turn.id === turnId ? { ...turn, view: fn(turn.view) } : turn))
    let pendingReasoning = ''
    let currentActivity: ActivityItem[] = []
    let streamedAnswer = ''
    let unsubscribe: (() => void) | null = null
    let persisted: Awaited<ReturnType<typeof startPersistedTurn>> | null = null

    try {
      try {
        persisted = await startPersistedTurn(historyRepo, currentThreadIdRef.current, text)
        currentThreadIdRef.current = persisted.threadId
        setActiveThreadId(persisted.threadId)
        setAgentHistoryThread(persisted.threadId)
        void chrome.storage.local.set({ nox_thread_id: persisted.threadId })
      } catch {
        /* persistence is best-effort; never block the chat */
      }
      unsubscribe = agentLoop.onTurnEvent((event) => {
        switch (event.kind) {
          case 'turn-started':
            if (currentThreadIdRef.current) {
              void historyRepo.setCodexThreadId(currentThreadIdRef.current, event.threadId).catch(() => undefined)
            }
            break
          case 'reasoning-started':
            pendingReasoning = ''
            break
          case 'reasoning-delta':
            pendingReasoning += event.text
            break
          case 'web-search':
            logInfo('Web search started')
            currentActivity = applyActivityEvent(currentActivity, event)
            patch((v) => ({ ...v, activity: currentActivity }))
            break
          case 'web-search-completed':
            currentActivity = applyActivityEvent(currentActivity, event)
            patch((v) => ({ ...v, activity: currentActivity }))
            break
          case 'tool-call': {
            if (pendingReasoning) {
              currentActivity = applyActivityEvent(currentActivity, { kind: 'reasoning', text: pendingReasoning.slice(0, 240) })
              pendingReasoning = ''
            }
            currentActivity = applyActivityEvent(currentActivity, event)
            logInfo(`Tool call: ${event.tool}`)
            patch((v) => ({ ...v, activity: currentActivity }))
            break
          }
          case 'tool-completed':
            currentActivity = applyActivityEvent(currentActivity, event)
            patch((v) => ({ ...v, activity: currentActivity }))
            break
          case 'text-started':
            if (pendingReasoning) {
              currentActivity = applyActivityEvent(currentActivity, { kind: 'reasoning', text: pendingReasoning.slice(0, 240) })
              pendingReasoning = ''
              patch((v) => ({ ...v, activity: currentActivity }))
            }
            break
          case 'usage':
            lastUsageRef.current = (event.usage as Record<string, number> | null) ?? null
            break
          case 'text-delta':
            streamedAnswer += event.text
            void persisted?.persistAssistant(streamedAnswer, undefined, currentActivity).catch(() => undefined)
            patch((v) => ({ ...v, answer: v.answer + event.text }))
            scrollToEnd()
            break
        }
      })

      let pageContext = currentPage
      if (currentPage) pageContext = await fetchCurrentPageContext(currentPage)

      const result = await agentLoop.sendUserMessage(text, { currentPage: pageContext ?? undefined })

      currentActivity = attachJournalEntries(currentActivity, await writeGate.journal.newestFirst())
      await persisted?.persistAssistant(result.text || streamedAnswer || v_error_placeholder(), lastUsageRef.current ?? undefined, currentActivity).catch(() => undefined)

      if (threadTitle === 'New chat') {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'
        setThreadTitle(title)
        void chrome.storage.local.set({ nox_thread_title: title })
        if (currentThreadIdRef.current) void historyRepo.renameThread(currentThreadIdRef.current, title)
      }
      patch((v) => ({ ...v, activity: currentActivity, answer: result.text || v.answer || '(no content)', pending: false }))
      logInfo('Turn complete')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      patch((v) => ({ ...v, error: message, pending: false }))
      logError(`Turn failed: ${message}`)
    } finally {
      unsubscribe?.()
      busyRef.current = false
      setAgentBusy(false)
      setBusy(false)
      scrollToEnd()
    }
  }

  const hasMessages = turns.length > 0

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="chat-panel">
      {!hasMessages ? (
        <EmptyState readOnly={readOnly} onSend={(t) => void send(t)} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-2 pt-1" data-testid="chat-messages">
          {turns.map(({ id, userText, view }) => (
            <div key={id} className="space-y-1.5">
              <div className="flex justify-end">
                <span className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-800 px-3.5 py-2 text-sm leading-relaxed">{userText}</span>
              </div>
              {(view.activity.length > 0 || view.pending) && (
                <ActivityTimeline items={view.activity} active={view.pending} onUndo={(id) => void undoActivity(id, setTurns)} />
              )}
              {view.answer && <div aria-live={view.pending ? 'polite' : undefined} aria-atomic="false"><AssistantMarkdown markdown={view.answer} /></div>}
              {!readOnly && !view.pending && view.answer && (
                <FollowUpActions suggestions={followUpsForActivity(view.activity)} onSelect={(suggestion) => void send(suggestion)} />
              )}
              {view.error && (
                <p className="nox-warning rounded-md border border-current/40 px-2 py-1.5 text-xs" role="alert">
                  ⚠ {view.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy ? 'Nox is working' : ''}
      </div>

      {!readOnly && <ApprovalCards />}
      {hasMessages && !readOnly && <UndoBar />}

      <Composer busy={busy} readOnly={readOnly} onSend={(t) => void send(t)} onCancel={() => agentLoop.cancel()} />
    </section>
  )
}

const undoingJournalIds = new Set<string>()

function attachJournalEntries(items: ActivityItem[], entries: Awaited<ReturnType<typeof writeGate.journal.newestFirst>>): ActivityItem[] {
  return items.map((item) => {
    if (item.kind !== 'tool') return item
    const entry = entries.find((candidate) => candidate.callId && candidate.callId === item.id)
    return entry ? { ...item, journalId: entry.id, undoable: entry.status === 'applied' && entry.inverse != null } : item
  })
}

async function undoActivity(
  journalId: string,
  setTurns: Dispatch<SetStateAction<Array<{ id: string; userText: string; view: TurnView }>>>,
): Promise<void> {
  if (undoingJournalIds.has(journalId)) return
  undoingJournalIds.add(journalId)
  let error: string | undefined
  try {
    const undone = await undoEntry(writeGate.journal, journalId, (tool, args) => writeGate.handleUndo(tool, args))
    if (!undone) error = 'This change is no longer available to undo.'
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    undoingJournalIds.delete(journalId)
  }
  setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyUndoResult(turn.view.activity, journalId, error) } })))
}
