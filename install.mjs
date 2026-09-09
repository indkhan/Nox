import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCodex } from './bridge/resolve-codex.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')
const checkRunner = process.argv.includes('--check-runner')
const pnpmVersion = '10.34.0'

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Nox requires Node.js 22 or newer.')
  process.exit(1)
}

let pnpm = ['pnpm', []]
const installedPnpm = run('pnpm', ['--version'], 'pipe')
const installedPnpmMajor = Number(String(installedPnpm.stdout ?? '').trim().split('.')[0])
if (installedPnpm.status !== 0 || !Number.isInteger(installedPnpmMajor) || installedPnpmMajor < 10) {
  console.log(`pnpm 10+ is unavailable; downloading pnpm ${pnpmVersion} through Corepack...`)
  pnpm = ['corepack', [`pnpm@${pnpmVersion}`]]
  const result = run(pnpm[0], [...pnpm[1], '--version'])
  if (result.status !== 0) {
    console.error('Could not obtain pnpm through Corepack. Reinstall Node.js 22 with Corepack, then run this command again.')
    process.exit(result.status ?? 1)
  }
}

if (checkRunner) process.exit(0)

const codex = resolveCodex()
if (!codex.path) {
  console.log('Codex is missing. Install it with: npm install -g @openai/codex')
  console.log('Then sign in with: codex login')
} else {
  const command = codex.launcher ?? codex.path
  const args = codex.launcher ? [codex.path, 'login', 'status'] : ['login', 'status']
  if (run(command, args, 'pipe').status !== 0) {
    console.log('Codex is installed but not signed in. Run: codex login')
  }
}

if (!hasChrome()) {
  console.log('Chrome was not found in a standard location. Install Chrome before loading Nox.')
}

const steps = [
  ['Install dependencies', pnpm[0], [...pnpm[1], '--dir', join(root, 'extension'), 'install', '--frozen-lockfile']],
  ['Build extension', pnpm[0], [...pnpm[1], '--dir', join(root, 'extension'), 'build']],
  ['Install native bridge', process.execPath, [join(root, 'bridge', 'install.mjs')]],
]

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

function run(command, args, stdio = 'inherit') {
  if (process.platform !== 'win32' || !['pnpm', 'corepack'].includes(command)) {
    return spawnSync(command, args, { cwd: root, stdio })
  }
  const line = [command, ...args.map((arg) => /\s/.test(String(arg)) ? `"${String(arg).replaceAll('"', '""')}"` : String(arg))].join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { cwd: root, stdio })
}

function hasChrome() {
  if (platform() === 'win32') {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .some((base) => existsSync(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')))
  }
  if (platform() === 'darwin') return existsSync('/Applications/Google Chrome.app')
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .some((command) => run('which', [command], 'pipe').status === 0)
}
