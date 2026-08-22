import type { ThreadRepository } from './repository'

export async function startPersistedTurn(
  repo: ThreadRepository,
  threadId: string | null,
  userText: string,
) {
  const id = threadId ?? (await repo.createThread()).id
  await repo.appendMessage(id, { role: 'user', text: userText })
  const assistantId = crypto.randomUUID()
  let pending = Promise.resolve<unknown>(undefined)
  return {
    threadId: id,
    persistAssistant(text: string, usage?: Record<string, number>) {
      pending = pending.then(() => repo.appendMessage(id, { id: assistantId, role: 'assistant', text, usage }))
      return pending
    },
  }
}
