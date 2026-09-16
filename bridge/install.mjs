// Install the Nox native messaging host for Chrome.
// Windows: manifest file + HKCU registry key. macOS/Linux: manifest in Chrome's config dir.
// Run: node bridge/install.mjs [--uninstall]
// Moving the checkout breaks the absolute host paths below; re-run this installer
// from the new location (update procedure). Uninstall removes the registration
// and generated wrappers; it never touches Codex login (~/.codex) or history.
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const HOST = 'com.nox.bridge';

/**
 * Quote one argument for POSIX /bin/sh double-quote context-free use.
 * Wraps in single quotes; embedded single quotes become '\''. This safely
 * carries spaces, double quotes, dollar signs, and backticks without expansion.
 * Pure string transform — never spawns a shell (sentinel-safe for tests).
 */
export function quoteSh(value) {
  return `'${String(value).replaceAll(`'`, `'"'"'`)}'`;
}

/** Build the POSIX wrapper body for (nodePath, scriptPath). No execution. */
export function buildShWrapper(nodePath, scriptPath) {
  return `#!/bin/sh\nexec ${quoteSh(nodePath)} ${quoteSh(scriptPath)} "$@"\n`;
}

/**
 * Escape one path for a Windows .bat wrapper inside double quotes.
 * `"` is illegal in Windows filenames so quoting is sufficient for it;
 * `%` still expands inside quotes in batch, so it becomes `%%`.
 * `&`, `(`, `)`, spaces are safe inside the quotes. Pure string transform.
 */
export function escapeBatPath(value) {
  return String(value).replaceAll('%', '%%');
}

/** Build the Windows .bat wrapper body for (nodePath, scriptPath). No execution. */
export function buildBatWrapper(nodePath, scriptPath) {
  return `@echo off\r\n"${escapeBatPath(nodePath)}" "${escapeBatPath(scriptPath)}" %*\r\n`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

function wrapperPaths(isWin, here = HERE) {
  return isWin ? [join(here, 'nox-bridge.bat')] : [join(here, 'nox-bridge.sh')];
}

export function uninstallBridge(options = {}) {
  const here = options.here ?? HERE;
  const win = options.isWin ?? platform() === 'win32';
  const manifestFile = join(here, `${HOST}.json`);
  for (const p of wrapperPaths(win, here)) rmSync(p, { force: true });
  rmSync(manifestFile, { force: true });
  if (options.skipRegistry) return;
  if (win) {
    try {
      execFileSync('reg', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, '/f'], { stdio: 'inherit' });
    } catch {}
  } else {
    const dirs = platform() === 'darwin'
      ? [join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
         join(homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts')]
      : [join(homedir(), '.config/google-chrome/NativeMessagingHosts'),
         join(homedir(), '.config/chromium/NativeMessagingHosts')];
    for (const d of dirs) rmSync(join(d, `${HOST}.json`), { force: true });
  }
  console.log(`  ✕ ${HOST} registration removed. Codex login/history (~/.codex) untouched.`);
}

if (isMain) {
  const { id } = JSON.parse(readFileSync(join(ROOT, 'extension-id.json'), 'utf8'));

  const isWin = platform() === 'win32';
  const script = join(HERE, 'nox-bridge.mjs');

  if (process.argv.includes('--uninstall')) {
    uninstallBridge({ isWin });
    process.exit(0);
  }

// Chrome executes the `path` directly. On Windows a .mjs is not executable, so we
// shell out through a .bat wrapper. Elsewhere a shebang shim works.
  let execPath;
  if (isWin) {
    execPath = join(HERE, 'nox-bridge.bat');
    writeFileSync(execPath, buildBatWrapper(process.execPath, script));
  } else {
    execPath = join(HERE, 'nox-bridge.sh');
    writeFileSync(execPath, buildShWrapper(process.execPath, script), { mode: 0o755 });
  }

  const manifest = {
    name: HOST,
    description: 'Nox bridge to codex app-server',
    path: execPath,
    type: 'stdio',
    // allowed_origins takes exact ids — no wildcards (RESEARCH §3.5)
    allowed_origins: [`chrome-extension://${id}/`],
  };

  const manifestPath = join(HERE, `${HOST}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (isWin) {
    execFileSync('reg', [
      'add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
      '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
    ], { stdio: 'inherit' });
  } else {
    const dirs = platform() === 'darwin'
      ? [join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
         join(homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts')]
      : [join(homedir(), '.config/google-chrome/NativeMessagingHosts'),
         join(homedir(), '.config/chromium/NativeMessagingHosts')];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${HOST}.json`), JSON.stringify(manifest, null, 2));
      console.log('  installed →', join(d, `${HOST}.json`));
    }
  }

  console.log(`\n  ✔ ${HOST} installed for extension ${id}`);
  console.log(`    host script : ${script}`);
  console.log('    Restart Chrome, then click "Connect Codex" in the Nox panel.\n');
}
