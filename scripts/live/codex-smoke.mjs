// LIVE bridge smoke: drives the real nox-bridge against the REAL codex binary.
// One trivial turn (~minimal quota). Run: node scripts/live/codex-smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const child = spawn(process.execPath, [join(ROOT, 'bridge', 'nox-bridge.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
};

const messages = [];
const chunks = new Map();
let buf = Buffer.alloc(0);
let nextCid = 0;
const pending = new Map();

child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    let frame = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    if (frame.t === 'chunk') {
      const e = chunks.get(frame.id) ?? [];
      e.push(frame.data);
      chunks.set(frame.id, e);
      continue;
    }
    if (frame.t === 'chunkEnd') {
      frame = JSON.parse((chunks.get(frame.id) ?? []).join(''));
      chunks.delete(frame.id);
    }
    messages.push(frame);
    if (frame.t === 'resp' && pending.has(frame.cid)) pending.get(frame.cid)(frame);
  }
});

function rpc(method, params) {
  const cid = `c${++nextCid}`;
  send({ t: 'rpc', cid, method, params });
  return new Promise((resolve, reject) => {
    pending.set(cid, (frame) => {
      pending.delete(cid);
      frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result);
    });
    setTimeout(() => reject(new Error(`timeout ${method}`)), 120_000).unref();
  });
}

const waitFor = async (predicate, label) => {
  for (let i = 0; i < 3000; i++) {
    const m = messages.find(predicate);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`smoke timed out waiting for ${label}`);
};

// 1. health
send({ t: 'ping', cid: 'ping1' });
const pong = await waitFor((m) => m.t === 'pong' && m.__cid === 'ping1', 'pong');
console.log('host   :', pong.node, '| codex', pong.codex.found ? pong.codex.version : pong.codex.error);

// 2. initialize
send({ t: 'start' });
await waitFor((m) => m.t === 'status' && m.state === 'running', 'running status');
const init = await rpc('initialize', { clientInfo: { name: 'nox-live', title: 'Nox', version: '0.1.0' }, capabilities: { experimentalApi: true } });
console.log('codex  :', init.userAgent);

// 3. models
const models = await rpc('model/list', {});
const list = models.data ?? [];
console.log('models :', list.map((m) => m.id).join(', ') || '(none)');

// 4. thread + one tiny turn
const thread = await rpc('thread/start', { effort: 'low', ephemeral: false, sandbox: 'read-only', approvalPolicy: 'never' });
const threadId = thread.thread?.id ?? thread.id;
console.log('thread :', threadId);

let finalText = '';
let completed = false;
const turnPromise = rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly: OK' }] });
for (let i = 0; i < 1200 && !completed; i++) {
  for (const m of messages.splice(0)) {
    if (m.t === 'notif' && m.method?.startsWith('item/agentMessage/delta')) finalText += m.params.delta;
    if (m.t === 'notif' && m.method === 'item/completed' && m.params.item?.type === 'agentMessage' && m.params.item.text) finalText = m.params.item.text;
    if (m.t === 'req' && m.method === 'item/tool/call') send({ t: 'tool-response', rid: m.rid, result: { decision: 'decline' } });
    if (m.t === 'notif' && m.method === 'error') console.log('error  :', JSON.stringify(m.params).slice(0, 200));
    if (m.t === 'notif' && m.method === 'turn/completed') completed = true;
  }
  if (!completed) await new Promise((r) => setTimeout(r, 100));
}
await turnPromise;
console.log('answer :', finalText.slice(0, 120) || '(no text)');
child.kill();
process.exit(completed && finalText.trim().length > 0 ? 0 : 1);
