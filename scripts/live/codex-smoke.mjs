// Opt-in public-only smoke using Nox's real client, loop, native framing and executor.
// node scripts/live/codex-smoke.mjs [--search] [--toggle-search]
// Synthetic prompts only; no workspace mutation (the executor rejects every
// tool and no dynamic tools are offered). Reports land under ignored
// `.release/` and are not release approval. Epoch 14 records versioned
// native-tool isolation evidence for each model/version claimed supported.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform, arch, release } from 'node:os';
import { createServer } from '../../extension/node_modules/vite/dist/node/index.js';
import { resolveCodex } from '../../bridge/resolve-codex.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const vite = await createServer({ root: root + 'extension', configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const { NativeBridge } = await vite.ssrLoadModule('/src/lib/codex/native.ts');
const { CodexClient } = await vite.ssrLoadModule('/src/lib/codex/client.ts');
const { AgentLoop } = await vite.ssrLoadModule('/src/lib/agent/loop.ts');
const { ToolExecutor } = await vite.ssrLoadModule('/src/lib/agent/executor.ts');
const { buildDeveloperInstructions, PROMPT_REVISION } = await vite.ssrLoadModule('/src/lib/agent/instructions.ts');
const { RESTRICTED_FEATURES } = await vite.ssrLoadModule('/src/lib/codex/research.ts');
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
  getDynamicTools: async () => [], developerInstructions: settings => buildDeveloperInstructions({ webSearchEnabled: settings.webSearchEnabled, availableTools: [] }),
});
const search = process.argv.includes('--search') || process.argv.includes('--toggle-search');
const toggleSearch = process.argv.includes('--toggle-search');
const codexResolution = (() => {
  try {
    return resolveCodex();
  } catch (error) {
    return { path: null, version: null, candidates: [], error: String(error) };
  }
})();
const report = {
  promptRevision: PROMPT_REVISION,
  search,
  toggleSearch,
  timestamp: new Date().toISOString(),
  userAgent: null,
  model: null,
  effort: null,
  runs: [],
  isolation: {
    codexExecutable: codexResolution.path ?? null,
    codexVersion: codexResolution.version ?? null,
    codexCandidateCount: Array.isArray(codexResolution.candidates) ? codexResolution.candidates.length : 0,
    os: { platform: platform(), arch: arch(), release: release() },
    model: null,
    effort: null,
    webSearchRequested: search && !toggleSearch,
    threadId: null,
    turnSubmitted: false,
    turnStartCount: 0,
    featureInspection: null,
    mcpInventory: null,
    researchObservedWhenDisabled: null,
    replayObserved: false,
    unexpectedSurface: null,
    // Non-provable limits (Epoch 14): observed native search may exceed the
    // boundary in flight; no model can promise semantic instruction obedience.
    // Isolation is verified through feature/MCP inspection with shell_tool as
    // the availability gate — never inferred from a writable temp cwd or a
    // read-only sandbox label.
    limits: {
      observedSearchMayExceedInFlight: true,
      noSemanticInstructionGuarantee: true,
      sandboxLabelIsNotIsolationProof: true,
    },
  },
};
const deadline = setTimeout(() => { bridge.disconnect(); process.exitCode = 1; }, 240000);
try {
  report.userAgent = await codex.initialize();
  const models = await codex.listModels();
  const model = process.env.NOX_LIVE_MODEL ? models.find(m => m.id === process.env.NOX_LIVE_MODEL) : models.find(m => m.isDefault);
  if (!model) throw new Error('Requested/default model is unavailable');
  report.model = model.id;
  report.effort = process.env.NOX_LIVE_EFFORT ?? model.defaultReasoningEffort;
  report.isolation.model = model.id;
  report.isolation.effort = report.effort;
  loop.setOverrides({ model: report.model, effort: report.effort, webSearchEnabled: search && !toggleSearch });
  async function run(id, prompt, stopOnSearch = false) {
    const events = []; const start = Date.now();
    const unsubscribe = loop.onTurnEvent(event => {
      events.push(event);
      if (stopOnSearch && event.kind === 'web-search') loop.cancel();
    });
    try {
      const result = await loop.sendUserMessage(prompt, { timeoutMs: 90000 });
      report.isolation.turnStartCount += 1;
      report.isolation.turnSubmitted = true;
      report.isolation.threadId = codex.activeThread ?? report.isolation.threadId;
      report.runs.push({ id, prompt, result, elapsedMs: Date.now() - start, events });
      console.log(id, JSON.stringify(result), Date.now() - start, 'ms');
      return { result, events };
    } catch (error) {
      report.runs.push({ id, prompt, error: String(error), elapsedMs: Date.now() - start, events });
      throw error;
    } finally { unsubscribe(); }
  }

  async function recordIsolationEvidence() {
    const threadId = codex.activeThread ?? null;
    report.isolation.threadId = threadId;
    if (!threadId) return;
    const features = new Map();
    let cursor = null;
    do {
      const page = await bridge.rpc('experimentalFeature/list', { threadId, limit: 200, cursor });
      if (!Array.isArray(page?.data)) throw new Error('Cannot verify the effective Codex tool surface. Update Codex and reconnect.');
      for (const feature of page.data) features.set(feature.name, feature.enabled);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    report.isolation.featureInspection = [...features].map(([name, enabled]) => ({ name, enabled }));
    for (const name of RESTRICTED_FEATURES) {
      if (features.get(name) !== false) {
        report.isolation.unexpectedSurface = `Codex feature ${name} is enabled or cannot be verified.`;
        throw new Error(`Nox cannot safely run: Codex feature ${name} is enabled or cannot be verified.`);
      }
    }
    cursor = null;
    const servers = [];
    do {
      const page = await bridge.rpc('mcpServerStatus/list', { threadId, cursor });
      if (!Array.isArray(page?.data)) throw new Error('Cannot verify inherited MCP tools.');
      for (const server of page.data) servers.push({ name: server.name, toolCount: Object.keys(server.tools ?? {}).length });
      if (page.data.some(server => Object.keys(server.tools ?? {}).length > 0)) {
        report.isolation.unexpectedSurface = 'Unrelated MCP tools remain exposed.';
        throw new Error('Nox cannot safely run: unrelated MCP tools remain exposed.');
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    report.isolation.mcpInventory = servers;
  }
  const first = await run('simple', 'Reply with exactly: OK');
  if (first.result.text.trim() !== 'OK' || first.events.some(e => e.kind === 'web-search')) throw new Error('Simple no-search-needed smoke failed');
  const followup = await run('followup', 'What exact token did I ask you to reply with in my preceding message? Reply only with that token.');
  if (followup.result.text.trim() !== 'OK') throw new Error('Follow-up context failed');
  // Disabled-research evidence plus versioned tool-surface evidence for the
  // thread that actually ran. Fail closed on any unexpected native surface.
  report.isolation.researchObservedWhenDisabled = first.events.some(e => e.kind === 'web-search') || followup.events.some(e => e.kind === 'web-search');
  await recordIsolationEvidence();
  if (search) {
    loop.setOverrides({ webSearchEnabled: true });
    const research = await run('live-search', 'Find the latest stable Node.js release. Search the web, open the official release source, and give its version and a Markdown link to that source.');
    if (!research.events.some(e => e.kind === 'web-search') || !research.events.some(e => e.kind === 'web-search-completed' && e.action?.type === 'openPage') || !/https:\/\//.test(research.result.text)) throw new Error('Live search/link not observed');
    await run('interruption', 'Research current Node.js and Chrome stable releases, opening official sources for both and comparing their release dates.', true);
    if (!report.runs.at(-1).result.interrupted) throw new Error('Interruption was not observed');
    const after = await run('after-interruption', 'Reply with exactly: OK');
    if (after.result.interrupted || after.result.text.trim() !== 'OK') throw new Error('Post-interruption follow-up failed');
    if (toggleSearch) {
      loop.setOverrides({ webSearchEnabled: false });
      const disabled = await run('search-disabled-again', 'What is the latest stable Chrome version today? Verify it using live web research if available; otherwise state that you cannot verify it.');
      if (disabled.events.some(e => e.kind === 'web-search')) throw new Error('Search ran while disabled');
    }
  }
} catch (error) {
  report.error = String(error); process.exitCode = 1; console.error(String(error));
} finally {
  clearTimeout(deadline); bridge.disconnect();
  mkdirSync(root + '.release', { recursive: true });
  const output = JSON.stringify(report, null, 2);
  writeFileSync(root + '.release/codex-smoke.json', output);
  writeFileSync(root + '.release/codex-smoke-' + report.timestamp.replaceAll(':', '-') + '.json', output);
  await vite.close();
  for (const child of children) child.stdin.end();
}
