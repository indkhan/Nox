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
import { removeUnlinkedAttachments } from '../lib/history/attachments'
import { openNoxDB } from '../lib/history/schema'
import { onDeletionNotice } from '../lib/history/deletion'
import { HISTORY_SAVE_ERROR, startPersistedTurn, type PersistedTurn } from '../lib/history/turn'
import { logError, logInfo, safeErrorDetail } from '../lib/log'
import { requestRuntimeUndo } from '../lib/writes/undo'
import { restoreTurns } from '../lib/history/restore'
import type { MentionRef } from '../shared/notion-page'
import type { DraftAttachment, LocalAttachment } from '../shared/attachments'
import { validateDraftSelection } from '../shared/attachments'
import type { OwnedAttachmentInput } from '../lib/history/repository'

interface TurnView {
  activity: ActivityItem[]
  answer: string
  error: string | null
  outcome?: 'failed' | 'interrupted'
  pending: boolean
  /** Durable-history degradation for this turn ("History could not be saved"). */
  historyError?: string | null
}

/** Retry/copy banner for a failed final history save (Epoch 09 / M16). */
export function HistorySaveError({ onRetry, onCopy }: { onRetry?: () => void; onCopy: () => void }) {
  return (
    <div className="rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200" role="alert" data-testid="history-save-error">
      <span>{HISTORY_SAVE_ERROR} — the answer above is only in memory.</span>
      <span className="ml-2 inline-flex gap-2">
        {onRetry && (
          <button onClick={onRetry} data-testid="history-save-retry" className="underline underline-offset-2 hover:no-underline">
            Retry save
          </button>
        )}
        <button onClick={onCopy} data-testid="history-save-copy" className="underline underline-offset-2 hover:no-underline">
          Copy answer
        </button>
      </span>
    </div>
  )
}

