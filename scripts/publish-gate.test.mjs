import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluatePublishGateEvidence } from './publish-gate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function allPassEvidence() {
  const rows = []
  for (let i = 1; i <= 17; i++) {
    const id = `C${String(i).padStart(2, '0')}`
    rows.push(`| ${id} | PASS | note |`)
  }
  return `${rows.join('\n')}\n\nPublish gate: PASS\n`
}

test('publish gate passes only with all C01–C17 PASS plus the explicit marker', () => {
  const result = evaluatePublishGateEvidence(allPassEvidence())
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
  assert.equal(result.marker, true)
})

test('publish gate blocks when one row is BLOCKED and names it', () => {
  const text = allPassEvidence().replace('| C07 | PASS |', '| C07 | BLOCKED |')
  const result = evaluatePublishGateEvidence(text)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['C07'])
})

test('publish gate blocks when the marker is missing even if all rows pass', () => {
  const text = allPassEvidence().replace('\nPublish gate: PASS\n', '\n')
  const result = evaluatePublishGateEvidence(text)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [])
  assert.equal(result.marker, false)
})

test('publish gate blocks on empty or non-string input without claiming rows', () => {
  for (const input of ['', undefined, null]) {
    const result = evaluatePublishGateEvidence(input)
    assert.equal(result.ok, false)
    assert.equal(result.missing.length, 17)
    assert.equal(result.marker, false)
  }
})

test('current evidence log stays BLOCKED: no false live PASS without a scratch run', () => {
  const text = readFileSync(join(repoRoot, 'docs', 'adversarial-remediation-evidence.md'), 'utf8')
  const result = evaluatePublishGateEvidence(text)
  assert.equal(result.ok, false)
  assert.ok(result.missing.length > 0)
})

test('release smoke still gates publishing on live evidence, not on automated checks alone', async () => {
  const smoke = readFileSync(join(repoRoot, 'scripts', 'release-smoke.mjs'), 'utf8')
  assert.match(smoke, /evaluatePublishGateEvidence/)
  assert.match(smoke, /--publish-gate/)
  assert.match(smoke, /C01.*C17|every required live scenario/i)
})
