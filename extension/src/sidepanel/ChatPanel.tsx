import { useRef, useState } from 'react'
import { useNoxStore } from './store'
import { agentLoop, fetchCurrentPageContext } from '../lib/agent/panel'
import type { CodexEvent } from '../lib/codex/client'

interface ChatMessage {
  role: 'user' | 'assistant' | 'status'
  text: string
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [titled, setTitled] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const currentPage = useNoxStore((s) => s.currentPage)
  const connectionStatus = useNoxStore((s) => s.connectionStatus)

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    if (connectionStatus !== 'connected') {
      setMessages((m) => [...m, { role: 'status', text: 'Connect Notion first — Nox acts on your workspace.' }])
      return
    }

    setInput('')
    setBusy(true)
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])

    let streaming = ''
    let lastWasTool = false
    const appendAssistantDelta = (delta: string) => {
      streaming += delta
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', text: streaming }
        return copy
      })
    }
    let unsubscribe: (() => void) | null = null

    try {
      unsubscribe = agentLoop.onTurnEvent((event: CodexEvent | { kind: 'bridge-reconnecting' }) => {
        if (event.kind === 'reasoning-delta') {
          if (lastWasTool) appendAssistantDelta('\n')
          lastWasTool = false
        } else if (event.kind === 'tool-call') {
          lastWasTool = true
          appendAssistantDelta(`\n\n⚙ ${event.tool}…\n`)
        } else if (event.kind === 'text-delta') {
          appendAssistantDelta(event.text)
        }
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
      })

      let pageContext = currentPage
      if (currentPage) pageContext = await fetchCurrentPageContext(currentPage)

      const result = await agentLoop.sendUserMessage(text, { currentPage: pageContext ?? undefined })
      if (!titled) {
        void chrome.storage.local.set({
          'nox.threadTitle': text.replace(/\s+/g, ' ').trim().slice(0, 48),
        })
        setTitled(true)
      }
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', text: result.text || '(no content)' }
        return copy
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setMessages((m) => [...m.slice(0, -1, ), { role: 'assistant', text: `⚠ ${message}` }] as ChatMessage[])
    } finally {
      unsubscribe?.()
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900" data-testid="chat-panel">
      <div ref={listRef} className="min-h-[8rem] flex-1 space-y-2 overflow-y-auto p-3" data-testid="chat-messages">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">Ask anything about your workspace. Every tool call appears inline.</p>
        )}
        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <span className="max-w-[85%] rounded-2xl bg-emerald-700/40 px-3 py-1.5 text-sm">{msg.text}</span>
            </div>
          ) : msg.role === 'status' ? (
            <p key={i} className="text-xs text-zinc-500">{msg.text}</p>
          ) : (
            <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">{msg.text || '…'}</p>
          ),
        )}
      </div>
      <div className="flex items-end gap-2 border-t border-zinc-800 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={1}
          placeholder="Do anything with AI..."
          data-testid="composer"
          className="max-h-32 flex-1 resize-none bg-transparent p-2 text-sm outline-none placeholder:text-zinc-600"
        />
        {busy ? (
          <button onClick={() => agentLoop.cancel()} data-testid="stop" className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold">
            Stop
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!input.trim()} data-testid="send" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-40">
            Send
          </button>
        )}
      </div>
    </section>
  )
}
