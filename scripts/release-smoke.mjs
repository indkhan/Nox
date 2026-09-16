import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout).trim() : 'unknown'
}

console.log(`[release smoke] node ${process.version}, extension ${pkgVersion()}, git ${gitHead()}, date ${new Date().toISOString()}`)
console.log('[release smoke] Automated checks only. Complete docs/smoke.md separately on a real scratch workspace.')

const checks = [
  ['typecheck', 'pnpm', ['--dir', 'extension', 'typecheck']],
  ['tests', 'pnpm', ['--dir', 'extension', 'test']],
  ['production build', 'pnpm', ['--dir', 'extension', 'build']],
  ['evaluation ledger', process.execPath, ['--test', 'scripts/live/answer-quality-eval.test.mjs']],
  ['installer tests', process.execPath, ['--test', 'scripts/install.test.mjs']],
  ['archive-content tests', process.execPath, ['--test', 'scripts/package-release.test.mjs']],
  ['native bridge', process.execPath, ['bridge/test-bridge.mjs']],
  ['release archives', process.execPath, ['scripts/package-release.mjs']],
  ['full audit (dev)', 'pnpm', ['--dir', 'extension', 'audit', '--json']],
  ['production audit', 'pnpm', ['--dir', 'extension', 'audit', '--prod', '--json']],
]

for (const [label, command, args] of checks) {
  console.log(`\n[release smoke] ${label}`)
  const result = run(command, args)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('\nAutomated release smoke passed (unit/integration/build/bridge/archives/audits).')
console.log('Live browser and workspace checks are not covered by this script. Skipped opt-in cases are pending, never passed.')

export function quoteCmdArg(value) {
  const s = String(value)
  if (!/[\s"%&()<>|^!]/.test(s)) return s
  return `"${s.replaceAll('%', '%%').replaceAll('"', '""')}"`
}

function run(command, args) {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  }
  const line = [command, ...args].map((value) => quoteCmdArg(value)).join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: root, stdio: 'inherit' })
}
