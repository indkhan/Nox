// Runnable check for the bridge's framing — the one bit of non-trivial logic here.
// Simulates Chrome: 4-byte LE length prefix + JSON, both directions.
// Run: node bridge/test-bridge.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(HERE, 'nox-bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
};

const messages = [];
let buf = Buffer.alloc(0);
child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    messages.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
    buf = buf.subarray(4 + len);
  }
});

send({ type: 'ping' });
send({ type: 'big', bytes: 2 * 1024 * 1024, mode: 'chunked', id: 7 });

setTimeout(() => {
  child.kill();

  const pong = messages.find((m) => m.type === 'pong');
  assert(pong, 'no pong received');
  assert.equal(pong.maxMessageBytes, 1024 * 1024);
  console.log('✔ ping/pong framing ok — node', pong.node, '| codex', pong.codex.found ? pong.codex.version : 'NOT FOUND');

  const chunks = messages.filter((m) => m.type === 'chunk' && m.id === 7);
  const end = messages.find((m) => m.type === 'chunkEnd' && m.id === 7);
  assert(end, 'no chunkEnd received');
  const assembled = chunks.map((c) => c.data).join('');
  assert.equal(assembled.length, 2 * 1024 * 1024, 'reassembled size mismatch');
  assert.equal(chunks.length, end.chunks, 'chunk count mismatch');
  for (const c of chunks) {
    const framed = Buffer.byteLength(JSON.stringify(c), 'utf8');
    assert(framed < 1024 * 1024, `chunk ${framed} bytes exceeds the 1 MB cap`);
  }
  console.log(`✔ 2 MB chunked into ${chunks.length} messages, largest well under 1 MB, reassembled exactly`);
  console.log('\nall bridge checks passed');
  process.exit(0);
}, 2500);
