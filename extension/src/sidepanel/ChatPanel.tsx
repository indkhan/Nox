import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNoxStore } from './store'
import { agentLoop, fetchMentionContext, prepareAgentTurn, setAgentHistoryThread, writeGate } from '../lib/agent/panel'
import { ActivityTimeline, AssistantMarkdown, FollowUpActions } from './MessageParts'
import { applyActivityEvent, applyReviewEvidence, applyReviewResult, applyUndoResult, describeUnresolvedEntry, followUpsForActivity, inspectUrlForPage, type ActivityItem } from '../lib/agent/activity'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { ApprovalCards, UndoBar } from './ApprovalCards'
import { PlanCards } from './PlanCards'
import { historyRepo } from '../lib/history/panel'
import { startPersistedTurn } from '../lib/history/turn'
import { logError, logInfo } from '../lib/log'
import { requestRuntimeUndo } from '../lib/writes/undo'
import { restoreTurns } from '../lib/history/restore'
import type { MentionRef } from '../shared/notion-page'
import type { LocalAttachment } from '../shared/attachments'

interface TurnView {
  activity: ActivityItem[]
  answer: string
  error: string | null
  outcome?: 'failed' | 'interrupted'
  pending: boolean
}

export function ChatPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [turns, setTurns] = useState<Array<{ id: string; userText: string; view: TurnView }>>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentThreadIdRef = useRef<string | null>(null)
  const lastUsageRef = useRef<Record<string, number> | null>(null)
  const historyRestoreCancelledRef = useRef(false)
  const historyGenerationRef = useRef(0)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const setThreadTitle = useNoxStore((s) => s.setThreadTitle)
  const newChatTick = useNoxStore((s) => s.newChatTick)
  const openThreadRequest = useNoxStore((s) => s.openThreadRequest)
  const agentBusy = useNoxStore((s) => s.agentBusy)
  const reviewingPlan = useNoxStore((s) => s.pendingPlans.length > 0)
  const setAgentBusy = useNoxStore((s) => s.setAgentBusy)
  const setActiveThreadId = useNoxStore((s) => s.setActiveThreadId)

  useEffect(() => {
    let cancelled = false
    const generation = ++historyGenerationRef.current
    writeGate.journal.scopeThread(null)
    void chrome.storage.local.get('nox_thread_id').then(async (stored) => {
      const threadId = stored['nox_thread_id']
      if (typeof threadId !== 'string' || !threadId) return
      const [messages, thread, journal] = await Promise.all([historyRepo.getMessages(threadId), historyRepo.getThread(threadId), writeGate.journal.newestForThread(threadId)])
      if (cancelled || historyRestoreCancelledRef.current || generation !== historyGenerationRef.current) return
      const restored = restoreTurns(messages, journal).map((turn) => ({
        ...turn, view: { ...turn.view, activity: attachJournalEntries(turn.view.activity, journal) },
      }))
      currentThreadIdRef.current = threadId
      setActiveThreadId(threadId)
      setAgentHistoryThread(threadId)
      writeGate.journal.scopeThread(threadId)
      agentLoop.restoreThread(thread?.codexThreadId ?? null)
      if (cancelled || historyRestoreCancelledRef.current || generation !== historyGenerationRef.current) return
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

  async function send(text: string, mentions: MentionRef[] = [], attachments: LocalAttachment[] = []) {
    if (busyRef.current || readOnly) return
    historyRestoreCancelledRef.current = true
    historyGenerationRef.current++
    if (connectionStatus !== 'connected') {
      setTurns((t) => [...t, { id: crypto.randomUUID(), userText: text, view: { activity: [], answer: '', error: 'Connect Notion first — open Settings (top right) to connect.', pending: false } }])
      return
    }
    const currentPage = useNoxStore.getState().currentPage ?? undefined
    const sendAbort = new AbortController()
    sendAbortRef.current = sendAbort
    const deadline = setTimeout(() => { sendAbort.abort(); agentLoop.cancel() }, 10 * 60 * 1000)
    lastUsageRef.current = null
    prepareAgentTurn(useNoxStore.getState().mode, [...mentions.map((mention) => mention.pageId), ...(currentPage ? [currentPage.pageId] : [])], attachments.map((attachment) => attachment.id))
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
            currentActivity = applyActivityEvent(currentActivity, { kind: 'commentary', id: `summary-${turnId}`, text: pendingReasoning.slice(0, 480) })
            patch((v) => ({ ...v, activity: currentActivity }))
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
          case 'commentary':
            currentActivity = applyActivityEvent(currentActivity, event)
            patch((v) => ({ ...v, activity: currentActivity }))
            break
          case 'text-replaced':
            streamedAnswer = event.text
            void persisted?.persistAssistant(streamedAnswer, undefined, currentActivity).catch(() => undefined)
            patch((v) => ({ ...v, answer: event.text }))
            scrollToEnd()
            break
          case 'text-delta':
            streamedAnswer += event.text
            void persisted?.persistAssistant(streamedAnswer, undefined, currentActivity).catch(() => undefined)
            patch((v) => ({ ...v, answer: v.answer + event.text }))
            scrollToEnd()
            break
        }
      })

      const result = await agentLoop.sendUserMessage(text, {
        currentPage,
        signal: sendAbort.signal,
        prepareContext: (signal) => Promise.all(mentions.map(m => fetchMentionContext(m, signal))),
        attachments,
      })

      currentActivity = attachJournalEntries(currentActivity, await writeGate.journal.newestFirst())
      const finalText = result.text
      await persisted?.persistAssistant(finalText, lastUsageRef.current ?? undefined, currentActivity, result.interrupted ? 'interrupted' : 'complete').catch(() => undefined)

      if (threadTitle === 'New chat') {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'
        setThreadTitle(title)
        void chrome.storage.local.set({ nox_thread_title: title })
        if (currentThreadIdRef.current) void historyRepo.renameThread(currentThreadIdRef.current, title)
      }
      patch((v) => ({
        ...v,
        activity: currentActivity,
        answer: result.text,
        outcome: result.interrupted ? 'interrupted' : undefined,
        error: result.interrupted ? 'Stopped before Nox finished responding.' : null,
        pending: false,
      }))
      logInfo(result.interrupted ? 'Turn interrupted' : 'Turn complete')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      patch((v) => ({ ...v, error: message, outcome: 'failed', pending: false }))
      await persisted?.persistAssistant(streamedAnswer, lastUsageRef.current ?? undefined, currentActivity, 'failed', message).catch(() => undefined)
      logError(`Turn failed: ${message}`)
    } finally {
      clearTimeout(deadline)
      sendAbortRef.current = null
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
      {reviewingPlan && !readOnly ? <PlanCards /> : <>
      {!hasMessages ? (
        <EmptyState readOnly={readOnly} onSend={(t, mentions) => void send(t, mentions)} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-2 pt-1" data-testid="chat-messages">
          {turns.map(({ id, userText, view }) => (
            <div key={id} className="space-y-1.5">
              <div className="flex justify-end">
                <span className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-800 px-3.5 py-2 text-sm leading-relaxed">{userText}</span>
              </div>
              {(view.activity.length > 0 || view.pending) && (
                <ActivityTimeline
                  items={view.activity}
                  outcome={view.outcome}
                  active={view.pending}
                  answerStarted={view.answer.length > 0}
                  onUndo={readOnly || busy ? undefined : (id) => void undoActivity(id, setTurns)}
                  undoUnavailableReason={readOnly ? 'Undo unavailable in read-only mode' : busy ? 'Undo unavailable while Nox is working' : undefined}
                  onMarkReviewed={readOnly || busy ? undefined : (id) => void reviewActivity(id, setTurns)}
                  onCheckState={readOnly || busy ? undefined : (id) => void checkOperationState(id, setTurns)}
                />
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
      {hasMessages && !readOnly && <UndoBar busy={busy} />}

      <Composer
        busy={busy}
        readOnly={readOnly}
        onSend={(t, mentions, attachments) => void send(t, mentions, attachments)}
        onCancel={() => { sendAbortRef.current?.abort(); agentLoop.cancel() }}
      />
      </>}
    </section>
  )
}

const undoingJournalIds = new Set<string>()

function attachJournalEntries(items: ActivityItem[], entries: Awaited<ReturnType<typeof writeGate.journal.newestFirst>>): ActivityItem[] {
  return items.map((item) => {
    if (item.kind !== 'tool') return item
    const entry = entries.find((candidate) => candidate.callId && candidate.callId === item.id)
    if (!entry) {
      const byJournalId = entries.find((candidate) => candidate.id === item.journalId)
      return byJournalId && (byJournalId.status === 'pending' || byJournalId.status === 'unknown')
        ? markUnresolvedRow(item, byJournalId)
        : item
    }
    if (entry.status === 'pending' || entry.status === 'unknown' || (entry.status === 'applied' && entry.reservedByUndoOpId != null)) {
      return markUnresolvedRow(item, entry)
    }
    return { ...item, journalId: entry.id, undoable: entry.status === 'applied' && entry.inverse != null }
  })
}

function markUnresolvedRow(
  item: Extract<ActivityItem, { kind: 'tool' }>,
  entry: { id: string; status: string; outcomeDetail?: string; reviewedAt?: number; reservedByUndoOpId?: string; targetPageId?: string },
): ActivityItem {
  return {
    ...item,
    status: 'unknown',
    journalId: entry.id,
    undoable: false,
    unresolvedDetail: describeUnresolvedEntry(entry),
    inspectUrl: entry.targetPageId ? inspectUrlForPage(entry.targetPageId) : undefined,
    reviewed: entry.reviewedAt != null ? true : undefined,
  }
}

async function undoActivity(
  journalId: string,
  setTurns: Dispatch<SetStateAction<Array<{ id: string; userText: string; view: TurnView }>>>,
): Promise<void> {
  if (undoingJournalIds.has(journalId)) return
  undoingJournalIds.add(journalId)
  let error: string | undefined
  try {
    // One runtime undo path: the gate re-checks owner/turn state and the
    // journal entry itself before any transport.
    const undone = await requestRuntimeUndo(writeGate, journalId)
    if (!undone) error = 'This change is no longer available to undo.'
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    undoingJournalIds.delete(journalId)
  }
  setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyUndoResult(turn.view.activity, journalId, error) } })))
}

async function reviewActivity(
  journalId: string,
  setTurns: Dispatch<SetStateAction<Array<{ id: string; userText: string; view: TurnView }>>>,
): Promise<void> {
  try {
    const reviewed = await writeGate.journal.markReviewed(journalId, 'inspected from activity')
    if (!reviewed) return
  } catch (cause) {
    setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyReviewEvidence(turn.view.activity, journalId, `Review failed: ${cause instanceof Error ? cause.message : String(cause)}`) } })))
    return
  }
  setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyReviewResult(turn.view.activity, journalId) } })))
}

async function checkOperationState(
  journalId: string,
  setTurns: Dispatch<SetStateAction<Array<{ id: string; userText: string; view: TurnView }>>>,
): Promise<void> {
  try {
    const evidence = await writeGate.readbackForReview(journalId)
    const text = evidence.targetPageId
      ? `${evidence.detail} Open in Notion: ${inspectUrlForPage(evidence.targetPageId)}.`
      : evidence.detail
    setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyReviewEvidence(turn.view.activity, journalId, text) } })))
  } catch (cause) {
    setTurns((turns) => turns.map((turn) => ({ ...turn, view: { ...turn.view, activity: applyReviewEvidence(turn.view.activity, journalId, `State check failed: ${cause instanceof Error ? cause.message : String(cause)}`) } })))
  }
}
