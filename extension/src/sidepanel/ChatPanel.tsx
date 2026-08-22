import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNoxStore } from './store'
import { agentLoop, fetchCurrentPageContext, setAgentHistoryThread, writeGate } from '../lib/agent/panel'
import { ActivityTimeline, AssistantMarkdown, FollowUpActions } from './MessageParts'
import { applyActivityEvent, followUpsForActivity, type ActivityItem } from '../lib/agent/activity'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { ApprovalCards, UndoBar } from './ApprovalCards'
import { historyRepo } from '../lib/history/panel'
import { startPersistedTurn } from '../lib/history/turn'
import { logError, logInfo } from '../lib/log'
import { undoEntry } from '../lib/writes/undo'

interface TurnView {
  activity: ActivityItem[]
  answer: string
  error: string | null
  pending: boolean
}

export function ChatPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [turns, setTurns] = useState<Array<{ userText: string; view: TurnView }>>([])
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentThreadIdRef = useRef<string | null>(null)
  const lastUsageRef = useRef<Record<string, number> | null>(null)
  const currentPage = useNoxStore((s) => s.currentPage)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const setThreadTitle = useNoxStore((s) => s.setThreadTitle)
  const newChatTick = useNoxStore((s) => s.newChatTick)

  // Header "new chat" button resets the conversation view.
  useEffect(() => {
    if (newChatTick === 0) return
    setTurns([])
    currentThreadIdRef.current = null
    setAgentHistoryThread(null)
    agentLoop.newThread()
    setThreadTitle('New chat')
    void chrome.storage.local.remove('nox_thread_title')
  }, [newChatTick, setThreadTitle])

  const scrollToEnd = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))

  const v_error_placeholder = () => '(no content)'

  async function send(text: string) {
    if (busy || readOnly) return
    if (connectionStatus !== 'connected') {
      setTurns((t) => [...t, { userText: text, view: { activity: [], answer: '', error: 'Connect Notion first — open Settings (top right) to connect.', pending: false } }])
      return
    }
    setBusy(true)
    logInfo(`Send: ${text.slice(0, 120)}`)
    setTurns((t) => [...t, { userText: text, view: { activity: [], answer: '', error: null, pending: true } }])
    const patch = (fn: (v: TurnView) => TurnView) =>
      setTurns((all) => {
        const copy = [...all]
        copy[copy.length - 1] = { ...copy[copy.length - 1], view: fn(copy[copy.length - 1].view) }
        return copy
      })
    let pendingReasoning = ''
    let currentActivity: ActivityItem[] = []
    let streamedAnswer = ''
    let unsubscribe: (() => void) | null = null
    let persisted: Awaited<ReturnType<typeof startPersistedTurn>> | null = null

    try {
      try {
        persisted = await startPersistedTurn(historyRepo, currentThreadIdRef.current, text)
        currentThreadIdRef.current = persisted.threadId
        setAgentHistoryThread(persisted.threadId)
      } catch {
        /* persistence is best-effort; never block the chat */
      }
      unsubscribe = agentLoop.onTurnEvent((event) => {
        switch (event.kind) {
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
            void attachJournalEntries(currentActivity).then((items) => {
              currentActivity = items
              patch((v) => ({ ...v, activity: items }))
            })
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

      currentActivity = await attachJournalEntries(currentActivity)
      await persisted?.persistAssistant(result.text || streamedAnswer || v_error_placeholder(), lastUsageRef.current ?? undefined, currentActivity).catch(() => undefined)

      if (threadTitle === 'New chat') {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'
        setThreadTitle(title)
        void chrome.storage.local.set({ nox_thread_title: title })
        if (currentThreadIdRef.current) void historyRepo.renameThread(currentThreadIdRef.current, title)
      }
      patch((v) => ({ ...v, answer: result.text || v.answer || '(no content)', pending: false }))
      logInfo('Turn complete')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      patch((v) => ({ ...v, error: message, pending: false }))
      logError(`Turn failed: ${message}`)
    } finally {
      unsubscribe?.()
      setBusy(false)
      scrollToEnd()
    }
  }

  const hasMessages = turns.length > 0

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="chat-panel">
      {!hasMessages ? (
        <EmptyState onSend={(t) => void send(t)} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-2 pt-1" aria-live="polite" data-testid="chat-messages">
          {turns.map(({ userText, view }, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex justify-end">
                <span className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-800 px-3.5 py-2 text-sm leading-relaxed">{userText}</span>
              </div>
              {(view.activity.length > 0 || view.pending) && (
                <ActivityTimeline items={view.activity} active={view.pending} onUndo={(id) => void undoActivity(id, setTurns)} />
              )}
              {view.answer && <AssistantMarkdown markdown={view.answer} />}
              {!view.pending && view.answer && (
                <FollowUpActions suggestions={followUpsForActivity(view.activity)} onSelect={(suggestion) => void send(suggestion)} />
              )}
              {view.error && (
                <p className="rounded-md border border-amber-800/50 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-400" role="alert">
                  ⚠ {view.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && <ApprovalCards />}
      {hasMessages && !readOnly && <UndoBar />}

      <Composer busy={busy} readOnly={readOnly} onSend={(t) => void send(t)} onCancel={() => agentLoop.cancel()} />
    </section>
  )
}

async function attachJournalEntries(items: ActivityItem[]): Promise<ActivityItem[]> {
  const entries = await writeGate.journal.newestFirst()
  return items.map((item) => {
    if (item.kind !== 'tool') return item
    const entry = entries.find((candidate) => candidate.callId && candidate.callId === item.id)
    return entry ? { ...item, journalId: entry.id, undoable: entry.status === 'applied' && entry.inverse != null } : item
  })
}

async function undoActivity(
  journalId: string,
  setTurns: Dispatch<SetStateAction<Array<{ userText: string; view: TurnView }>>>,
): Promise<void> {
  await undoEntry(writeGate.journal, journalId, (tool, args) => writeGate.handleUndo(tool, args))
  setTurns((turns) => turns.map((turn) => ({
    ...turn,
    view: {
      ...turn.view,
      activity: turn.view.activity.map((item) => item.kind === 'tool' && item.journalId === journalId
        ? { ...item, undoable: false, resultText: 'Change undone' }
        : item),
    },
  })))
}
