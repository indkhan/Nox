// Nox native messaging host: relays JSON-RPC between Chrome and codex app-server.
//
// Extension side framing: 4-byte little-endian length + UTF-8 JSON per message.
// Host → extension is capped at 1 MB; anything larger rides chunk/chunkEnd
// reassembly. Codex side framing: newline-delimited JSON over stdio.
// See PROTOCOL.md for envelope shapes.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { resolveCodex } from './resolve-codex.mjs';

const MAX = 1024 * 1024;
// Raw slices can expand up to ~6x once JSON-escaped inside the envelope
// (e.g. a quote becomes \"), so stay well under the cap.
const SAFE_CHUNK = 256 * 1024;
// Bound for one newline-delimited Codex stdout line, counted in UTF-16 code
// units (JS string length). This is intentionally separate from the byte
// budgets below: inbound native frames are capped at 32 MiB UTF-8 bytes and
// outbound host→extension envelopes at 1 MiB framed bytes, while SAFE_CHUNK
// slices the serialized envelope by UTF-16 units. 8M units comfortably holds
// the 2 MB fixture answer plus large non-ASCII frames (CJK/emoji expand to
// ~2-3 bytes per unit) while bounding memory before a newline arrives.
const MAX_CODEX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_RESTARTS = 5;
const STABLE_RUN_MS = 60_000;

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
  stableTimer: null,
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
    clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => {
      if (state.proc === proc && state.spawnState === 'running') state.restarts = 0;
    }, STABLE_RUN_MS);
    sendToExtension({ t: 'status', state: 'running', detail: { codexPath: info.path, pid: proc.pid } });
  });

  // Streaming UTF-8 decode: chunk boundaries are not character boundaries,
  // so decoder state persists across data events. Both the decoder and the
  // pending line buffer are per-process and reset on restart (a new closure
  // per startCodex call); truncated bytes never carry into the next process.
  const decoder = new StringDecoder('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    // Chunk may arrive as Buffer (no setEncoding) or string; decode
    // incrementally so a 2/3/4-byte sequence split across writes survives.
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (text) {
      if (buf.length + text.length > MAX_CODEX_LINE_CHARS) {
        noteStderr(`codex line exceeded ${MAX_CODEX_LINE_CHARS} chars; discarding ${buf.length} buffered chars`);
        buf = '';
        // Drop this chunk's contribution to the overlong line and resync at
        // the next newline it contains, if any.
        const nlInChunk = text.indexOf('\n');
        if (nlInChunk >= 0) buf = text.slice(nlInChunk + 1);
        // Fall through to frame any complete lines in the resynced buffer.
      } else {
        buf += text;
      }
    }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleCodexLine(line);
      // A single chunk could complete many lines; keep the bound tight.
      if (buf.length > MAX_CODEX_LINE_CHARS) {
        noteStderr(`codex line exceeded ${MAX_CODEX_LINE_CHARS} chars; discarding buffer`);
        buf = '';
        break;
      }
    }
    // Bound the unterminated tail even when no newline arrived yet.
    if (buf.length > MAX_CODEX_LINE_CHARS) {
      noteStderr(`codex line exceeded ${MAX_CODEX_LINE_CHARS} chars without newline; discarding ${buf.length} chars`);
      buf = '';
    }
  });

  proc.stderr.on('data', (d) => noteStderr(d.toString()));

  proc.on('exit', (code, signal) => {
    clearTimeout(state.stableTimer);
    state.stableTimer = null;
    state.proc = null;
    // Truncated final protocol data (a line without its newline, or an
    // incomplete UTF-8 sequence flushed here) is an explicit failure, never
    // silent corruption: pending work already fails below, and the leftover
    // is recorded for diagnosis instead of carried to the next process.
    let tail = '';
    try {
      tail = decoder.end();
    } catch {
      tail = '';
    }
    const leftover = (buf + (tail || '')).trim();
    if (leftover) {
      noteStderr(`codex truncated final line discarded (${leftover.length} chars): ${leftover.slice(0, 200)}`);
    }
    buf = '';
    failAllPending(`codex exited (${code ?? signal})`);
    declineAllIncoming();
    // Crash restart with backoff; the extension re-initializes and resumes threads.
    state.restarts += 1;
    if (state.restarts > MAX_RESTARTS) {
      status('dead', { reason: 'restart budget exhausted', attempts: state.restarts });
      return;
    }
    state.spawnState = 'idle';
    setTimeout(() => startCodex(), Math.min(10_000, 1000 * state.restarts));
    sendToExtension({
      t: 'status',
      state: 'exited',
      detail: { exitCode: code, signal, restarts: state.restarts },
    });
  });

  return state.spawnState;
}

function handleCodexLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    // Malformed protocol data is an explicit diagnostic failure (bounded
    // preview only), never silent corruption of later lines.
    noteStderr(`codex malformed line discarded (${line.length} chars): ${line.slice(0, 200)}`);
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
        : { t: 'resp', cid: pending.cid, result: pending.method === 'config/read' ? publicConfig(m.result) : m.result },
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

// Config inspection is deliberately an allowlist: provider credentials, MCP env,
// headers, hooks, and raw layers must never cross native messaging into Chrome.
function publicConfig(result) {
  if (!result?.config || typeof result.config !== 'object') return {};
  const config = result.config;
  return { config: {
    web_search: config.web_search ?? null,
    mcp_servers: Object.fromEntries(Object.entries(config.mcp_servers ?? {}).map(([name, value]) => [name, { enabled: value?.enabled !== false }])),
  } };
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
      pendingOut.set(outId, { cid: msg.cid, timer, method: msg.method });
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

    default:
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

process.stdin.on('end', () => { state.proc?.kill(); process.exit(0); });
process.on('exit', () => state.proc?.kill());
