import { useRef, useState } from 'react'
import { useNoxStore } from './store'
import { agentLoop, fetchCurrentPageContext } from '../lib/agent/panel'
import { AssistantMarkdown, ProgressBlock, type ProgressStep } from './MessageParts'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'

interface TurnView {
  progress: ProgressStep[]
  answer: string
  error: string | null
}

export function ChatPanel() {
  const [turns, setTurns] = useState<Array<{ userText: string; view: TurnView }>>([])
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentPage = useNoxStore((s) => s.currentPage)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)
  const threadTitle = useNoxStore((s) => s.threadTitle)
  const setThreadTitle = useNoxStore((s) => s.setThreadTitle)

  const scrollToEnd = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))

  async function send(text: string) {
    if (busy) return
    if (connectionStatus !== 'connected') {
      setTurns((t) => [...t, { userText: text, view: { progress: [], answer: '', error: 'Connect Notion first — Nox acts on your workspace.' } }])
      return
    }
    setBusy(true)
    setTurns((t) => [...t, { userText: text, view: { progress: [], answer: '', error: null } }])
    const patch = (fn: (v: TurnView) => TurnView) =>
      setTurns((all) => {
        const copy = [...all]
        copy[copy.length - 1] = { ...copy[copy.length - 1], view: fn(copy[copy.length - 1].view) }
        return copy
      })
    let pendingReasoning = ''
    let unsubscribe: (() => void) | null = null

    try {
      unsubscribe = agentLoop.onTurnEvent((event) => {
        switch (event.kind) {
          case 'reasoning-started':
            pendingReasoning = ''
            break
          case 'reasoning-delta':
            pendingReasoning += event.text
            break
          case 'web-search':
            patch((v) => ({ ...v, progress: [...v.progress, { kind: 'web-search', label: 'Searching the web' }] }))
            break
          case 'tool-call': {
            const steps: ProgressStep[] = []
            if (pendingReasoning) {
              steps.push({ kind: 'reasoning', label: 'Thought', detail: pendingReasoning.slice(0, 120) })
              pendingReasoning = ''
            }
            steps.push({
              kind: 'tool',
              label: event.tool,
              detail: JSON.stringify(event.args).slice(0, 80),
            })
            patch((v) => ({ ...v, progress: [...v.progress, ...steps] }))
            break
          }
          case 'text-delta':
            patch((v) => ({ ...v, answer: v.answer + event.text }))
            scrollToEnd()
            break
        }
      })

      let pageContext = currentPage
      if (currentPage) pageContext = await fetchCurrentPageContext(currentPage)

      const result = await agentLoop.sendUserMessage(text, { currentPage: pageContext ?? undefined })
      if (threadTitle === 'New chat') {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat'
        setThreadTitle(title)
        void chrome.storage.local.set({ nox_thread_title: title })
      }
      patch((v) => ({ ...v, answer: result.text || v.answer || '(no content)' }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      patch((v) => ({ ...v, error: message }))
    } finally {
      unsubscribe?.()
      setBusy(false)
      scrollToEnd()
    }
  }

  function newChat() {
    setTurns([])
    setThreadTitle('New chat')
    void chrome.storage.local.remove('nox_thread_title')
  }

  const hasMessages = turns.length > 0

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" data-testid="chat-panel">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-emerald-400">⬡</span>
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium" data-testid="thread-title">{threadTitle}</h2>
        <button onClick={newChat} aria-label="New chat" data-testid="new-chat" className="text-xs text-zinc-500 hover:text-zinc-300">
          ＋
        </button>
      </header>

      {!hasMessages ? (
        <EmptyState />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" aria-live="polite" data-testid="chat-messages">
          {turns.map(({ userText, view }, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <span className="max-w-[85%] rounded-2xl bg-emerald-700/40 px-3 py-1.5 text-sm">{userText}</span>
              </div>
              <ProgressBlock steps={view.progress} />
              {view.answer && <AssistantMarkdown markdown={view.answer} />}
              {view.error && (
                <p className="rounded-md border border-amber-800/50 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-400" role="alert">
                  ⚠ {view.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <Composer busy={busy} onSend={(t) => void send(t)} onCancel={() => agentLoop.cancel()} />
    </section>
  )
}
