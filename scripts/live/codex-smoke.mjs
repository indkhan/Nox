// Opt-in public-only smoke using Nox's real client, loop, native framing and executor.
// node scripts/live/codex-smoke.mjs [--search]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../extension/node_modules/vite/dist/node/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const vite = await createServer({ root: root + 'extension', configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const { NativeBridge } = await vite.ssrLoadModule('/src/lib/codex/native.ts');
const { CodexClient } = await vite.ssrLoadModule('/src/lib/codex/client.ts');
const { AgentLoop } = await vite.ssrLoadModule('/src/lib/agent/loop.ts');
const { ToolExecutor } = await vite.ssrLoadModule('/src/lib/agent/executor.ts');
const { buildDeveloperInstructions } = await vite.ssrLoadModule('/src/lib/agent/instructions.ts');
const children = [];
const bridge = new NativeBridge(() => {
  const child = spawn(process.execPath, [root + 'bridge/nox-bridge.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  children.push(child);
  let buf = Buffer.alloc(0);
  const listeners = [], disconnected = [];
  child.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const size = buf.readUInt32LE(0);
      const frame = JSON.parse(buf.subarray(4, size + 4));
      buf = buf.subarray(size + 4);
      listeners.forEach(fn => fn(frame));
    }
  });
  child.on('exit', () => disconnected.forEach(fn => fn()));
  return {
    postMessage(message) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
    },
    disconnect: () => child.stdin.end(),
    onMessage: { addListener: fn => listeners.push(fn) },
    onDisconnect: { addListener: fn => disconnected.push(fn) },
  };
});
const codex = new CodexClient(bridge);
const loop = new AgentLoop({ bridge, codex,
  executor: new ToolExecutor({ assertToolAllowed: () => { throw new Error('No workspace tools in public smoke'); }, callTool: async () => { throw new Error('No workspace calls'); } }),
  getDynamicTools: async () => [], developerInstructions: () => buildDeveloperInstructions(),
});
const report = { timestamp: new Date().toISOString(), userAgent: null, model: null, effort: null, runs: [] };
const deadline = setTimeout(() => { bridge.disconnect(); process.exitCode = 1; }, 240000);
try {
  report.userAgent = await codex.initialize();
  const models = await codex.listModels();
  const model = models.find(m => m.id === process.env.NOX_LIVE_MODEL) ?? models.find(m => m.isDefault);
  if (!model) throw new Error('No available default model');
  report.model = model.id;
  report.effort = process.env.NOX_LIVE_EFFORT ?? model.defaultReasoningEffort;
  loop.setOverrides({ model: report.model, effort: report.effort, webSearchEnabled: process.argv.includes('--search') });
  async function run(id, prompt, stopOnSearch = false) {
    const events = []; const start = Date.now();
    const unsubscribe = loop.onTurnEvent(event => {
      events.push(event);
      if (stopOnSearch && event.kind === 'web-search') loop.cancel();
    });
    try {
      const result = await loop.sendUserMessage(prompt, { timeoutMs: 90000 });
      report.runs.push({ id, prompt, result, elapsedMs: Date.now() - start, events });
      console.log(id, JSON.stringify(result), Date.now() - start, 'ms');
      return { result, events };
    } finally { unsubscribe(); }
  }
  const first = await run('simple-disabled', 'Reply with exactly: OK');
  if (first.result.text.trim() !== 'OK' || first.events.some(e => e.kind === 'web-search')) throw new Error('Simple disabled-search smoke failed');
  const followup = await run('followup', 'What exact token did I ask you to reply with in my preceding message? Reply only with that token.');
  if (followup.result.text.trim() !== 'OK') throw new Error('Follow-up context failed');
  if (process.argv.includes('--search')) {
    loop.setOverrides({ webSearchEnabled: true });
    const research = await run('live-search', 'Find the latest stable Node.js release. Search the web, open the official release source, and give its version and a Markdown link to that source.');
    if (!research.events.some(e => e.kind === 'web-search') || !/https:\/\//.test(research.result.text)) throw new Error('Live search/link not observed');
    await run('interruption', 'Research current Node.js and Chrome stable releases, opening official sources for both and comparing their release dates.', true);
    if (!report.runs.at(-1).result.interrupted) throw new Error('Interruption was not observed');
    await run('after-interruption', 'Reply with exactly: OK');
  }
} catch (error) {
  report.error = String(error); process.exitCode = 1; console.error(String(error));
} finally {
  clearTimeout(deadline); bridge.disconnect();
  mkdirSync(root + '.release', { recursive: true });
  writeFileSync(root + '.release/codex-smoke.json', JSON.stringify(report, null, 2));
  await vite.close();
  for (const child of children) child.stdin.end();
}
