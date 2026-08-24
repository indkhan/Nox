import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = spawnSync(process.execPath, ['install.mjs', '--dry-run'], {
  cwd: root,
  encoding: 'utf8',
})

assert.equal(run.status, 0, run.stderr)
assert.match(run.stdout, /install dependencies/i)
assert.match(run.stdout, /build extension/i)
assert.match(run.stdout, /install native bridge/i)
assert.match(run.stdout, /extension[/\\]dist/i)

console.log('installer dry-run passed')

if (process.platform === 'win32') {
  const runner = spawnSync(process.execPath, ['install.mjs', '--check-runner'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(runner.status, 0, runner.stderr)
}
