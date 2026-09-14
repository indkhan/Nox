// Which `codex` do we actually run?
//
// A machine can easily have three: the npm shim, the desktop app's bundled binary, and a
// cached standalone release. They are NOT interchangeable — spawning the wrong one silently
// gives you an older app-server with a truncated model/list (spike 0.2/0.5: the desktop build
// reported 0.143.0 and hid every gpt-5.6 model, while npm's was 0.149.0 and showed all six).
//
// So: gather candidates, ask each its version, and take the newest.
//
// Explicit override: set CODEX_BIN to an absolute path to a local Codex binary.
// An invalid CODEX_BIN fails closed (no fallback to another version). PATH-only
// `codex` is resolved to an absolute existing path; a bare name is never returned.
// Successful discovery is cached for the host lifetime; use
// clearResolveCodexCacheForTests() in tests. Newest-selected is not equated with
// tested-compatible: compare `version` against TESTED_CODEX_VERSIONS.
//
// Recorded for diagnosis: callers log only `path`/`version` (no provider config).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXE = platform() === 'win32' ? 'codex.exe' : 'codex';

/** Codex versions exercised against this Nox revision. Newer versions may work but are unverified. */
export const TESTED_CODEX_VERSIONS = ['0.153.4'];
/** Bound on version probes per resolveCodex() call (10s timeout each). */
export const MAX_CANDIDATE_PROBES = 20;

let cachedResult = null;
let cachedOverrideKey = null;

export function clearResolveCodexCacheForTests() {
  cachedResult = null;
  cachedOverrideKey = null;
}

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

/**
 * Resolve a bare executable name (no path separator) to an absolute existing
 * path via PATH search. Pure filesystem check — never executes the candidate.
 * `pathValue` overrides process.env.PATH for tests. Returns null when absent.
 */
export function resolveBareExecutable(name, pathValue) {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const pathEnv = pathValue ?? process.env.PATH ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const suffixes = platform() === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const wanted = platform() === 'win32' ? name.toLowerCase() : name;
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const hasSuffix = platform() === 'win32' && /\.(exe|cmd|bat)$/i.test(name);
      const candidate = join(dir, hasSuffix ? name : name + suffix);
      if (platform() === 'win32' && !hasSuffix && suffix === '' && !name.toLowerCase().endsWith('.exe')) continue;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          // On win32 compare case-insensitively; return the real absolute path.
          if (platform() !== 'win32' || candidate.toLowerCase().endsWith(wanted) || suffix !== '') return resolve(candidate);
        }
      } catch {}
    }
  }
  return null;
}

/** Normalize a candidate to an absolute existing file path, or null. */
function toAbsoluteExisting(candidate) {
  if (!candidate) return null;
  // Bare name → PATH search (never return the bare string).
  if (!candidate.includes('/') && !candidate.includes('\\')) {
    return resolveBareExecutable(candidate);
  }
  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
  try {
    return existsSync(absolute) && statSync(absolute).isFile() ? absolute : null;
  } catch {
    return null;
  }
}

function probeVersion(absolutePath) {
  const isScript = /\.(mjs|cjs|js)$/i.test(absolutePath);
  const out = isScript
    ? execFileSync(process.execPath, [absolutePath, '--version'], { encoding: 'utf8', timeout: 10000 }).trim()
    : execFileSync(absolutePath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  const m = out.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`version parse failed: ${out.slice(0, 80)}`);
  return { version: m[1], launcher: isScript ? process.execPath : null };
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export function resolveCodex() {
  const override = process.env.CODEX_BIN;
  const overrideKey = override ?? '';
  if (cachedResult && cachedOverrideKey === overrideKey) return cachedResult;

  // CODEX_BIN is an explicit local override: validate it and never silently
  // fall through to another version when it is set but invalid.
  if (override) {
    const absolute = toAbsoluteExisting(override);
    if (!absolute) {
      return { path: null, version: null, error: `CODEX_BIN does not exist: ${override}`, candidates: [] };
    }
    try {
      const { version, launcher } = probeVersion(absolute);
      const result = {
        path: absolute,
        version,
        launcher,
        candidates: [],
        testedCompatible: TESTED_CODEX_VERSIONS.includes(version),
      };
      cachedResult = result;
      cachedOverrideKey = overrideKey;
      return result;
    } catch (e) {
      return { path: null, version: null, error: `CODEX_BIN version check failed: ${override}: ${e?.message ?? e}`, candidates: [] };
    }
  }

  const seen = new Set();
  const found = [];
  const candidates = [...npmVendored(), ...otherCandidates()].slice(0, MAX_CANDIDATE_PROBES * 2);
  let probes = 0;
  for (const raw of candidates) {
    if (probes >= MAX_CANDIDATE_PROBES) break;
    const absolute = toAbsoluteExisting(raw);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    probes++;
    try {
      const { version, launcher } = probeVersion(absolute);
      found.push({ path: absolute, version, launcher });
    } catch {
      /* not present or not runnable */
    }
  }
  if (!found.length) return { path: null, version: null, candidates: [] };
  found.sort((a, b) => cmp(b.version, a.version));
  const best = found[0];
  const result = { ...best, candidates: found, testedCompatible: TESTED_CODEX_VERSIONS.includes(best.version) };
  cachedResult = result;
  cachedOverrideKey = overrideKey;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = resolveCodex();
  console.log('chosen :', r.path, r.version ? `(${r.version})` : '(none found)');
  if (r.error) console.log('error  :', r.error);
  if (r.testedCompatible === false) console.log(`note   : version ${r.version} is not in tested ${JSON.stringify(TESTED_CODEX_VERSIONS)}`);
  for (const c of r.candidates) console.log('   ', c.version.padEnd(10), c.path);
}
