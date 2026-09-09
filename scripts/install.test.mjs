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
