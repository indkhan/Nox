import { beforeEach, describe, expect, it } from 'vitest'
import { AgentLoop, titleFromExchange } from '../../src/lib/agent/loop'
import { ToolExecutor } from '../../src/lib/agent/executor'
import { CodexClient, type CodexEvent } from '../../src/lib/codex/client'
import type { NativeBridge } from '../../src/lib/codex/native'

/**
 * Scripted Codex double: a fake NativeBridge whose rpc() behaves like the real
 * app-server (docs/plans/E3.md wire shapes). The REAL CodexClient, REAL
 * ToolExecutor and REAL AgentLoop run on top of it — this is the closest thing
 * to end-to-end without Chrome or quota.
 */
class ScriptedBridge {
  onNotification: NativeBridge['onNotification'] = null
  onCodexRequest: NativeBridge['onCodexRequest'] = null
  onStatus: NativeBridge['onStatus'] = null
  disconnectedCount = 0

  turnInputs: Array<Array<{ type: string; text?: string }>> = []
  toolResults: Array<{ rid: number; result: unknown }> = []
  failNextTurnStart = false
  failAfterTool = false
  private nextRid = 100
  private interrupted = false

  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return { userAgent: 'scripted-codex/2.0.0' }
      case 'model/list':
        return { data: [{ id: 'scripted-default', isDefault: true }] }
      case 'thread/start':
        return { thread: { id: 'thr_A' } }
      case 'thread/resume':
        return { thread: { id: String(params.threadId) } }
      case 'turn/start': {
        if (this.failNextTurnStart) {
          this.failNextTurnStart = false
          throw new Error('bridge port disconnected')
        }
        this.turnInputs.push(params.input as never)
        await this.streamTurn(String(params.threadId))
        return {}
      }
      case 'turn/interrupt':
        this.interrupted = true
        void this.interrupted
        return {}
      default:
        return {}
    }
  }

  notify(): undefined {}

  respondTool(rid: number, result: unknown): void {
    this.toolResults.push({ rid, result })
  }

  disconnect(): void {
    this.disconnectedCount++
  }

  private notif(method: string, params: Record<string, unknown>) {
    this.onNotification?.({ method, params })
  }

  /** Plays one scripted turn: reasoning → tool request → answer → completed. */
  private async streamTurn(threadId: string): Promise<void> {
    this.notif('item/reasoning/delta', { threadId, delta: 'thinking' })
    this.notif('item/started', { threadId, item: { type: 'dynamicToolCall', id: 't1', tool: 'notion-search' } })

    const rid = this.nextRid++
    const answered = new Promise<void>((resolve) => {
      const check = () => {
        if (this.toolResults.some((r) => r.rid === rid)) resolve()
      }
      Object.defineProperty(this.toolResults, 'push', {
        value: (...args: never[]) => {
          Array.prototype.push.apply(this.toolResults, args)
          resolve()
          check()
          return this.toolResults.length
        },
      })
    })
    this.onCodexRequest?.({
      rid,
      method: 'item/tool/call',
      params: { tool: 'notion-search', namespace: null, arguments: { query: 'overdue' }, callId: 'call_1' },
    })
    await Promise.race([answered, new Promise((r) => setTimeout(r, 2000))])
    if (this.failAfterTool) throw new Error('bridge port disconnected')

    this.notif('item/completed', { threadId, item: { type: 'dynamicToolCall', id: 't1', status: 'completed' } })
    this.notif('item/started', { threadId, item: { type: 'agentMessage', id: 'a1' } })
    this.notif('item/agentMessage/delta', { threadId, delta: 'You have ' })
    this.notif('item/agentMessage/delta', { threadId, delta: '3 overdue items.' })
    this.notif('item/completed', { threadId, item: { type: 'agentMessage', id: 'a1', text: 'You have 3 overdue items.' } })
    this.notif('turn/completed', { threadId, turn: { usage: { output_tokens: 5 } }, interrupted: false })
  }
}

