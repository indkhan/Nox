// Nox native messaging host.
// Chrome frames every message as 4-byte little-endian length + UTF-8 JSON.
// Host → extension is capped at 1 MB; extension → host at 64 MiB (RESEARCH §3.5),
// which is why anything large goes out as chunks.
import { execFileSync } from 'node:child_process';

const MAX = 1024 * 1024;
const SAFE_CHUNK = 512 * 1024; // comfortably under the cap once JSON-escaped

function write(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendChunked(id, text) {
  for (let i = 0; i < text.length; i += SAFE_CHUNK) {
    write({ type: 'chunk', id, data: text.slice(i, i + SAFE_CHUNK) });
  }
  write({ type: 'chunkEnd', id, totalChars: text.length, chunks: Math.ceil(text.length / SAFE_CHUNK) });
}

function codexInfo() {
  try {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
    return { found: true, version };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

function handle(msg) {
  switch (msg?.type) {
    case 'ping':
      return write({
        type: 'pong',
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        codex: codexInfo(),
        maxMessageBytes: MAX,
      });

    case 'big': {
      const bytes = Math.min(msg.bytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024);
      const payload = 'x'.repeat(bytes);
      if (msg.mode === 'chunked') return sendChunked(msg.id ?? 1, payload);
      // Raw: deliberately oversized. Chrome should drop the port. That is the point.
      return write({ type: 'bigRaw', bytes, payload });
    }

    default:
      return write({ type: 'error', error: `unknown message type: ${msg?.type}` });
  }
}

// ── stdin framing ──────────────────────────────────────────────────────────
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    try { handle(JSON.parse(body.toString('utf8'))); }
    catch (e) { write({ type: 'error', error: String(e) }); }
  }
});

process.stdin.on('end', () => process.exit(0));
