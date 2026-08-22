// A fake `codex app-server` for deterministic bridge tests — speaks the exact
// wire protocol verified in spike 0.2 (docs/plans/E3.md). Streams a scripted
// turn with a tool round trip and a >1 MB agentMessage to exercise chunking.
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('codex-fixture 0.0.1');
  process.exit(0);
}

const BIG_CHARS = 2 * 1024 * 1024;
const bigText = 'y'.repeat(BIG_CHARS);

const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  // server → client request answered by the client (tool round trip)
  if (m.result !== undefined && m.id !== undefined) return; // our own response echo guard
  if (m.method === undefined && m.id !== undefined) {
    // This is the client answering item/tool/call; nothing to do.
    return;
  }

  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { userAgent: 'codex-fixture/0.0.1 (fake)' } });
    case 'model/list':
      return send({
        id: m.id,
        result: {
          data: [{
            id: 'fixture-large',
            isDefault: true,
            displayName: 'Fixture Large',
            description: 'Streams 2 MB answers',
            inputModalities: ['text'],
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          }],
        },
      });
    case 'thread/start':
      return send({ id: m.id, result: { thread: { id: 'thr_1', ephemeral: false, path: null, cwd: process.cwd() } } });
    case 'thread/resume':
      return send({ id: m.id, result: { thread: { id: m.params?.threadId ?? 'thr_1', ephemeral: false, path: null } } });
    case 'turn/start':
      return runTurn(m);
    case 'turn/interrupt':
      interrupted = true;
      return;
    default:
      if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});

let interrupted = false;

function notify(method, params) {
  send({ method, params });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function runTurn(startMsg) {
  const id = startMsg.id;
  const threadId = startMsg.params?.threadId ?? 'thr_1';
  notify('item/started', { threadId, item: { type: 'reasoning', id: 'r1' } });
  notify('item/reasoning/delta', { threadId, delta: 'thinking…' });
  notify('item/completed', { threadId, item: { type: 'reasoning', id: 'r1', text: 'thinking…done' } });

  notify('item/started', { threadId, item: { type: 'dynamicToolCall', id: 't1', tool: 'notion_fetch' } });
  // Server asks the client to execute a tool; wait for the answer.
  const callId = 9000 + Math.floor(Math.random() * 100000);
  send({
    id: callId,
    method: 'item/tool/call',
    params: { tool: 'notion_fetch', namespace: null, arguments: { page_id: 'abc123' }, callId: 'call_1', threadId },
  });

  const gotAnswer = await Promise.race([
    new Promise((resolve) => {
      const handler = (line) => {
        let m2;
        try { m2 = JSON.parse(line); } catch { return; }
        if (m2.id === callId && m2.result !== undefined) resolve(m2.result.success === true);
      };
      rl.on('line', handler);
      setTimeout(() => rl.off('line', handler), 10_000).unref();
    }),
    sleep(10_000).then(() => false),
  ]);
  if (!gotAnswer) {
    send({ id, error: { code: -32000, message: 'fixture: no tool response from client' } });
    return;
  }
  notify('item/completed', { threadId, item: { type: 'dynamicToolCall', id: 't1', status: 'completed' } });

  notify('item/started', { threadId, item: { type: 'agentMessage', id: 'a1' } });
  const STEP = 64 * 1024;
  for (let off = 0; off < bigText.length; off += STEP) {
    if (interrupted) break;
    notify('item/agentMessage/delta', { threadId, delta: bigText.slice(off, off + STEP) });
    await sleep(1);
  }
  notify('item/completed', {
    threadId,
    item: { type: 'agentMessage', id: 'a1', text: interrupted ? '(interrupted)' : bigText },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { usage: { input_tokens: 3, output_tokens: 4 } }, interrupted },
  });
}