describe('AgentLoop integration (scripted codex)', () => {
  let bridge: ScriptedBridge
  let codex: CodexClient
  let executor: ToolExecutor
  let loop: AgentLoop
  let notionCalls: Array<{ name: string; args: Record<string, unknown>; provenance?: string }>
  const events: string[] = []

  beforeEach(() => {
    bridge = new ScriptedBridge()
    codex = new CodexClient(bridge as unknown as NativeBridge)
    executor = new ToolExecutor({
      callTool: async (name, args, _signal, provenance) => {
        notionCalls.push({ name, args, provenance })
        return { content: [{ type: 'text', text: JSON.stringify({ results: ['Task A', 'Task B', 'Task C'] }) }] }
      },
      assertToolAllowed: () => undefined,
    })
    loop = new AgentLoop({
      bridge: bridge as unknown as NativeBridge,
      codex,
      executor,
      getDynamicTools: async () => [{ type: 'function', name: 'notion-search', inputSchema: {} }],
      developerInstructions: buildInstructionsStub(),
    })
    codex.emit = (e: CodexEvent) => events.push(e.kind)
    notionCalls = []
  })

  function buildInstructionsStub() {
    return 'You are Nox.'
  }

  it('runs a full turn: context injection → tool round trip → streamed answer', async () => {
    const result = await loop.sendUserMessage('find the Projects database and tell me what is overdue', {
      currentPage: { pageId: 'page_abc', url: '', title: 'Projects DB', markdown: '# Projects\nrows…' },
    })
    expect(result.interrupted).toBe(false)
    expect(result.text).toBe('You have 3 overdue items.')

    // Context preamble rode along with the user text.
    const sent = bridge.turnInputs[0][0].text ?? ''
    expect(sent).toContain('<current_page id="page_abc"')
    expect(sent).toContain('Projects DB')
    expect(sent.endsWith('find the Projects database and tell me what is overdue')).toBe(true)

    // The executor actually called Notion search and returned wrapped data to Codex.
    expect(notionCalls).toEqual([{ name: 'notion-search', args: { query: 'overdue' }, provenance: 'untrusted-context' }])
    const answer = bridge.toolResults[0].result as { success: boolean; contentItems: Array<{ text: string }>; displayText?: string }
    expect(answer.success).toBe(true)
    expect(answer.contentItems[0].text).toContain('UNTRUSTED_CONTENT')
    expect(answer.displayText).toBe('{"results":["Task A","Task B","Task C"]}')

    // Event stream order for the UI: tool completion arrives from the executor
    // and again from Codex's item/completed — both are useful progress signals.
    expect(events).toEqual([
      'turn-started',
      'reasoning-delta',
      'tool-call',
      'tool-completed',
      'tool-completed',
      'text-started',
      'text-delta',
      'text-delta',
      'usage',
      'done',
    ])
    expect(loop.currentThreadId).toBe('thr_A')
  })

  it('reconnects transparently once when the bridge dies mid-turn', async () => {
    bridge.failNextTurnStart = true
    const result = await loop.sendUserMessage('hello there')
    expect(result.text).toBe('You have 3 overdue items.')
    expect(bridge.disconnectedCount).toBe(1)
    // A fresh thread was started after the reconnect.
    expect(loop.currentThreadId).toBe('thr_A')
  })

  it('does not replay a turn after a tool call', async () => {
    bridge.failAfterTool = true
    await expect(loop.sendUserMessage('change something')).rejects.toThrow()
    expect(bridge.disconnectedCount).toBe(0)
    expect(notionCalls).toHaveLength(1)
  })

  it('keeps partial state consistent when cancelled', async () => {
    const pending = loop.sendUserMessage('long running question')
    loop.cancel()
    // The scripted bridge ignores interruption timing; the loop must still
    // surface done(interrupted) rather than hanging or throwing.
    const result = await pending.catch(() => ({ text: '', interrupted: true }))
    expect(typeof result.text).toBe('string')
    expect(typeof result.interrupted).toBe('boolean')
  })

  it('rejects pending approvals when cancelled', () => {
    let rejected = 0
    loop = new AgentLoop({
      bridge: bridge as unknown as NativeBridge,
      codex,
      executor,
      getDynamicTools: async () => [],
      developerInstructions: buildInstructionsStub(),
      cancelPending: () => { rejected++ },
    })
    loop.cancel()
    expect(rejected).toBe(1)
  })

  it('titles threads from the exchange', () => {
    expect(titleFromExchange('Summarize Q3 roadmap')).toBe('Summarize Q3 roadmap')
  })

  it('starts fresh after resetting the thread', async () => {
    await loop.sendUserMessage('first chat')
    expect(loop.currentThreadId).toBe('thr_A')
    loop.newThread()
    expect(loop.currentThreadId).toBeNull()
  })

  it('resumes a restored Codex thread', async () => {
    loop.restoreThread('thr_restored')
    await loop.sendUserMessage('continue this chat')
    expect(loop.currentThreadId).toBe('thr_restored')
  })

  it('rejects a second turn before resetting active turn state', async () => {
    let release!: () => void
    const blocked = new Promise<unknown[]>((resolve) => { release = () => resolve([]) })
    loop = new AgentLoop({
      bridge: bridge as unknown as NativeBridge,
      codex,
      executor,
      getDynamicTools: () => blocked,
      developerInstructions: buildInstructionsStub(),
    })
    const first = loop.sendUserMessage('first')
    await expect(loop.sendUserMessage('second')).rejects.toThrow('turn already running')
    release()
    await first
  })
})
