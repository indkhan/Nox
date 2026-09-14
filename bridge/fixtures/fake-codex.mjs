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
// Byte-split write: forces separate stdout data events with the split inside
// the UTF-8 encoding, exercising streaming decoders (Epoch 12 / M11).
async function writeSplit(obj, splitAtByte) {
  const buf = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  const at = splitAtByte ?? Math.floor(buf.length / 2);
  process.stdout.write(buf.subarray(0, at));
  await sleep(5);
  process.stdout.write(buf.subarray(at));
}
// Finds a byte offset one byte inside the first occurrence of `needle` in the
// JSON encoding of `obj`, so the split lands mid-character.
function splitInside(obj, needle) {
  const buf = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  const n = Buffer.from(needle, 'utf8');
  const idx = buf.indexOf(n);
  if (idx < 0) return Math.floor(buf.length / 2);
  return idx + 1;
}

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
    case 'test/crash':
      return process.exit(23);
    case 'test/unicode-split':
      return void unicodeSplit(m);
    case 'test/unicode-tool-args':
      return void unicodeToolArgs(m);
    case 'test/unicode-large':
      return void unicodeLarge(m);
    case 'test/overlong-line':
      return void overlongLine(m);
    case 'test/unicode-eof':
      return void unicodeEof(m);
    case 'initialize':
      return send({ id: m.id, result: { userAgent: 'codex-fixture/0.0.1 (fake)' } });
    case 'config/read':
      return send({ id: m.id, result: { config: { web_search: 'cached', mcp_servers: { private: { enabled: true, env: { TOKEN: 'SECRET_SENTINEL' } } }, model_providers: { x: { api_key: 'SECRET_SENTINEL' } } }, layers: [{ secret: 'SECRET_SENTINEL' }] } });
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

const UNICODE_2BYTE = 'Grüße äöü';
const UNICODE_3BYTE = '中文 €';
const UNICODE_4BYTE = '😀 𝄞';

async function unicodeSplit(m) {
  const id = m.id;
  const n1 = { method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u2', delta: UNICODE_2BYTE } };
  const n2 = { method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u3', delta: UNICODE_3BYTE } };
  const n3 = { method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u4', delta: UNICODE_4BYTE } };
  await writeSplit(n1, splitInside(n1, 'ü'));
  await writeSplit(n2, splitInside(n2, '€'));
  await writeSplit(n3, splitInside(n3, '😀'));
  send({ id, result: { ok: true, echo: `${UNICODE_2BYTE}|${UNICODE_3BYTE}|${UNICODE_4BYTE}` } });
}

async function unicodeToolArgs(m) {
  const id = m.id;
  const title = `${UNICODE_2BYTE} ${UNICODE_3BYTE} ${UNICODE_4BYTE}`;
  const callId = 9100 + Math.floor(Math.random() * 100000);
  const req = {
    id: callId,
    method: 'item/tool/call',
    params: { tool: 'notion_fetch', namespace: null, arguments: { title }, callId: 'call_unicode', threadId: 'thr_1' },
  };
  await writeSplit(req, splitInside(req, '😀'));
  const gotAnswer = await Promise.race([
    new Promise((resolve) => {
      const handler = (line) => {
        let m2;
        try { m2 = JSON.parse(line); } catch { return; }
        if (m2.id === callId && m2.result !== undefined) resolve(true);
      };
      rl.on('line', handler);
      setTimeout(() => rl.off('line', handler), 10_000).unref();
    }),
    sleep(10_000).then(() => false),
  ]);
  if (!gotAnswer) {
    send({ id, error: { code: -32000, message: 'fixture: no tool response for unicode args' } });
    return;
  }
  send({ id, result: { ok: true, echo: title } });
}

async function unicodeLarge(m) {
  const id = m.id;
  // ~768K UTF-16 units (~1.5 MB UTF-8): large non-ASCII in one logical line.
  const big = 'é'.repeat(256 * 1024) + '中'.repeat(128 * 1024) + '😀'.repeat(64 * 1024);
  const notif = { method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u-large', delta: big } };
  const buf = Buffer.from(JSON.stringify(notif) + '\n', 'utf8');
  const STEP = 16 * 1024;
  for (let off = 0; off < buf.length; off += STEP) {
    process.stdout.write(buf.subarray(off, off + STEP));
    await sleep(1);
  }
  send({ id, result: { ok: true, chars: big.length } });
}

async function overlongLine(m) {
  const id = m.id;
  // 9M 'x' without a newline: exceeds the bridge line cap and must be
  // discarded without unbounded growth; the following valid line must work.
  process.stdout.write('x'.repeat(9 * 1024 * 1024));
  await sleep(10);
  process.stdout.write('\n');
  await sleep(5);
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u-after-overlong', delta: 'after-overlong-ok' } });
  send({ id, result: { ok: true } });
}

async function unicodeEof(m) {
  // Write half a multi-byte line (split inside 😀, no newline) then exit:
  // the bridge must discard the truncated bytes on restart, never forward
  // corrupted JSON.
  const notif = { method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'u-eof', delta: `eof ${UNICODE_4BYTE}` } };
  const buf = Buffer.from(JSON.stringify(notif) + '\n', 'utf8');
  const at = splitInside(notif, '😀');
  process.stdout.write(buf.subarray(0, at));
  await sleep(10);
  process.exit(23);
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
