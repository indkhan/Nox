// Install the Nox native messaging host for Chrome.
// Windows: manifest file + HKCU registry key. macOS/Linux: manifest in Chrome's config dir.
// Run: node bridge/install.mjs
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HOST = 'com.nox.bridge';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const { id } = JSON.parse(readFileSync(join(ROOT, 'extension-id.json'), 'utf8'));

const isWin = platform() === 'win32';
const script = join(HERE, 'nox-bridge.mjs');

// Chrome executes the `path` directly. On Windows a .mjs is not executable, so we
// shell out through a .bat wrapper. Elsewhere a shebang shim works.
let execPath;
if (isWin) {
  execPath = join(HERE, 'nox-bridge.bat');
  writeFileSync(execPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
} else {
  execPath = join(HERE, 'nox-bridge.sh');
  writeFileSync(execPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
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
