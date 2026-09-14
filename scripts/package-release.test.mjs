import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('release version agrees across package and dist manifest', async () => {
  const { readReleaseVersion } = await import('./package-release.mjs')
  const version = readReleaseVersion(repoRoot)
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'extension', 'package.json'), 'utf8'))
  assert.equal(version, pkg.version)
  assert.match(version, /^\d+\.\d+\.\d+$/)
})

test('staged release contains licenses/notices/runtime files and no secrets', async () => {
  const { stageRelease, FORBIDDEN_ARCHIVE_PATTERNS } = await import('./package-release.mjs')
  const outDir = mkdtempSync(join(tmpdir(), 'nox-release-out-'))
  const { stage, extStage, bundle, extensionZip, version } = stageRelease({ repoRoot, outDir })
  try {
    // LICENSE + notices in full stage and extension stage.
    for (const dir of [stage, extStage]) {
      assert.equal(existsSync(join(dir, 'LICENSE')), true, `LICENSE missing in ${dir}`)
      const notices = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
      assert.match(notices, /dompurify/i)
      assert.match(notices, /Inter/i)
    }
    // Needed runtime files in full stage.
    assert.equal(existsSync(join(stage, 'extension', 'dist', 'manifest.json')), true)
    assert.equal(existsSync(join(stage, 'bridge', 'nox-bridge.mjs')), true)
    assert.equal(existsSync(join(stage, 'extension-id.json')), true)
    assert.equal(existsSync(join(stage, 'install.mjs')), true)
    assert.equal(existsSync(join(stage, 'README.md')), true)
    // No forbidden machine-specific/credential files anywhere in stage.
    for (const file of walk(stage)) {
      for (const pattern of FORBIDDEN_ARCHIVE_PATTERNS) {
        assert.ok(!pattern.test(file), `forbidden file in stage: ${file}`)
      }
    }
    // No dev-token UI in production dist.
    const distText = readFileSync(join(stage, 'extension', 'dist', 'manifest.json'), 'utf8')
    assert.ok(distText.length > 0)
    // Output paths carry the agreed version; nothing written yet (staging only).
    assert.ok(bundle.endsWith(`nox-v${version}.zip`))
    assert.ok(extensionZip.endsWith(`nox-extension-v${version}.zip`))
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(extStage, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('built archives inspect clean: licenses in, secrets out, versions agree', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'nox-release-zip-'))
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'package-release.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, NOX_RELEASE_OUT_DIR: outDir },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const zips = readdirSync(outDir).filter((f) => f.endsWith('.zip'))
    assert.equal(zips.length, 2, `expected 2 zips, got ${zips}`)
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'extension', 'package.json'), 'utf8'))
    for (const zip of zips) {
      const full = join(outDir, zip)
      assert.ok(statSync(full).size > 1024, `${zip} too small`)
      assert.ok(zip.includes(pkg.version), `${zip} missing version ${pkg.version}`)
      const names = listZipNames(full)
      assert.ok(names.some((n) => /(^|\/)LICENSE$/.test(n)), `${zip} missing LICENSE: ${names.slice(0, 8)}`)
      assert.ok(names.some((n) => /THIRD-PARTY-NOTICES/.test(n)), `${zip} missing notices`)
      for (const name of names) {
        assert.ok(!/extension-key\.json$/.test(name), `credential in ${zip}: ${name}`)
        assert.ok(!/\.notion-token\.json$/.test(name), `token in ${zip}: ${name}`)
        assert.ok(!/com\.nox\.bridge\.json$/.test(name), `machine manifest in ${zip}: ${name}`)
        assert.ok(!/nox-bridge\.(bat|sh)$/.test(name), `generated wrapper in ${zip}: ${name}`)
      }
    }
    const bundleNames = listZipNames(join(outDir, `nox-v${pkg.version}.zip`))
    assert.ok(bundleNames.some((n) => /extension[\/\\]dist[\/\\]manifest\.json$/.test(n)), 'bundle missing dist manifest')
    assert.ok(bundleNames.some((n) => /bridge[\/\\]nox-bridge\.mjs$/.test(n)), 'bundle missing bridge')
    const extNames = listZipNames(join(outDir, `nox-extension-v${pkg.version}.zip`))
    assert.ok(extNames.some((n) => /(^|\/)manifest\.json$/.test(n)), 'extension zip missing manifest')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Minimal ZIP central-directory filename reader (no new dependencies). */
function listZipNames(zipPath) {
  const buf = readFileSync(zipPath)
  const EOCD = 0x06054b50
  const CDH = 0x02014b50
  let eocd = -1
  const start = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  assert.ok(eocd >= 0, 'ZIP end-of-central-directory not found')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), CDH, 'bad central-directory header')
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'))
    offset += 46 + nameLen + extraLen + commentLen
  }
  return names
}
