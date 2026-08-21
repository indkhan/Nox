// E0 Notion MCP spike: OAuth (DCR + PKCE via chrome.identity) and a minimal Streamable HTTP client.
// Runs in the side panel document — extension pages bypass CORS via host_permissions,
// so no proxy and no CORS headers are needed on Notion's side.

const MCP_URL = 'https://mcp.notion.com/mcp';
const redirectUri = () => chrome.identity.getRedirectURL();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

async function discover() {
  const prm = await (await fetch('https://mcp.notion.com/.well-known/oauth-protected-resource/mcp')).json();
  const as = prm.authorization_servers[0];
  return (await fetch(`${as}/.well-known/oauth-authorization-server`)).json();
}

async function getClientId(meta) {
  const { notion_client_id } = await chrome.storage.local.get('notion_client_id');
  if (notion_client_id) return notion_client_id;
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Nox',
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
    }),
  });
  if (!r.ok) throw new Error(`register ${r.status}: ${await r.text()}`);
  const { client_id } = await r.json();
  await chrome.storage.local.set({ notion_client_id: client_id });
  return client_id;
}

// Every await is wrapped so a failure names the stage it died in. Without this the panel
// just says "connect failed" and we are guessing across four network hops.
const stage = async (name, log, fn) => {
  try { return await fn(); }
  catch (e) { throw new Error(`[${name}] ${e?.message ?? e}`); }
};

export async function connectNotion(log = () => {}) {
  const meta = await stage('discovery', log, discover);
  log(`discovery ok — issuer ${meta.issuer}`);
  log(`  authorize: ${meta.authorization_endpoint}`);
  log(`  token:     ${meta.token_endpoint}`);
  const clientId = await stage('register', log, () => getClientId(meta));
  log(`client_id ${clientId}`);
  log(`redirect_uri ${redirectUri()}`);

  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(verifierBytes);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', 'default');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');

  log('opening Notion consent…');
  log(`  ${url.toString().slice(0, 160)}…`);
  const redirected = await stage('launchWebAuthFlow', log, async () => {
    const out = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    if (!out) throw new Error('flow returned nothing (window closed, or redirect never matched)');
    return out;
  });
  log(`redirected back: ${redirected.slice(0, 120)}…`);
  const back = new URL(redirected);
  if (back.searchParams.get('error')) throw new Error(back.searchParams.get('error'));
  if (back.searchParams.get('state') !== state) throw new Error('state mismatch');
  const iss = back.searchParams.get('iss');
  if (iss && iss !== meta.issuer) throw new Error(`iss mismatch: ${iss}`);

  const tok = await stage('token-exchange', log, async () => {
    const r = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code'),
        redirect_uri: redirectUri(),
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  });

  // access token in session storage (never hits disk), refresh token in local.
  await chrome.storage.session.set({ notion_access: tok.access_token, notion_expires: Date.now() + tok.expires_in * 1000 });
  await chrome.storage.local.set({ notion_refresh: tok.refresh_token, notion_workspace: tok.workspace_id });
  return tok;
}

async function accessToken() {
  const { notion_access } = await chrome.storage.session.get('notion_access');
  if (!notion_access) throw new Error('not connected');
  return notion_access;
}

let sessionId = null;
let rpcId = 0;

async function rpc(method, params, isNotify = false) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${await accessToken()}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = isNotify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (isNotify) return null;
  if (!res.ok) throw new Error(`${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    : JSON.parse(text);
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error).slice(0, 300)}`);
  return payload.result;
}

export async function mcpConnect() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nox', version: '0.0.1' },
  });
  await rpc('notifications/initialized', {}, true);
  return init;
}

export const listTools = () => rpc('tools/list', {});

export async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}


// Step-by-step probe that avoids the OAuth popup, so we can isolate which hop fails.
export async function diagnose(log) {
  log('redirect uri: ' + redirectUri());
  log('extension id: ' + chrome.runtime.id);
  try {
    const r = await fetch('https://mcp.notion.com/.well-known/oauth-protected-resource/mcp');
    log(`protected-resource: ${r.status} ${r.ok ? 'ok' : await r.text()}`);
  } catch (e) { log('protected-resource FAILED: ' + e.message); }
  try {
    const r = await fetch('https://mcp.notion.com/.well-known/oauth-authorization-server');
    log(`authorization-server: ${r.status} ${r.ok ? 'ok' : await r.text()}`);
  } catch (e) { log('authorization-server FAILED: ' + e.message); }
  try {
    const meta = await discover();
    const id = await getClientId(meta);
    log('register/cached client_id: ' + id);
  } catch (e) { log('register FAILED: ' + e.message); }
  const { notion_refresh } = await chrome.storage.local.get('notion_refresh');
  const { notion_access } = await chrome.storage.session.get('notion_access');
  log(`stored: refresh=${notion_refresh ? 'yes' : 'no'} access=${notion_access ? 'yes' : 'no'}`);
}

export async function resetNotion() {
  await chrome.storage.local.remove(['notion_client_id', 'notion_refresh', 'notion_workspace']);
  await chrome.storage.session.remove(['notion_access', 'notion_expires']);
}
