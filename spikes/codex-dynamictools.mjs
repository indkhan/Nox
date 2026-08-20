// Spike 0.2 — can a client drive `codex app-server` with its own tools?
// Answers: does dynamicTools exist in this build, does item/tool/call come back,
// does :read-only + custom developerInstructions + no cwd work.
// Run: node spikes/codex-dynamictools.mjs
import { spawn } from 'node:child_process';

const log = (...a) => console.log(...a);
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buf = '';

function send(obj) {
  log('→', JSON.stringify(obj).slice(0, 400));
  child.stdin.write(JSON.stringify(obj) + '\n');
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });               // note: no "jsonrpc" field on the wire
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout: ${method}`))), 120000);
  });
}
function notify(method, params) { send({ method, params }); }
function respond(id, result) { send({ id, result }); }

let toolCalled = null;
const seen = new Set();

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('‹unparsed›', line.slice(0, 200)); continue; }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      continue;
    }

    if (msg.method && msg.id !== undefined) {
      // server -> client request
      log('⇐ REQUEST', msg.method, JSON.stringify(msg.params).slice(0, 300));
      if (msg.method === 'item/tool/call') {
        toolCalled = msg.params;
        respond(msg.id, {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'In Progress', owner: 'Usman' }) }],
        });
      } else {
        respond(msg.id, { decision: 'decline' });
      }
      continue;
    }

    if (msg.method) {
      if (!seen.has(msg.method)) { seen.add(msg.method); log('⇐ notif', msg.method); }
      if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
        log('\n=== AGENT MESSAGE ===\n' + (msg.params.item.text ?? JSON.stringify(msg.params.item)).slice(0, 1500) + '\n');
      }
      if (msg.method === 'turn/completed') { log('=== TURN COMPLETE ==='); finish(); }
      if (msg.method === 'error' || msg.method === 'warning') log('⇐', msg.method, JSON.stringify(msg.params).slice(0, 400));
    }
  }
});

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

function finish(code = 0) {
  log('\n──────── VERDICT ────────');
  log('dynamicTools accepted by thread/start :', results.threadStarted ? 'YES' : 'NO');
  log('item/tool/call received               :', toolCalled ? 'YES' : 'NO');
  if (toolCalled) log('  tool=', toolCalled.tool, 'ns=', toolCalled.namespace, 'args=', JSON.stringify(toolCalled.arguments));
  log('notifications seen                    :', [...seen].join(', '));
  child.kill();
  process.exit(code);
}

const results = {};

(async () => {
  const init = await request('initialize', {
    clientInfo: { name: 'nox-spike', title: 'Nox Spike', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  log('✔ initialize', JSON.stringify(init).slice(0, 300));
  notify('initialized', {});

  try { log('✔ experimentalFeature/list', JSON.stringify(await request('experimentalFeature/list', {})).slice(0, 800)); }
  catch (e) { log('✖ experimentalFeature/list', e.message); }

  let model = process.env.NOX_MODEL || 'gpt-5.5';
  try {
    const models = await request('model/list', {});
    log('✔ model/list:');
    for (const m of models.data ?? []) {
      log(`   ${m.id.padEnd(22)} efforts=${(m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort).join('/')}` +
          ` modalities=${(m.inputModalities ?? []).join(',')} default=${m.isDefault ?? false} hidden=${m.hidden}`);
    }
  } catch (e) { log('✖ model/list', e.message); }
  log(`→ using model: ${model}`);

  const dynamicTools = [{
    type: 'function',
    name: 'notion_fetch',
    description: 'Fetch a Notion page by id and return its content.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'Notion page id' } },
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
      'You are Nox, an assistant for a Notion workspace. You are not a coding agent. ' +
      'You have exactly one tool: notion_fetch. When the user asks about a Notion page, ' +
      'call notion_fetch with the page id, then answer from the result in one short sentence.',
  };

  try {
    const t = await request('thread/start', threadParams);
    results.threadStarted = true;
    log('✔ thread/start', JSON.stringify(t).slice(0, 600));
    var threadId = t.thread?.id ?? t.id;
  } catch (e) {
    log('✖ thread/start WITH dynamicTools:', e.message);
    log('  retrying without dynamicTools to isolate the cause...');
    const { dynamicTools: _drop, ...rest } = threadParams;
    const t = await request('thread/start', rest);
    log('✔ thread/start without dynamicTools worked →   dynamicTools is the rejected field');
    var threadId = t.thread?.id ?? t.id;
  }

  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'What is the status on Notion page 1a2b3c4d5e6f7890abcdef1234567890? Use your tool.' }],
  });
  log('✔ turn/start sent, waiting for the model...');

  setTimeout(() => { log('\n⏱ timed out waiting for turn/completed'); finish(1); }, 150000);
})().catch((e) => { log('FATAL', e.message); finish(1); });
