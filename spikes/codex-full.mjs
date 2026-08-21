// Spikes 0.2 + 0.5 + web search, in one run.
//   1. Does Codex actually call back into the client via item/tool/call? (0.2 — the big one)
//   2. Which models does the subscription expose, and how slow are they? (0.5)
//   3. Does Codex's own web search fire, and does it show up as an item we can render?
// Run: node spikes/codex-full.mjs [model]
import { spawn } from 'node:child_process';

const MODEL = process.argv[2] || null; // null = account default
const log = (...a) => console.log(...a);
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buf = '';

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout ${method}`))), 180000);
  });
}
const notify = (method, params) => send({ method, params });
const respond = (id, result) => send({ id, result });

// ── per-turn observation ───────────────────────────────────────────────────
let turn = null;
function newTurn(name) {
  turn = { name, t0: Date.now(), firstDelta: null, toolCalls: [], items: [], text: '', error: null, webSearches: 0 };
  return turn;
}
let onTurnDone = () => {};

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }

    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      continue;
    }

    // server → client request
    if (m.method && m.id !== undefined) {
      if (m.method === 'item/tool/call') {
        const { tool, namespace, arguments: args, callId } = m.params;
        turn?.toolCalls.push({ tool, namespace, args });
        log(`   ⇐ item/tool/call  tool=${tool} ns=${namespace} args=${JSON.stringify(args)}`);
        respond(m.id, {
          success: true,
          contentItems: [{
            type: 'inputText',
            text: JSON.stringify({ page_id: args?.page_id, title: 'Second Brain', status: 'In Progress', owner: 'Usman' }),
          }],
        });
        log(`   ⇒ returned a fake Notion result for callId=${callId}`);
      } else {
        respond(m.id, { decision: 'decline' });
      }
      continue;
    }

    if (!m.method) continue;
    const p = m.params ?? {};
    if (m.method.startsWith('item/') && m.method.endsWith('/delta')) {
      if (turn && !turn.firstDelta) turn.firstDelta = Date.now();
    }
    if (m.method === 'item/started' || m.method === 'item/completed') {
      const it = p.item ?? {};
      if (m.method === 'item/started' && it.type) turn?.items.push(it.type);
      if (it.type === 'webSearch' && m.method === 'item/started') {
        turn && turn.webSearches++;
        log(`   ⇐ webSearch: ${JSON.stringify(it).slice(0, 200)}`);
      }
      if (m.method === 'item/completed' && it.type === 'agentMessage') turn && (turn.text = it.text ?? '');
    }
    if (m.method === 'error') { turn && (turn.error = p.error?.message ?? JSON.stringify(p)); }
    if (m.method === 'turn/completed') {
      if (turn) { turn.ms = Date.now() - turn.t0; turn.usage = p.turn?.usage ?? p.usage ?? null; }
      onTurnDone();
    }
  }
});
child.stderr.on('data', (d) => { const s = d.toString(); if (/ERROR|panic/i.test(s)) process.stderr.write('[stderr] ' + s); });

function runTurn(name, threadId, text) {
  newTurn(name);
  return new Promise(async (resolve) => {
    onTurnDone = () => resolve(turn);
    await request('turn/start', { threadId, input: [{ type: 'text', text }] });
  });
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  const init = await request('initialize', {
    clientInfo: { name: 'nox-spike', title: 'Nox', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  notify('initialized', {});
  log('codex:', init.userAgent);

  const models = await request('model/list', {});
  log('\nmodels available:');
  for (const m of models.data ?? []) {
    log(`   ${m.id.padEnd(22)} default=${!!m.isDefault} modalities=${(m.inputModalities ?? []).join(',')}` +
        ` efforts=${(m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).join('/')}`);
  }
  const model = MODEL ?? (models.data ?? []).find((m) => m.isDefault)?.id ?? 'gpt-5.5';
  log(`using model: ${model}\n`);

  const dynamicTools = [{
    type: 'function',
    name: 'notion_fetch',
    description: 'Fetch a Notion page by its id. Returns the page title, status and owner.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'The 32-character Notion page id' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  }];

  const threadParams = {
    dynamicTools,
    model,
    effort: 'low',
    ephemeral: false,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    personality: 'pragmatic',
    developerInstructions:
      'You are Nox, an assistant for a Notion workspace. You are NOT a coding agent and have no ' +
      'filesystem. Your only tool is notion_fetch. When asked about a Notion page, call notion_fetch ' +
      'with the id, then answer in one short sentence using the result.',
  };

  const t = await request('thread/start', threadParams);
  const threadId = t.thread?.id ?? t.id;
  log(`thread ${threadId}  (ephemeral=${t.thread?.ephemeral}, path=${t.thread?.path ? 'on disk' : 'none'})`);
  log(`thread cwd: ${t.thread?.cwd}\n`);

  log('── test 1: does Codex call our tool? ──');
  const r1 = await runTurn('tool', threadId,
    'What is the status of Notion page 1a2b3c4d5e6f7890abcdef1234567890?');
  log(`   items: ${r1.items.join(', ') || '(none)'}`);
  log(`   answer: ${(r1.text || r1.error || '(nothing)').slice(0, 300)}`);
  log(`   ${r1.ms}ms total, first delta at ${r1.firstDelta ? r1.firstDelta - r1.t0 : '—'}ms\n`);

  log('── test 2: web search ──');
  const r2 = await runTurn('web', threadId,
    'Search the web: what is the current stable version of the Notion MCP server, and when was it announced? Cite a URL.');
  log(`   items: ${r2.items.join(', ') || '(none)'}`);
  log(`   webSearch items: ${r2.webSearches}`);
  log(`   answer: ${(r2.text || r2.error || '(nothing)').slice(0, 500)}`);
  log(`   ${r2.ms}ms total\n`);

  log('════════ VERDICT ════════');
  log(`0.2  item/tool/call round trip : ${r1.toolCalls.length ? 'YES — ' + JSON.stringify(r1.toolCalls) : 'NO'}`);
  log(`     answer used tool result   : ${/in progress/i.test(r1.text) ? 'YES' : 'unclear'}`);
  log(`0.5  model                     : ${model}`);
  log(`     latency (tool turn)       : ${r1.ms}ms`);
  log(`     latency (web turn)        : ${r2.ms}ms`);
  log(`web  search fired              : ${r2.webSearches > 0 ? 'YES' : 'NO'}`);
  log(`     answer cites a url        : ${/https?:\/\//.test(r2.text) ? 'YES' : 'NO'}`);
  child.kill();
  process.exit(0);
})().catch((e) => { log('FATAL', e.message); child.kill(); process.exit(1); });
