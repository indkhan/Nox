// Minimal Notion MCP client over Streamable HTTP. Enough for the spikes.
// The extension will use @modelcontextprotocol/sdk; this is deliberately dependency-free.
import { loadToken } from './notion-auth.mjs';

const MCP_URL = 'https://mcp.notion.com/mcp';
let id = 0;
let sessionId = null;
let token = null;

async function rpc(method, params) {
  token ??= await loadToken();
  if (!token) throw new Error('not connected — run: node spikes/notion-auth.mjs');

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token.access_token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (res.status === 401) throw new Error('401 — token rejected; re-run notion-auth.mjs');
  if (!res.ok) throw new Error(`${method} → ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const text = await res.text();
  // Streamable HTTP may answer as JSON or as an SSE stream; handle both.
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    : JSON.parse(text);
  if (payload.error) throw new Error(`${method} → ${JSON.stringify(payload.error).slice(0, 400)}`);
  return payload.result;
}

async function notify(method, params) {
  token ??= await loadToken();
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token.access_token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
}

export async function connect() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nox-spike', version: '0.0.1' },
  });
  await notify('notifications/initialized', {});
  return { init, sessionId };
}

export const listTools = () => rpc('tools/list', {});
export const readResource = (uri) => rpc('resources/read', { uri });
export const listResources = () => rpc('resources/list', {});

export async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: r.isError ?? false, raw: r };
}
