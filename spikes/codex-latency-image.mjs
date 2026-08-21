// Remaining Codex unknowns:
//   0.5  latency per model on a trivial prompt (sets the default)
//   cwd  is an explicit cwd honoured? (the bridge must not leak the browser's cwd)
//   img  does image input work via UserInput {type:'image', url:dataurl}?
// Run: node spikes/codex-latency-image.mjs
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { resolveCodex } from '../bridge/resolve-codex.mjs';

// ── build a real 16x16 solid-colour PNG (no fixtures on disk) ──────────────
function solidPng(r, g, b, size = 16) {
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => Buffer.from([r, g, b]))])),
  );
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = solidPng.crcTable ??= Array.from({ length: 256 }, (_, n) => {
      let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
    });
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const log = (...a) => console.log(...a);
const CODEX = resolveCodex();
console.log(`codex binary: ${CODEX.path}  (${CODEX.version})`);
const child = spawn(CODEX.path, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1; const pending = new Map(); let buf = '';
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout ${method}`))), 180000);
  });
}
const notify = (m, p) => send({ method: m, params: p });

let turn = null, onDone = () => {};
child.stdout.on('data', (c) => {
  buf += c.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      continue;
    }
    if (m.method && m.id !== undefined) { send({ id: m.id, result: { decision: 'decline' } }); continue; }
    const p = m.params ?? {};
    if (turn && m.method?.endsWith('/delta') && !turn.first) turn.first = Date.now();
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage') turn && (turn.text = p.item.text ?? '');
    if (m.method === 'error') turn && (turn.error = p.error?.message ?? '');
    if (m.method === 'turn/completed') { turn && (turn.ms = Date.now() - turn.t0); onDone(); }
  }
});
child.stderr.on('data', () => {});

function runTurn(threadId, input) {
  turn = { t0: Date.now(), first: null, text: '', error: null };
  return new Promise(async (resolve) => { onDone = () => resolve(turn); await request('turn/start', { threadId, input }); });
}

(async () => {
  const init = await request('initialize', {
    clientInfo: { name: 'nox-spike', title: 'Nox', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  notify('initialized', {});
  log('codex app-server:', init.userAgent.split(' ')[0]);

  // ── cwd control ──────────────────────────────────────────────────────────
  const safeCwd = tmpdir();
  const tA = await request('thread/start', { model: 'gpt-5.4-mini', sandbox: 'read-only', ephemeral: true });
  const tB = await request('thread/start', { model: 'gpt-5.4-mini', sandbox: 'read-only', ephemeral: true, cwd: safeCwd });
  log(`\ncwd when omitted : ${tA.thread?.cwd}`);
  log(`cwd when set     : ${tB.thread?.cwd}   (asked for ${safeCwd})`);
  log(`→ explicit cwd honoured: ${tB.thread?.cwd === safeCwd ? 'YES' : 'NO'}`);
  log(`ephemeral thread path : ${tA.thread?.path ?? 'null (nothing on disk)'}`);

  // ── latency per model ────────────────────────────────────────────────────
  log('\n── latency: "Reply with exactly: ok" ──');
  const rows = [];
  const allModels = (await request('model/list', {})).data ?? [];
  log('   (models: ' + allModels.map((m) => m.id + (m.isDefault ? '*' : '')).join(', ') + ')');
  for (const model of allModels.map((m) => m.id)) {
    for (const effort of ['low']) {
      const t = await request('thread/start', {
        model, effort, sandbox: 'read-only', ephemeral: true, personality: 'pragmatic',
        developerInstructions: 'You are a terse assistant. Answer in as few words as possible.',
      });
      const r = await runTurn(t.thread?.id ?? t.id, [{ type: 'text', text: 'Reply with exactly: ok' }]);
      rows.push({ model, effort, first: r.first ? r.first - r.t0 : null, total: r.ms, out: (r.text || r.error || '').slice(0, 40) });
      log(`   ${model.padEnd(14)} effort=${effort}  first=${String(rows.at(-1).first ?? '—').padStart(6)}ms  total=${String(r.ms).padStart(6)}ms  "${rows.at(-1).out}"`);
    }
  }

  // ── image input ──────────────────────────────────────────────────────────
  log('\n── image input (16x16 solid blue PNG as a data url) ──');
  const dataUrl = 'data:image/png;base64,' + solidPng(0, 0, 255).toString('base64');
  const ti = await request('thread/start', {
    model: 'gpt-5.4-mini', effort: 'low', sandbox: 'read-only', ephemeral: true,
    developerInstructions: 'Answer in one word.',
  });
  const ri = await runTurn(ti.thread?.id ?? ti.id, [
    { type: 'text', text: 'What colour is this image? One word.' },
    { type: 'image', url: dataUrl },
  ]);
  log(`   answer: "${(ri.text || ri.error || '(nothing)').slice(0, 120)}"  (${ri.ms}ms)`);
  log(`   → image input works: ${/blue/i.test(ri.text) ? 'YES' : 'NO / unclear'}`);

  log('\n════════ VERDICT ════════');
  log(`explicit cwd honoured : ${tB.thread?.cwd === safeCwd ? 'YES' : 'NO'}`);
  log(`ephemeral = no file   : ${tA.thread?.path == null ? 'YES' : 'NO'}`);
  const fastest = rows.filter((r) => r.total).sort((a, b) => a.total - b.total)[0];
  log(`fastest model         : ${fastest?.model} (${fastest?.total}ms total, ${fastest?.first}ms to first token)`);
  log(`image input           : ${/blue/i.test(ri.text) ? 'YES' : 'NO / unclear'}`);
  child.kill(); process.exit(0);
})().catch((e) => { log('FATAL', e.message); child.kill(); process.exit(1); });
