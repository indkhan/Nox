import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = [
  ['typecheck', 'pnpm', ['--dir', 'extension', 'typecheck']],
  ['tests', 'pnpm', ['--dir', 'extension', 'test']],
  ['production build', 'pnpm', ['--dir', 'extension', 'build']],
  ['native bridge', process.execPath, ['bridge/test-bridge.mjs']],
  ['release archives', process.execPath, ['scripts/package-release.mjs']],
]

for (const [label, command, args] of checks) {
  console.log(`\n[release smoke] ${label}`)
  const result = run(command, args)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('\nAutomated release smoke passed. Complete docs/smoke.md with a real scratch Notion workspace before publishing.')

function run(command, args) {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  }
  const line = [command, ...args].map((value) => /\s/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: root, stdio: 'inherit' })
}
