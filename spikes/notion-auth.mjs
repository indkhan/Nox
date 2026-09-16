// Notion MCP OAuth from Node — DCR + PKCE + loopback callback.
//
// LOCAL SPIKE ONLY — not the extension authentication path (the extension uses
// chrome.identity + its own token store). Used to mint a token for opt-in live
// tests (extension/tests/live/notion-live.test.ts). Do not run with a valuable
// workspace merely to demonstrate installation; use synthetic scratch data.
// Run: node spikes/notion-auth.mjs   → open the printed URL, click Approve.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOKEN_FILE = join(HERE, '.notion-token.json');
export const LOOPBACK_HOST = '127.0.0.1';
const PORT = 8765;
const REDIRECT = `http://${LOOPBACK_HOST}:${PORT}/callback`;
const MCP = 'https://mcp.notion.com';
/** Bound a single callback request (headers + URL) to 8 KiB; larger → 413 without closing. */
export const MAX_CALLBACK_BYTES = 8 * 1024;
/** Overall wait for the browser approval callback. */
export const CALLBACK_TIMEOUT_MS = 300_000;

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/**
 * Write JSON atomically with owner-only permissions (0600 on POSIX).
 * Writes to a temp file in the same directory, chmods, then renames.
 * Pure local filesystem effect; `tokenFile` is injectable for synthetic-token tests.
 */
export function writeTokenAtomic(tokenFile, value) {
  const body = JSON.stringify(value, null, 2);
  const tmp = `${tokenFile}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, tokenFile);
}

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
  writeTokenAtomic(TOKEN_FILE, next);
  return next;
}

/**
 * Validate one callback request URL against the expected state/issuer.
 * Returns { ok, code?, error? }. Pure function — unit-testable with synthetic
 * URLs; never touches the network or the token file.
 */
export function validateCallbackRequest(rawUrl, { state, issuer }) {
  let u;
  try {
    u = new URL(rawUrl, `http://${LOOPBACK_HOST}:${PORT}`);
  } catch {
    return { ok: false, error: 'bad request' };
  }
  if (u.pathname !== '/callback') return { ok: false, error: 'not found' };
  if ((rawUrl?.length ?? 0) > MAX_CALLBACK_BYTES) return { ok: false, error: 'request too large' };
  const err = u.searchParams.get('error');
  if (err) return { ok: false, error: err };
  if (u.searchParams.get('state') !== state) return { ok: false, error: 'state mismatch' };
  const iss = u.searchParams.get('iss');
  if (iss && iss !== issuer) return { ok: false, error: `iss mismatch: ${iss}` };
  const code = u.searchParams.get('code');
  if (!code) return { ok: false, error: 'missing code' };
  return { ok: true, code };
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
      // Bound request size before parsing; invalid callbacks get an error page
      // but leave the server open for the valid approval (no srv.close() here).
      const raw = req.url ?? '/';
      if ((req.headers['content-length'] ?? '' ) !== '' && Number(req.headers['content-length']) > MAX_CALLBACK_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('request too large');
        return;
      }
      const verdict = validateCallbackRequest(raw, { state, issuer: meta.issuer });
      if (!verdict.ok && verdict.error === 'not found') { res.writeHead(404); res.end(); return; }
      if (!verdict.ok) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(`<h2>Authorization failed.</h2><p>${String(verdict.error).slice(0, 200)}</p><p>Retry the approval in the original tab; this listener stays open.</p>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h2>Nox connected.</h2><p>You can close this tab and return to the terminal.</p>');
      srv.close();
      clearTimeout(timer);
      resolve(verdict.code);
    });
    srv.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
    // Explicit loopback bind — never 0.0.0.0.
    srv.listen(PORT, LOOPBACK_HOST, () => console.log(`  (listening on ${REDIRECT})`));
    const timer = setTimeout(() => { srv.close(); reject(new Error('timed out waiting for approval')); }, CALLBACK_TIMEOUT_MS);
    srv.on('error', (e) => { clearTimeout(timer); reject(e); });
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
  writeTokenAtomic(TOKEN_FILE, saved);

  console.log('\n  ✔ Connected.');
  console.log('    workspace_id :', tok.workspace_id);
  console.log('    user_id      :', tok.user_id);
  console.log('    expires_in   :', tok.expires_in, 'seconds');
  console.log('    saved to     :', TOKEN_FILE, '(gitignored, mode 0600)\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('\n✖', e.message, '\n'); process.exit(1); });

// Re-export tmpdir for synthetic-token tests that need isolated dirs.
export { tmpdir };
