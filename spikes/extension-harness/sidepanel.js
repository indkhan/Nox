import { connectNotion, mcpConnect, listTools, callTool, diagnose, resetNotion } from './notion.js';

window.__noxLoaded = true;

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(msg, cls = '') {
  const t = new Date().toLocaleTimeString();
  logEl.insertAdjacentHTML('beforeend', `<div class="${cls}">[${t}] ${String(msg).replace(/</g, '&lt;')}</div>`);
  logEl.scrollTop = logEl.scrollHeight;
}

// Nothing should fail silently — an uncaught throw in a panel is invisible otherwise.
window.addEventListener('error', (e) => log(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => log(`unhandled rejection: ${e.reason?.message ?? e.reason}`, 'bad'));

// ── Spike 0.4: is this document stable? ────────────────────────────────────
const loadedAt = Date.now();
$('loadedAt').textContent = new Date(loadedAt).toLocaleTimeString();
$('redirect').textContent = chrome.identity?.getRedirectURL?.() ?? 'chrome.identity UNAVAILABLE';

chrome.storage.session.get('panelLoads').then(({ panelLoads = 0 }) => {
  const n = panelLoads + 1;
  chrome.storage.session.set({ panelLoads: n });
  $('loads').textContent = n;
  if (n > 1) log(`panel document loaded ${n} times this session — it is being unloaded`, 'warn');
});

setInterval(() => {
  const s = Math.floor((Date.now() - loadedAt) / 1000);
  $('uptime').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}, 1000);

// ── E1: current page ───────────────────────────────────────────────────────
function renderPage(p) {
  $('pTitle').textContent = p?.title ?? '—';
  $('pId').textContent = p?.pageId ?? '— (no Notion tab focused)';
  $('pUrl').textContent = p?.url ?? '—';
}
chrome.runtime.sendMessage({ type: 'nox:getPage' }).then(renderPage).catch(() => {});
chrome.storage.session.onChanged.addListener((c) => c.currentPage && renderPage(c.currentPage.newValue));

// ── Spike 0.1: Notion MCP ──────────────────────────────────────────────────
let connected = false;

$('connect').onclick = async () => {
  $('connect').disabled = true;
  try {
    log('starting OAuth (DCR → PKCE → launchWebAuthFlow)…');
    const tok = await connectNotion(log);
    log(`token received, workspace ${tok.workspace_id}, expires in ${tok.expires_in}s`, 'ok');
    const init = await mcpConnect();
    connected = true;
    $('nStatus').textContent = `connected — ${init.serverInfo?.name ?? 'notion'}`;
    log(`MCP initialize ok — protocol ${init.protocolVersion}`, 'ok');
  } catch (e) {
    $('nStatus').textContent = 'failed';
    log('connect failed: ' + e.message, 'bad');
    if (/Invalid Origin/i.test(e.message)) {
      log('→ the Origin header reached Notion. The DNR strip rule is not applying.', 'warn');
      log('→ next: reload the extension, then click Diagnose to confirm the rule is installed.', 'warn');
    }
  } finally {
    $('connect').disabled = false;
  }
};

$('probe').onclick = async () => {
  try {
    const { tools } = await listTools();
    log(`tools/list → ${tools.length} tools`, 'ok');
    log(tools.map((t) => '  ' + t.name).join('\n'));
    const self = await callTool('notion-fetch', { id: 'self' });
    log('notion-fetch self →\n' + self.slice(0, 900), 'ok');
  } catch (e) { log('probe failed: ' + e.message, 'bad'); }
};

$('fetchPage').onclick = async () => {
  try {
    const p = await chrome.runtime.sendMessage({ type: 'nox:getPage' });
    if (!p?.pageId) return log('no Notion page detected — focus a Notion tab first', 'warn');
    log(`fetching ${p.pageId}…`);
    const md = await callTool('notion-fetch', { id: p.pageId });
    log(`got ${md.length} chars of Notion-flavoured markdown`, 'ok');
    log(md.slice(0, 1200));
  } catch (e) { log('fetch failed: ' + e.message, 'bad'); }
};

// ── Spike 0.3: native bridge and the 1 MB ceiling ──────────────────────────
function bridgeSend(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = chrome.runtime.connectNative('com.nox.bridge'); }
    catch (e) { return reject(e); }
    const chunks = [];
    port.onMessage.addListener((m) => {
      if (m.type === 'chunk') { chunks.push(m.data); return; }
      if (m.type === 'chunkEnd') { resolve({ ...m, assembled: chunks.join('').length }); port.disconnect(); return; }
      resolve(m); port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
    });
    port.postMessage(payload);
    setTimeout(() => reject(new Error('bridge timeout')), 20000);
  });
}

$('ping').onclick = async () => {
  try {
    const r = await bridgeSend({ type: 'ping' });
    $('bStatus').textContent = 'connected';
    log('bridge pong: ' + JSON.stringify(r).slice(0, 400), 'ok');
  } catch (e) {
    $('bStatus').textContent = 'not installed';
    log('bridge failed: ' + e.message, 'bad');
    log('install it with: node bridge/install.mjs', 'warn');
  }
};

$('big').onclick = async () => {
  log('── spike 0.3: the 1 MB host→extension ceiling ──');
  try {
    log('1/2 raw: asking for 2 MB in a single message…');
    const r = await bridgeSend({ type: 'big', bytes: 2 * 1024 * 1024, mode: 'raw' });
    log('unexpected success — no cap hit? ' + JSON.stringify(r).slice(0, 200), 'warn');
  } catch (e) {
    log('raw failed as predicted: ' + e.message, 'warn');
    log('→ confirms the 1 MB ceiling. Chunking is mandatory, not defensive.');
  }
  try {
    log('2/2 chunked: same 2 MB, split by the bridge…');
    const r = await bridgeSend({ type: 'big', bytes: 2 * 1024 * 1024, mode: 'chunked', id: 1 });
    log(`chunked ok — ${r.chunks} chunks, ${r.totalChars} chars sent, ${r.assembled} reassembled`, 'ok');
    if (r.assembled === r.totalChars) log('→ framing design validated.', 'ok');
  } catch (e) { log('chunked failed too: ' + e.message, 'bad'); }
};

$('diagnose').onclick = async () => {
  log('── diagnostics ──');
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const origin = rules.find((r) => r.action?.requestHeaders?.some((h) => h.header === 'origin'));
    log(`origin-strip rule: ${origin ? 'installed' : 'MISSING'} (${rules.length} dynamic rule(s))`,
        origin ? 'ok' : 'bad');
    if (origin) log('  matches: ' + JSON.stringify(origin.condition));
  } catch (e) { log('DNR check failed: ' + e.message, 'bad'); }
  try { await diagnose(log); } catch (e) { log('diagnose threw: ' + e.message, 'bad'); }
};

$('reset').onclick = async () => {
  await resetNotion();
  connected = false;
  $('nStatus').textContent = 'not connected';
  log('cleared stored client_id and tokens — next Connect re-registers', 'warn');
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(logEl.innerText);
  log('log copied to clipboard', 'ok');
};

log('panel ready. extension id: ' + chrome.runtime.id);
log('redirect uri: ' + (chrome.identity?.getRedirectURL?.() ?? 'chrome.identity UNAVAILABLE — check the identity permission'));
