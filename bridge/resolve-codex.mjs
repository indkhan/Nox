// Which `codex` do we actually run?
//
// A machine can easily have three: the npm shim, the desktop app's bundled binary, and a
// cached standalone release. They are NOT interchangeable — spawning the wrong one silently
// gives you an older app-server with a truncated model/list (spike 0.2/0.5: the desktop build
// reported 0.143.0 and hid every gpt-5.6 model, while npm's was 0.149.0 and showed all six).
//
// So: gather candidates, ask each its version, and take the newest.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXE = platform() === 'win32' ? 'codex.exe' : 'codex';

function npmVendored() {
  // @openai/codex is a launcher; the real binary lives in the platform package it depends on.
  const require = createRequire(import.meta.url);
  const triples = {
    win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
    darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
    linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  }[platform()]?.[process.arch];
  const pkg = {
    win32: { x64: '@openai/codex-win32-x64', arm64: '@openai/codex-win32-arm64' },
    darwin: { x64: '@openai/codex-darwin-x64', arm64: '@openai/codex-darwin-arm64' },
    linux: { x64: '@openai/codex-linux-x64', arm64: '@openai/codex-linux-arm64' },
  }[platform()]?.[process.arch];
  if (!triples || !pkg) return [];

  const out = [];
  for (const base of npmRoots()) {
    const p = join(base, pkg, 'vendor', triples, 'bin', EXE);
    if (existsSync(p)) out.push(p);
    const nested = join(base, '@openai', 'codex', 'node_modules', pkg, 'vendor', triples, 'bin', EXE);
    if (existsSync(nested)) out.push(nested);
  }
  try { out.push(join(require.resolve(`${pkg}/package.json`), '..', 'vendor', triples, 'bin', EXE)); } catch {}
  return out;
}

function npmRoots() {
  const roots = [];
  try {
    const npmCmd = platform() === 'win32' ? 'npm.cmd' : 'npm';
    const prefix = execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8', timeout: 15000 }).trim();
    if (prefix) roots.push(prefix);
  } catch {}
  if (platform() === 'win32') {
    roots.push(join(homedir(), 'AppData/Local/Programs/nodejs/node_modules'));
    roots.push(join(process.env.APPDATA ?? '', 'npm/node_modules'));
  } else {
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global/lib/node_modules'));
  }
  return roots.filter(Boolean);
}

function otherCandidates() {
  const c = [];
  if (process.env.CODEX_BIN) c.push(process.env.CODEX_BIN);
  if (platform() === 'win32') {
    c.push(join(homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'));
  } else {
    c.push('/usr/local/bin/codex', '/opt/homebrew/bin/codex', join(homedir(), '.local/bin/codex'));
  }
  // cached standalone releases, newest last
  const rel = join(homedir(), '.codex/packages/standalone/releases');
  if (existsSync(rel)) {
    try { for (const d of readdirSync(rel)) c.push(join(rel, d, 'bin', EXE)); } catch {}
  }
  // plain PATH lookup, last — it is the ambiguous one
  c.push(EXE);
  return c;
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export function resolveCodex() {
  const seen = new Set();
  const found = [];
  for (const path of [...npmVendored(), ...otherCandidates()]) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      const v = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
      const m = v.match(/(\d+\.\d+\.\d+)/);
      if (m) found.push({ path, version: m[1] });
    } catch { /* not present or not runnable */ }
  }
  if (!found.length) return { path: null, version: null, candidates: [] };
  found.sort((a, b) => cmp(b.version, a.version));
  return { ...found[0], candidates: found };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = resolveCodex();
  console.log('chosen :', r.path, r.version ? `(${r.version})` : '(none found)');
  for (const c of r.candidates) console.log('   ', c.version.padEnd(10), c.path);
}