export function ChatPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [turns, setTurns] = useState<Array<{ id: string; userText: string; view: TurnView }>>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentThreadIdRef = useRef<string | null>(null)
  const lastUsageRef = useRef<Record<string, number> | null>(null)
  /** Persisted-turn handles by turn id for history-save retries (no model rerun). */
  const persistedHandles = useRef(new Map<string, PersistedTurn>())
  const patchTurn = (id: string, fn: (v: TurnView) => TurnView) =>
    setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, view: fn(turn.view) } : turn)))
  const historyRestoreCancelledRef = useRef(false)
  const historyGenerationRef = useRef(0)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const codexStatus = useNoxStore((s) => s.codexStatus)
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
    // Epoch 10 / M7: drop provably unreferenced legacy attachment blobs left
    // by pre-ephemeral drafts (no thread linkage). Owned rows are preserved;
    // a cleanup failure is logged and never blocks startup.
    void removeUnlinkedAttachments(openNoxDB).then((removed) => {
      if (removed > 0) logInfo(`Removed ${removed} unlinked legacy attachment(s)`)
    }).catch((error) => logError(`Legacy attachment cleanup failed: ${safeErrorDetail(error)}`))
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
    })().catch((error) => logError(`History open failed: ${safeErrorDetail(error)}`))
  }, [agentBusy, openThreadRequest, setActiveThreadId, setThreadTitle])

  // Header "new chat" button resets the conversation view.
  useEffect(() => {
    if (newChatTick === 0) return
    if (busyRef.current) return
    historyGenerationRef.current++
    historyRestoreCancelledRef.current = true
    setTurns([])
    persistedHandles.current.clear()
    currentThreadIdRef.current = null
    setActiveThreadId(null)
    setAgentHistoryThread(null)
    writeGate.journal.scopeThread(null)
    agentLoop.newThread()
    setThreadTitle('New chat')
    void chrome.storage.local.remove(['nox_thread_title', 'nox_thread_id'])
  }, [newChatTick, setActiveThreadId, setThreadTitle])

  const scrollToEnd = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))

  // Another panel started "Delete all data": cancel this panel's turn,
  // invalidate pending grants/cards, and stop touching storage. Late
  // streaming/journal callbacks already tolerate rejection; openNoxDB refuses
  // while deletion is pending so nothing recreates the database.
  useEffect(() => onDeletionNotice(() => {
    sendAbortRef.current?.abort()
    agentLoop.cancel()
    logError('Storage deletion was requested from another Nox window — the active turn was cancelled.')
  }), [])

  // Send stays disabled until both transports report connected (Epoch 11 / L6):
  // the composer button is disabled and this guard blocks direct calls.
  const transportDown = connectionStatus !== 'connected' || codexStatus === 'disconnected' || codexStatus === 'error'
  const transportDownReason =
    codexStatus === 'disconnected' || codexStatus === 'error'
      ? 'Codex disconnected — reconnect to continue. Your history is preserved and no turn was replayed.'
      : 'Connect Notion first — open Settings (top right) to connect.'

  async function send(text: string, mentions: MentionRef[] = [], drafts: DraftAttachment[] = [], allowSmallEdits = false) {
    if (busyRef.current || readOnly) return
    historyRestoreCancelledRef.current = true
    historyGenerationRef.current++
    if (transportDown) {
      setTurns((t) => [...t, { id: crypto.randomUUID(), userText: text, view: { activity: [], answer: '', error: transportDownReason, pending: false } }])
      return
    }
    // Epoch 10 / M7: stage attachment bytes before anything else. Sizes are
    // re-checked here (the composer already validated) before any bytes are
    // read, and the atomic header below commits thread + user message + bytes
    // in one transaction. A failure throws before prepareAgentTurn and before
    // any Codex/upload request, so the composer retains its in-memory draft.
    const owned = await stageOwnedDrafts(drafts)
    const currentPage = useNoxStore.getState().currentPage ?? undefined
    const sendAbort = new AbortController()
    sendAbortRef.current = sendAbort
    const deadline = setTimeout(() => { sendAbort.abort(); agentLoop.cancel() }, 10 * 60 * 1000)
    lastUsageRef.current = null
    const mode = useNoxStore.getState().mode
    const turnPageIds = [...mentions.map((mention) => mention.pageId), ...(currentPage ? [currentPage.pageId] : [])]
    const turnId = crypto.randomUUID()
    let persisted: Awaited<ReturnType<typeof startPersistedTurn>> | null = null
    try {
      persisted = await startPersistedTurn(historyRepo, currentThreadIdRef.current, text, owned)
    } catch (error) {
      if (owned.length > 0) {
        const message = error instanceof Error ? error.message : String(error)
        setTurns((t) => [...t, { id: crypto.randomUUID(), userText: text, view: { activity: [], answer: '', error: `Attachments could not be saved locally — nothing was sent. ${message}`, pending: false } }])
        clearTimeout(deadline)
        sendAbortRef.current = null
        throw error
      }
      /* persistence is best-effort when no attachments ride along; never block the chat */
    }
    // Only ids committed for this turn reach the agent: the grant and the
    // model context are built from the persisted rows, never the live draft.
    const committed: LocalAttachment[] = owned.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
    // The small-edit grant is captured here at Send — normalized targets,
    // grant flag, mode, and turn binding — and reset for the next turn. Only
    // Auto with an explicit grant permits silent small edits.
    prepareAgentTurn(mode, turnPageIds, committed.map((attachment) => attachment.id), mode === 'auto' && allowSmallEdits ? { allowed: true, pages: turnPageIds } : undefined)
    busyRef.current = true
    setAgentBusy(true)
    setBusy(true)
    // Epoch 14 / L2: diagnostics record the turn operation only, never prompt text.
    logInfo(`Send: starting turn ${turnId} (mode=${mode})`)
    setTurns((t) => [...t, { id: turnId, userText: text, view: { activity: [], answer: '', error: null, pending: true, historyError: persisted ? null : HISTORY_SAVE_ERROR } }])
    const patch = (fn: (v: TurnView) => TurnView) =>
      setTurns((all) => all.map((turn) => turn.id === turnId ? { ...turn, view: fn(turn.view) } : turn))
    let pendingReasoning = ''
    let currentActivity: ActivityItem[] = []
    let streamedAnswer = ''
    let unsubscribe: (() => void) | null = null
    let unsubscribeHistoryErrors: (() => void) | null = null

    try {
      if (persisted) {
        currentThreadIdRef.current = persisted.threadId
        persistedHandles.current.set(turnId, persisted)
        // Final-save failures surface near the answer with retry/copy;
        // partial-save failures stay silent unless the final also fails.
        unsubscribeHistoryErrors = persisted.onSaveError(() => {
          patch((v) => ({ ...v, historyError: HISTORY_SAVE_ERROR }))
        })
        setActiveThreadId(persisted.threadId)
        setAgentHistoryThread(persisted.threadId)
        void chrome.storage.local.set({ nox_thread_id: persisted.threadId })
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
        attachments: committed,
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
      logError(`Turn failed: ${safeErrorDetail(e)}`)
    } finally {
      clearTimeout(deadline)
      sendAbortRef.current = null
      unsubscribeHistoryErrors?.()
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
        <EmptyState readOnly={readOnly || transportDown} onSend={(t, mentions) => void send(t, mentions)} />
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
              {view.historyError && (
                <HistorySaveError
                  onRetry={
                    persistedHandles.current.has(id)
                      ? () => {
                          const handle = persistedHandles.current.get(id)
                          if (!handle) return
                          // Retry the full local snapshot only — never rerun
                          // the model turn. Success clears the banner; another
                          // failure keeps it via the promise rejection below.
                          void handle.retryFinal().then(
                            () => patchTurn(id, (v) => ({ ...v, historyError: null })),
                            () => patchTurn(id, (v) => ({ ...v, historyError: HISTORY_SAVE_ERROR })),
                          )
                        }
                      : undefined
                  }
                  onCopy={() => {
                    void navigator.clipboard?.writeText(view.answer).catch(() => undefined)
                  }}
                />
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
        sendDisabledReason={transportDown ? transportDownReason : null}
        onSend={(t, mentions, drafts, allowSmallEdits) => send(t, mentions, drafts, allowSmallEdits)}
        onCancel={() => { sendAbortRef.current?.abort(); agentLoop.cancel() }}
      />
      </>}
    </section>
  )
}

/**
 * Re-check draft sizes and read bytes staged for the atomic send (Epoch 10 /
 * M7). Aggregate size is checked before any bytes are read; a rejection
 * throws before thread creation, turn setup, or any Codex/upload request.
 */
async function stageOwnedDrafts(drafts: DraftAttachment[]): Promise<OwnedAttachmentInput[]> {
  if (drafts.length === 0) return []
  const { rejected } = validateDraftSelection([], drafts.map((draft) => draft.file))
  if (rejected.length > 0) throw new Error(rejected[0].reason)
  return Promise.all(
    drafts.map(async (draft) => ({
      id: draft.id,
      name: draft.name,
      mimeType: draft.mimeType,
      size: draft.size,
      bytes: await draft.file.arrayBuffer(),
    })),
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
    // Applied but not safely reversible: say exactly why, with the real
    // target link, instead of silently omitting the undo control.
    if (entry.status === 'applied' && entry.inverse == null && entry.notUndoableReason) {
      return {
        ...item,
        journalId: entry.id,
        undoable: false,
        notUndoableReason: entry.notUndoableReason,
        inspectUrl: entry.targetPageId ? inspectUrlForPage(entry.targetPageId) : undefined,
      }
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
