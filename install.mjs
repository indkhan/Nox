import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')
const checkRunner = process.argv.includes('--check-runner')

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Nox requires Node.js 22 or newer.')
  process.exit(1)
}

const steps = [
  ['Install dependencies', 'pnpm', ['--dir', join(root, 'extension'), 'install', '--frozen-lockfile']],
  ['Build extension', 'pnpm', ['--dir', join(root, 'extension'), 'build']],
  ['Install native bridge', process.execPath, [join(root, 'bridge', 'install.mjs')]],
]

if (checkRunner) {
  const result = run('pnpm', ['--version'])
  process.exit(result.status ?? 1)
}

for (const [label, command, args] of steps) {
  console.log(`\n${label}...`)
  if (dryRun) continue
  const result = run(command, args)
  if (result.error?.code === 'ENOENT') {
    console.error('pnpm is missing. Install pnpm 10+, then run this command again.')
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`\nReady. In chrome://extensions, enable Developer mode, choose Load unpacked, and select:\n${join(root, 'extension', 'dist')}`)

function run(command, args) {
  if (process.platform !== 'win32' || command !== 'pnpm') {
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  }
  const line = [command, ...args.map((arg) => /\s/.test(String(arg)) ? `"${String(arg).replaceAll('"', '""')}"` : String(arg))].join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: root, stdio: 'inherit' })
}
