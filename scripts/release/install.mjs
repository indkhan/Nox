import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Nox requires Node.js 22 or newer.')
  process.exit(1)
}
const result = spawnSync(process.execPath, [join(root, 'bridge', 'install.mjs')], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Load this folder in chrome://extensions:\n${join(root, 'extension', 'dist')}`)
