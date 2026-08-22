// Nox native messaging host: relays JSON-RPC between Chrome and codex app-server.
//
// Extension side framing: 4-byte little-endian length + UTF-8 JSON per message.
// Host → extension is capped at 1 MB; anything larger rides chunk/chunkEnd
// reassembly. Codex side framing: newline-delimited JSON over stdio.
// See PROTOCOL.md for envelope shapes.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveCodex } from './resolve-codex.mjs';

const MAX = 1024 * 1024;
// Raw slices can expand up to ~6x once JSON-escaped inside the envelope
// (e.g. a quote becomes \"), so stay well under the cap.
const SAFE_CHUNK = 256 * 1024;
const MAX_RESTARTS = 5;

let nextChunkId = 1;
let nextOutId = 1;

/** cid → {timer}; bridge-assigned integer id ↔ caller correlation id. */
const pendingOut = new Map();
/** Codex request id → true (we forwarded it and await tool-response). */
const pendingIn = new Set();

const state = {
  proc: null,
  spawnState: 'idle', // idle | spawning | running | restarting | dead
  restarts: 0,
  startedAt: 0,
  stderrTail: '',
};

function write(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendToExtension(envelope) {
  const text = JSON.stringify(envelope);
  if (text.length <= SAFE_CHUNK) return write(JSON.parse(text));
  const id = nextChunkId++;
  let chunks = 0;
  for (let i = 0; i < text.length; i += SAFE_CHUNK) {
    write({ t: 'chunk', id, data: text.slice(i, i + SAFE_CHUNK) });
    chunks++;
  }
  write({ t: 'chunkEnd', id, totalChars: text.length, chunks });
}

function status(stateName, detail = {}) {
  state.spawnState = stateName;
  sendToExtension({ t: 'status', state: stateName, detail });
}

function noteStderr(text) {
  state.stderrTail = (state.stderrTail + text).slice(-4096);
}

function codexInfo() {
  const codex = resolveCodex();
  return codex.path
    ? { found: true, version: codex.version, path: codex.path, launcher: codex.launcher ?? null }
    : { found: false, error: 'Codex not found' };
}

// ── codex process lifecycle ──────────────────────────────────────────────────

export function startCodex({ force = false } = {}) {
  if (state.proc && !force) return state.spawnState;
  if (state.restarts >= MAX_RESTARTS) {
    status('dead', { reason: 'restart budget exhausted', attempts: state.restarts });
    return state.spawnState;
  }
  if (state.spawnState === 'restarting') return state.spawnState;

  const info = codexInfo();
  if (!info.found) {
    status('dead', { reason: 'codex-missing', error: info.error });
    return state.spawnState;
  }

  status(state.proc ? 'restarting' : 'spawning', { attempt: state.restarts + 1, codexPath: info.path });
  state.spawnState = 'restarting';

  // Explicit non-writable cwd — omitting it makes the thread inherit whatever
  // directory the browser launched us from (RESEARCH §3.4, spike-verified).
  // Node-script candidates (test fixtures) launch through the interpreter.
  const cmd = info.launcher ?? info.path;
  const args = info.launcher ? [info.path, 'app-server'] : ['app-server'];
  const proc = spawn(cmd, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
  state.proc = proc;
  state.startedAt = Date.now();

  proc.on('spawn', () => {
    state.spawnState = 'running';
    state.restarts = 0;
    sendToExtension({ t: 'status', state: 'running', detail: { codexPath: info.path, pid: proc.pid } });
  });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleCodexLine(line);
    }
  });

  proc.stderr.on('data', (d) => noteStderr(d.toString()));

  proc.on('exit', (code, signal) => {
    state.proc = null;
    failAllPending(`codex exited (${code ?? signal})`);
    declineAllIncoming();
    sendToExtension({
      t: 'status',
      state: 'exited',
      detail: { exitCode: code, signal, restarts: state.restarts },
    });
    // Crash restart with backoff; the extension re-initializes and resumes threads.
    state.restarts += 1;
    if (state.restarts > MAX_RESTARTS) {
      status('dead', { reason: 'restart budget exhausted', attempts: state.restarts });
      return;
    }
    state.spawnState = 'idle';
    setTimeout(() => startCodex(), Math.min(10_000, 1000 * state.restarts));
  });

  return state.spawnState;
}

function handleCodexLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }

  // A response to something we sent.
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const pending = pendingOut.get(m.id);
    if (!pending) return;
    pendingOut.delete(m.id);
    clearTimeout(pending.timer);
    sendToExtension(
      m.error
        ? { t: 'resp', cid: pending.cid, error: m.error }
        : { t: 'resp', cid: pending.cid, result: m.result },
    );
    return;
  }

  // A server→client request (item/tool/call and friends).
  if (m.method && m.id !== undefined) {
    pendingIn.add(m.id);
    sendToExtension({ t: 'req', rid: m.id, method: m.method, params: m.params });
    return;
  }

  if (m.method) sendToExtension({ t: 'notif', method: m.method, params: m.params ?? {} });
}

function toStdin(obj) {
  state.proc?.stdin?.write(JSON.stringify(obj) + '\n');
}

function failAllPending(reason) {
  for (const [id, pending] of [...pendingOut.entries()]) {
    clearTimeout(pending.timer);
    sendToExtension({ t: 'resp', cid: pending.cid, error: { code: -32098, message: reason } });
    pendingOut.delete(id);
  }
}

function declineAllIncoming() {
  for (const rid of [...pendingIn]) {
    toStdin({ id: rid, result: { decision: 'decline' } });
    pendingIn.delete(rid);
  }
}

// ── extension message handling ───────────────────────────────────────────────

function pong() {
  return {
    t: 'pong',
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    codex: codexInfo(),
    spawn: {
      state: state.spawnState,
      restarts: state.restarts,
      uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
    },
    stderrTail: state.stderrTail.slice(-200),
    maxMessageBytes: MAX,
  };
}

function handle(msg) {
  switch (msg?.t) {
    case 'ping':
      // Echo the caller's cid so the extension can correlate health checks.
      write({ ...pong(), ...(msg.cid !== undefined ? { __cid: String(msg.cid) } : {}) });
      return;

    case 'rpc': {
      startCodex();
      if (!state.proc || state.proc.stdin.destroyed) {
        return sendToExtension({
          t: 'resp',
          cid: msg.cid,
          error: { code: -32099, message: `codex not running (state=${state.spawnState})` },
        });
      }
      const outId = nextOutId++;
      const timer = setTimeout(() => {
        if (!pendingOut.delete(outId)) return;
        sendToExtension({
          t: 'resp',
          cid: msg.cid,
          error: { code: -32097, message: `bridge timeout waiting for ${msg.method}` },
        });
      }, msg.timeoutMs ?? 600_000);
      pendingOut.set(outId, { cid: msg.cid, timer });
      toStdin({ id: outId, method: msg.method, params: msg.params ?? {} });
      return;
    }

    case 'notify':
      toStdin({ method: msg.method, params: msg.params ?? {} });
      return;

    case 'tool-response':
      if (pendingIn.has(msg.rid)) {
        pendingIn.delete(msg.rid);
        toStdin({ id: msg.rid, result: msg.result ?? { decision: 'decline' } });
      }
      return;

    case 'start':
      startCodex();
      return;

    // Legacy diagnostics modes retained from E0 (old `type`-keyed messages).
    case 'big':
    case undefined:
      if (msg?.type === 'big' || msg?.t === 'big') {
        const bytes = Math.min(msg.bytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024);
        const payload = 'x'.repeat(bytes);
        if (msg.mode === 'chunked') return sendToExtension({ legacyBig: true, bytes, payload });
        return write({ type: 'bigRaw', bytes, payload });
      }
      if (msg?.t === undefined && msg?.ping !== undefined) return write(pong());
      return write({ type: 'error', error: `unknown message type: ${JSON.stringify(msg?.t ?? msg?.type ?? msg)}` });
  }
}

// ── stdin framing ────────────────────────────────────────────────────────────
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (len > 32 * 1024 * 1024) {
      write({ type: 'error', error: `frame too large: ${len}` });
      process.exit(1);
    }
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    try {
      handle(JSON.parse(body.toString('utf8')));
    } catch (e) {
      write({ type: 'error', error: String(e) });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
