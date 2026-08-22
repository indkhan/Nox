// Bridge integration checks — simulates Chrome's native-messaging framing and
// drives the real nox-bridge.mjs against a fake codex app-server (deterministic,
// no quota). Run: node bridge/test-bridge.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';
import { resolveCodex } from './resolve-codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [join(HERE, 'nox-bridge.mjs')],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CODEX_BIN: process.env.CODEX_BIN ?? join(HERE, 'fixtures', 'fake-codex.mjs') },
  },
);

const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
};

const messages = [];
const chunkFrames = []; // raw {t:'chunk'} frames, retained for cap assertions
const chunkBuffers = new Map(); // chunkId → {parts}
let buf = Buffer.alloc(0);
child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const frame = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    if (frame.t === 'chunk') {
      chunkFrames.push(frame);
      const entry = chunkBuffers.get(frame.id) ?? { parts: [] };
      entry.parts.push(frame.data);
      chunkBuffers.set(frame.id, entry);
    } else if (frame.t === 'chunkEnd') {
      const entry = chunkBuffers.get(frame.id) ?? { parts: [] };
      const joined = entry.parts.join('');
      assert.equal(joined.length, frame.totalChars, 'chunk reassembly size mismatch');
      chunkBuffers.delete(frame.id);
      try {
        messages.push(JSON.parse(joined));
      } catch {
        throw new Error('reassembled chunk did not parse as JSON');
      }
      messages.push(frame); // keep the raw end marker for assertions
    } else if (frame.t === undefined && frame.type === 'chunkEnd') {
      messages.push(frame); // legacy mode keeps its own shape
    } else {
      messages.push(frame);
    }
  }
});

const waitFor = async (predicate, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`bridge test timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ── 1. health ────────────────────────────────────────────────────────────────
send({ t: 'ping' });
send({ t: 'start' });
await waitFor((m) => m.t === 'pong', 'pong');
console.log('✔ ping/pong ok');

// ── 2. initialize round trip through the relay ───────────────────────────────
send({ t: 'rpc', cid: 'c1', method: 'initialize', params: { clientInfo: { name: 'nox-test' }, capabilities: { experimentalApi: true } } });
const initResp = await waitFor((m) => m.t === 'resp' && m.cid === 'c1', 'initialize response');
assert(initResp.result?.userAgent?.includes('codex-fixture'), `unexpected userAgent: ${initResp.result?.userAgent}`);
send({ t: 'notify', method: 'initialized', params: {} });
console.log(`✔ initialize relayed → ${initResp.result.userAgent}`);

// ── 3. model/list ────────────────────────────────────────────────────────────
send({ t: 'rpc', cid: 'c2', method: 'model/list', params: {} });
const models = await waitFor((m) => m.t === 'resp' && m.cid === 'c2', 'model list');
assert.equal(models.result.data[0].id, 'fixture-large');
console.log('✔ model/list relayed');

// ── 4. thread/start + full turn with tool call and a 2 MB message ────────────
send({ t: 'rpc', cid: 'c3', method: 'thread/start', params: { model: 'fixture-large', effort: 'low', ephemeral: false, sandbox: 'read-only' } });
const thread = await waitFor((m) => m.t === 'resp' && m.cid === 'c3', 'thread start');
const threadId = thread.result.thread.id;
assert.equal(threadId, 'thr_1');

send({ t: 'rpc', cid: 'c4', method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'go' }] } });

// The fixture asks us to execute a tool; answer like the extension would.
const toolReq = await waitFor((m) => m.t === 'req' && m.method === 'item/tool/call', 'tool request');
assert.equal(toolReq.params.tool, 'notion_fetch');
send({ t: 'tool-response', rid: toolReq.rid, result: { success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] } });

const turnDone = await waitFor((m) => m.t === 'notif' && m.method === 'turn/completed', 'turn completion');
assert.equal(turnDone.params.turn.usage.input_tokens, 3);
const agentCompleted = await waitFor(
  (m) => m.t === 'notif' && m.method === 'item/completed' && m.params.item?.type === 'agentMessage',
  'agentMessage completion',
);
assert.equal(agentCompleted.params.item.text.length, 2 * 1024 * 1024, 'big text arrived intact');

// The oversized completion must have been chunked under the cap.
assert(chunkFrames.length > 0, 'expected chunked frames for oversized envelopes');
for (const c of chunkFrames) {
  const framed = Buffer.byteLength(JSON.stringify(c), 'utf8');
  assert(framed < 1024 * 1024, `chunk frame ${framed} exceeds the cap`);
}
const deltas = messages.filter((m) => m.t === 'notif' && m.method === 'item/agentMessage/delta');
const streamed = deltas.map((d) => d.params.delta).join('');
assert.equal(streamed.length, 2 * 1024 * 1024, 'streamed deltas reassemble to the full text');
console.log(`✔ turn relayed: tool round trip + ${deltas.length} deltas (${(streamed.length / 1048576).toFixed(1)} MB) via ${chunkFrames.length} chunk frames`);

// ── 5. legacy framing self-test (raw oversized payload mode) ─────────────────
const chunkFramesBefore = chunkFrames.length;
send({ type: 'big', bytes: 2 * 1024 * 1024, mode: 'chunked', id: 7 });
const legacy = await waitFor((m) => m.legacyBig === true, 'legacy big payload');
assert.equal(legacy.payload.length, 2 * 1024 * 1024);
assert(chunkFrames.length > chunkFramesBefore, 'legacy payload rode chunk framing too');
console.log(`✔ legacy 2 MB payload delivered via ${chunkFrames.length - chunkFramesBefore} additional chunk frames`);

// ── 6. crash restart ──
const runningBefore = messages.filter((m) => m.t === 'status' && m.state === 'running').length;
send({ t: 'rpc', cid: 'crash', method: 'test/crash', params: {} });
await waitFor(
  () => messages.filter((m) => m.t === 'status' && m.state === 'running').length > runningBefore,
  'codex restart after crash',
  5000,
);
send({ t: 'rpc', cid: 'after-crash', method: 'model/list', params: {} });
await waitFor((m) => m.t === 'resp' && m.cid === 'after-crash', 'response after crash restart', 5000);
console.log('✔ codex restarted after crash');

// Repeated crashes exhaust the consecutive restart budget.
for (let i = 0; i < 3; i++) {
  const before = messages.filter((m) => m.t === 'status' && m.state === 'running').length;
  send({ t: 'rpc', cid: `crash-${i}`, method: 'test/crash', params: {} });
  await waitFor(
    () => messages.filter((m) => m.t === 'status' && m.state === 'running').length > before,
    `restart ${i + 2}`,
    6000,
  );
}
send({ t: 'rpc', cid: 'final-crash', method: 'test/crash', params: {} });
await waitFor((m) => m.t === 'status' && m.state === 'dead', 'restart budget exhaustion', 7000);
console.log('✔ repeated crashes exhaust restart budget');

child.kill();
console.log('\nall bridge checks passed');
process.exit(0);
