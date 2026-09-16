import { expect, it } from 'vitest'
import { WriteGate } from '../../src/lib/writes/gate'
import { MutationJournal } from '../../src/lib/writes/journal'
import { ToolExecutor } from '../../src/lib/agent/executor'
import { Scheduler } from '../../src/lib/mcp/scheduler'

const PAGE = 'c'.repeat(32)
const request = (rid: number) => ({ rid, namespace: null, tool: 'notion-update-page', args: { data: { page_id: PAGE }, command: { type: 'update_properties', properties: { title: 'x' } } } })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

it('does not dispatch after authority changes while scheduler is waiting', async () => {
  const scheduler = new Scheduler({ maxConcurrent: 1, globalRps: 1000 })
  const occupied = deferred(), release = deferred(), queued = deferred()
  const blocker = scheduler.schedule('global', async () => { occupied.resolve(); await release.promise })
  await occupied.promise
  let connection = 'old'; let calls = 0
  const journal = new MutationJournal(); journal.setThread('thread')
  const gate = new WriteGate({ journal, getMode: () => 'auto', getContextSet: () => new Set([PAGE]), getSmallEditGrant: () => ({ allowed: true, pages: [PAGE] }), getWorkspaceId: () => 'workspace', ownership: { isOwner: () => true, getOwnerGeneration: () => 'owner', getConnectionGeneration: () => connection }, fetchPageMarkdown: async () => 'text', callTool: (_name, _args, signal, beforeDispatch) => { queued.resolve(); return scheduler.schedule('global', async () => { calls++; return { content: [] } }, signal, { retryable: false, beforeInvoke: beforeDispatch }) } })
  const write = gate.handle(request(1))
  await queued.promise; connection = 'new'; release.resolve(); await Promise.all([blocker, write.catch(() => undefined)])
  expect(calls).toBe(0)
})

it('does not let an old continuation complete a newer read baseline', async () => {
  let body = 'a'.repeat(29_990) + 'OLD'; let writes = 0
  const journal = new MutationJournal(); journal.setThread('thread')
  const gate = new WriteGate({ journal, getMode: () => 'ask', getContextSet: () => new Set([PAGE]), getWorkspaceId: () => 'workspace', ownership: { isOwner: () => true, getOwnerGeneration: () => 'owner', getConnectionGeneration: () => 'conn' }, fetchPageMarkdown: async () => body, callTool: async (name) => { if (name !== 'notion-fetch') writes++; return { content: [{ type: 'text', text: body }] } } })
  const executor = new ToolExecutor({ assertToolAllowed: () => {}, callTool: (name, args, signal) => gate.handle({ rid: 0, namespace: null, tool: name, args, signal }) as any, onModelTruncation: (pageId, delivered, total) => gate.noteModelTruncation(pageId, delivered, total), onModelDelivery: (pageId, offset, end, total, readId) => gate.noteModelDelivery(pageId, offset, end, total, readId), getModelReadId: (pageId) => gate.modelReadId(pageId) })
  executor.beginTurn(); const first = await executor.execute({ rid: 1, namespace: null, tool: 'notion-fetch', args: { id: PAGE } }); const handle = first.contentItems[0].text.match(/handle="([^"]+)/)![1]
  body = 'a'.repeat(29_990) + 'NEW'; await executor.execute({ rid: 2, namespace: null, tool: 'notion-fetch', args: { id: PAGE } }); await executor.execute({ rid: 3, namespace: null, tool: 'nox-read-continuation', args: { handle, offset: 24_000 } })
  const write = gate.handle({ ...request(4), args: { data: { page_id: PAGE }, command: { type: 'replace_content', content: 'replacement' } } }); await new Promise(r => setTimeout(r, 10)); expect(gate.approvals.pendingCount).toBe(0); await write; expect(writes).toBe(0)
})
