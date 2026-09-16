import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluatePublishGateEvidence } from './publish-gate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptArgs = new Set(process.argv.slice(2))
const publishGate = scriptArgs.has('--publish-gate') || scriptArgs.has('--require-live-evidence')

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
console.log('[release smoke] Automated checks only. Live acceptance (C01–C17) always needs docs/smoke.md on a real scratch workspace.')

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
console.log('Live acceptance (C01–C17) is NOT covered by this script. Complete docs/smoke.md with a real scratch Notion workspace before publishing; see docs/adversarial-remediation-evidence.md. Skipped opt-in cases are pending, never passed.')

if (publishGate) checkPublishGate()

export function quoteCmdArg(value) {
  const s = String(value)
  if (!/[\s"%&()<>|^!]/.test(s)) return s
  return `"${s.replaceAll('%', '%%').replaceAll('"', '""')}"`
}

/**
 * Publishing gate: rejects unless the evidence log records an explicit PASS
 * for every required live scenario C01–C17 plus a `Publish gate: PASS`
 * marker. Automated success alone never publishes a release advertising
 * live-verified behavior.
 */
export function checkPublishGate() {
  const evidencePath = join(root, 'docs', 'adversarial-remediation-evidence.md')
  if (!existsSync(evidencePath)) {
    console.error('\nPublish gate: BLOCKED — docs/adversarial-remediation-evidence.md is missing. Live acceptance has no recorded evidence.')
    process.exit(1)
  }
  const text = readFileSync(evidencePath, 'utf8')
  const { ok, missing } = evaluatePublishGateEvidence(text)
  if (ok) {
    console.log('\nPublish gate: PASS — every required live scenario C01–C17 is recorded PASS in docs/adversarial-remediation-evidence.md.')
    return
  }
  console.error(`\nPublish gate: BLOCKED — missing required live evidence for: ${missing.length > 0 ? missing.join(', ') : 'the explicit PASS marker'}.`)
  console.error('Complete docs/smoke.md C01–C17 against the recorded candidate build and update docs/adversarial-remediation-evidence.md before publishing.')
  process.exit(1)
}

function run(command, args) {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  }
  const line = [command, ...args].map((value) => quoteCmdArg(value)).join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: root, stdio: 'inherit' })
}
