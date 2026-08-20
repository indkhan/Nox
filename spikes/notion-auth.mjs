// Notion MCP OAuth from Node — DCR + PKCE + localhost callback.
// Same code path the extension uses, minus chrome.identity. Proves spike 0.1's hard half
// and gives the other spikes a real token to work with.
// Run: node spikes/notion-auth.mjs   → open the printed URL, click Approve.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOKEN_FILE = join(HERE, '.notion-token.json');
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const MCP = 'https://mcp.notion.com';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

async function discover() {
  const prm = await (await fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`)).json();
  const as = prm.authorization_servers[0];
  const meta = await (await fetch(`${as}/.well-known/oauth-authorization-server`)).json();
  return meta;
}

async function register(meta) {
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Nox (local spike)',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
    }),
  });
  if (!r.ok) throw new Error(`register failed ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  if (t.expires_at && t.expires_at - Date.now() < 60_000) return refresh(t);
  return t;
}

export async function refresh(t) {
  const meta = await discover();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: t.client_id,
  });
  const r = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status}: ${await r.text()}  → re-run notion-auth.mjs`);
  const tok = await r.json();
  // Notion rotates the refresh token on every refresh — write it atomically or you get locked out.
  const next = { ...t, ...tok, expires_at: Date.now() + tok.expires_in * 1000 };
  writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function main() {
  const meta = await discover();
  const client = await register(meta);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('scope', 'default');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');

  console.log('\n  Open this in your browser and click Approve:\n');
  console.log('  ' + url.toString() + '\n');

  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') return res.end();
      const err = u.searchParams.get('error');
      if (err) { res.end(`Error: ${err}`); srv.close(); return reject(new Error(err)); }
      if (u.searchParams.get('state') !== state) { res.end('state mismatch'); srv.close(); return reject(new Error('state mismatch')); }
      // Notion returns iss on success — validate it (§2.4)
      const iss = u.searchParams.get('iss');
      if (iss && iss !== meta.issuer) { res.end('iss mismatch'); srv.close(); return reject(new Error(`iss mismatch: ${iss}`)); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h2>Nox connected.</h2><p>You can close this tab and return to the terminal.</p>');
      srv.close();
      resolve(u.searchParams.get('code'));
    });
    srv.listen(PORT, () => console.log(`  (listening on ${REDIRECT})`));
    setTimeout(() => { srv.close(); reject(new Error('timed out waiting for approval')); }, 300000);
  });

  const r = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  });
  if (!r.ok) throw new Error(`token exchange failed ${r.status}: ${await r.text()}`);
  const tok = await r.json();
  const saved = { ...tok, client_id: client.client_id, expires_at: Date.now() + tok.expires_in * 1000 };
  writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2));

  console.log('\n  ✔ Connected.');
  console.log('    workspace_id :', tok.workspace_id);
  console.log('    user_id      :', tok.user_id);
  console.log('    expires_in   :', tok.expires_in, 'seconds');
  console.log('    saved to     :', TOKEN_FILE, '(gitignored)\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('\n✖', e.message, '\n'); process.exit(1); });
