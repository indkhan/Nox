import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('uses Corepack when pnpm is not installed', () => {
  const bin = mkdtempSync(join(tmpdir(), 'nox-install-'))
  const log = join(bin, 'corepack.log')
  const shim = process.platform === 'win32' ? join(bin, 'corepack.cmd') : join(bin, 'corepack')
  const body = process.platform === 'win32'
    ? `@echo off\r\necho %* > "${log}"\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s' "$*" > "${log}"\n`
  writeFileSync(shim, body)
  if (process.platform !== 'win32') chmodSync(shim, 0o755)

  try {
    const result = spawnSync(process.execPath, [resolve('install.mjs'), '--check-runner'], {
      cwd: resolve('.'),
      env: { ...process.env, PATH: bin },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(log, 'utf8'), /^pnpm@10\.34\.0 --version/)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('uses Corepack when the installed pnpm is older than 10', () => {
  const bin = mkdtempSync(join(tmpdir(), 'nox-install-'))
  const log = join(bin, 'corepack.log')
  const pnpm = process.platform === 'win32' ? join(bin, 'pnpm.cmd') : join(bin, 'pnpm')
  const corepack = process.platform === 'win32' ? join(bin, 'corepack.cmd') : join(bin, 'corepack')
  writeFileSync(pnpm, process.platform === 'win32' ? '@echo 9.15.0\r\n' : '#!/bin/sh\necho 9.15.0\n')
  writeFileSync(corepack, process.platform === 'win32'
    ? `@echo off\r\necho %* > "${log}"\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s' "$*" > "${log}"\n`)
  if (process.platform !== 'win32') {
    chmodSync(pnpm, 0o755)
    chmodSync(corepack, 0o755)
  }

  try {
    const result = spawnSync(process.execPath, [resolve('install.mjs'), '--check-runner'], {
      cwd: resolve('.'),
      env: { ...process.env, PATH: bin },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(log), true, 'Corepack was not called')
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('explains how to sign in when Codex is installed but logged out', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nox-install-'))
  const codex = join(directory, 'codex.mjs')
  writeFileSync(codex, `if (process.argv.includes('--version')) console.log('codex-cli 1.2.3')\nelse process.exit(1)\n`)

  try {
    const result = spawnSync(process.execPath, [resolve('install.mjs'), '--dry-run'], {
      cwd: resolve('.'),
      env: { ...process.env, CODEX_BIN: codex },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Codex is installed but not signed in\. Run: codex login/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid CODEX_BIN fails closed instead of launching another version', async () => {
  const { resolveCodex, clearResolveCodexCacheForTests } = await import('../bridge/resolve-codex.mjs')
  clearResolveCodexCacheForTests?.()
  const missing = join(tmpdir(), `nox-missing-${Date.now()}`, 'codex.mjs')
  process.env.CODEX_BIN = missing
  try {
    const result = resolveCodex()
    assert.equal(result.path, null)
    assert.match(String(result.error ?? ''), /CODEX_BIN/i)
  } finally {
    delete process.env.CODEX_BIN
    clearResolveCodexCacheForTests?.()
  }
})

test('CODEX_BIN names an existing absolute binary and caches discovery', async () => {
  const { resolveCodex, clearResolveCodexCacheForTests } = await import('../bridge/resolve-codex.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'nox-install-'))
  const codex = join(directory, 'codex.mjs')
  writeFileSync(codex, `if (process.argv.includes('--version')) console.log('codex-cli 9.9.9')\n`)
  clearResolveCodexCacheForTests?.()
  process.env.CODEX_BIN = codex
  try {
    const first = resolveCodex()
    const second = resolveCodex()
    assert.equal(first.path, codex)
    assert.equal(first.version, '9.9.9')
    assert.equal(second.path, codex)
  } finally {
    delete process.env.CODEX_BIN
    clearResolveCodexCacheForTests?.()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bare PATH codex resolves to an absolute path', async () => {
  const mod = await import('../bridge/resolve-codex.mjs')
  assert.equal(typeof mod.resolveBareExecutable, 'function')
  const directory = mkdtempSync(join(tmpdir(), 'nox-install-'))
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  // Sentinel only: never executed, only resolved to an absolute path.
  writeFileSync(join(directory, name), 'sentinel')
  try {
    const resolved = mod.resolveBareExecutable(name, directory)
    assert.equal(resolved, resolve(join(directory, name)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('generated wrappers quote special-character paths without executing them', async () => {
  const mod = await import('../bridge/install.mjs')
  assert.equal(typeof mod.buildShWrapper, 'function')
  assert.equal(typeof mod.buildBatWrapper, 'function')
  // Sentinel strings only: assert quoting, never spawn them.
  // POSIX: single-quote escaping must split embedded quotes so $/`/" never expand.
  const shTrickyNode = `/tmp/a'b$c\`d "e node`
  const shTrickyScript = `/tmp/a'b/script.mjs`
  const sh = mod.buildShWrapper(shTrickyNode, shTrickyScript)
  assert.ok(sh.startsWith('#!/bin/sh'))
  assert.ok(sh.includes(`"$@"`))
  assert.ok(!sh.includes(shTrickyNode))
  assert.ok(sh.includes(`'"'"'`))
  // Windows batch: % must double (still expands inside quotes); &() and spaces stay quoted.
  const batTrickyNode = `C:\\a&b (x)%y\\node.exe`
  const batTrickyScript = `C:\\a&b (x)\\nox-bridge.mjs`
  const bat = mod.buildBatWrapper(batTrickyNode, batTrickyScript)
  assert.match(bat, /@echo off/)
  assert.ok(bat.includes('%%'))
  assert.ok(bat.includes('%*'))
  assert.ok(bat.includes(`"C:\\a&b (x)%%y\\node.exe"`))
})

test('reports missing Codex instead of crashing', () => {
  const result = spawnSync(process.execPath, [resolve('install.mjs'), '--dry-run'], {
    cwd: resolve('.'),
    env: { ...process.env, CODEX_BIN: join(tmpdir(), 'nox-definitely-missing-codex-bin') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Codex/i)
})

test('spike callback binds loopback, tolerates invalid callbacks, writes atomically', async () => {
  const mod = await import('../spikes/notion-auth.mjs')
  assert.equal(mod.LOOPBACK_HOST, '127.0.0.1')
  assert.ok(mod.MAX_CALLBACK_BYTES >= 1024)
  // Synthetic URLs only — no network, no real tokens.
  const good = mod.validateCallbackRequest('/callback?code=abc&state=s1', { state: 's1', issuer: 'https://auth.example/' })
  assert.equal(good.ok, true)
  const badState = mod.validateCallbackRequest('/callback?code=abc&state=wrong', { state: 's1', issuer: 'https://auth.example/' })
  assert.equal(badState.ok, false)
  const badIss = mod.validateCallbackRequest('/callback?code=abc&state=s1&iss=https://evil.example/', { state: 's1', issuer: 'https://auth.example/' })
  assert.equal(badIss.ok, false)
  const notFound = mod.validateCallbackRequest('/other', { state: 's1', issuer: 'https://auth.example/' })
  assert.equal(notFound.ok, false)
  // Atomic synthetic token write in an isolated temp dir.
  const dir = mkdtempSync(join(tmpdir(), 'nox-spike-'))
  try {
    const file = join(dir, 'token.json')
    mod.writeTokenAtomic(file, { access_token: 'SYNTHETIC', refresh_token: 'SYNTHETIC', expires_in: 3600 })
    assert.match(readFileSync(file, 'utf8'), /SYNTHETIC/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasChrome reports unsupported browsers without crashing', async () => {
  const mod = await import('../install.mjs')
  assert.equal(typeof mod.hasChrome, 'function')
  assert.equal(mod.hasChrome({ existsSync: () => false, platform: () => 'win32' }), false)
  assert.equal(typeof mod.quoteCmdArg, 'function')
  assert.equal(mod.quoteCmdArg('simple'), 'simple')
  assert.ok(mod.quoteCmdArg('C:\\a&b (x)%y').includes('%%'))
})
