import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

// Version mapping (single source: extension/package.json):
// - Chrome numeric `version` (dist manifest) must equal package.json `version`.
// - Display/tag label: `v<version>-alpha` (e.g. v0.1.0-alpha).
// - Artifact names `nox-v<version>.zip` / `nox-extension-v<version>.zip` keep the
//   existing scheme; published releases are never renamed retroactively.

/** Read and cross-check the single version source. Throws on mismatch. */
export function readReleaseVersion(repoRoot = root) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'extension', 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'extension', 'dist', 'manifest.json'), 'utf8'))
  if (!pkg.version || !manifest.version) throw new Error('missing version in package.json or dist manifest.json (run pnpm build first)')
  if (pkg.version !== manifest.version) {
    throw new Error(`version mismatch: package.json ${pkg.version} vs dist manifest ${manifest.version}`)
  }
  return pkg.version
}

/**
 * Assemble third-party notices from installed package metadata plus the
 * checked-in font provenance file. Never invents provenance from filenames:
 * JS entries come from node_modules package.json files; font entries come
 * from extension/src/sidepanel/fonts/NOTICES.md (family/license only,
 * versions explicitly unverified).
 */
export function collectThirdPartyNotices(repoRoot = root) {
  const lines = []
  lines.push('Nox third-party notices')
  lines.push('========================')
  lines.push('')
  lines.push('Root license: MIT (see LICENSE).')
  lines.push('')
  const distPkg = join(repoRoot, 'extension', 'package.json')
  let deps = {}
  try {
    const pkg = JSON.parse(readFileSync(distPkg, 'utf8'))
    deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  } catch {}
  // Only notices for packages actually bundled into dist are load-bearing;
  // list runtime dependencies first, then the build/test toolchain marker.
  const runtime = ['dompurify', 'idb', 'marked', 'react', 'react-dom', 'zustand']
  lines.push('Bundled runtime JavaScript (from installed package metadata):')
  for (const name of runtime) {
    const meta = readInstalledMeta(repoRoot, name)
    lines.push(`- ${name}@${meta?.version ?? deps[name] ?? 'unknown'} — license ${meta?.license ?? 'unknown'}${meta?.repository ? ` (${meta.repository})` : ''}`)
  }
  lines.push('')
  lines.push('Build/test toolchain: see extension/pnpm-lock.yaml for exact resolved versions.')
  lines.push('')
  lines.push('Bundled fonts (from extension/src/sidepanel/fonts/NOTICES.md):')
  try {
    const fonts = readFileSync(join(repoRoot, 'extension', 'src', 'sidepanel', 'fonts', 'NOTICES.md'), 'utf8')
    for (const line of fonts.split('\n')) {
      if (/^\| (Inter|JetBrains)/.test(line)) lines.push(`  ${line.trim()}`)
    }
    lines.push('  (Font file versions/sources unverified; see that file. OFL 1.1 is each family\'s authoritative license.)')
  } catch {
    lines.push('  (font provenance file missing — resolve before claiming font compliance)')
  }
  lines.push('')
  return lines.join('\n')
}

function readInstalledMeta(repoRoot, name) {
  for (const base of [join(repoRoot, 'extension', 'node_modules', name, 'package.json')]) {
    try {
      const meta = JSON.parse(readFileSync(base, 'utf8'))
      let repository = null
      if (typeof meta.repository === 'string') repository = meta.repository
      else if (meta.repository?.url) repository = meta.repository.url
      return { version: meta.version, license: meta.license ?? meta.licenses ?? 'unknown', repository }
    } catch {}
  }
  return null
}

/** File names that must never appear in a release archive. */
export const FORBIDDEN_ARCHIVE_PATTERNS = [
  /extension-key\.json$/,
  /\.notion-token\.json$/,
  /com\.nox\.bridge\.json$/,
  /nox-bridge\.(bat|sh)$/,
  /\.log$/,
]

/**
 * Stage release files into `stagingDir` (created by caller) and return
 * { version, stage, bundle, extensionZip, notices }.
 * `outDir` receives the two ZIP paths (defaults to repo root, gitignored).
 * Only the two output ZIP paths are removed before writing; nothing else is
 * deleted (never wipes .release/ or source/build output).
 */
export function stageRelease({ repoRoot = root, outDir = root, stagingDir } = {}) {
  const version = readReleaseVersion(repoRoot)
  const stage = stagingDir ?? mkdtempSync(join(tmpdir(), 'nox-release-'))
  const bundle = join(outDir, `nox-v${version}.zip`)
  const extensionZip = join(outDir, `nox-extension-v${version}.zip`)

  const notices = collectThirdPartyNotices(repoRoot)
  mkdirSync(join(stage, 'extension'), { recursive: true })
  cpSync(join(repoRoot, 'extension', 'dist'), join(stage, 'extension', 'dist'), { recursive: true })
  cpSync(join(repoRoot, 'bridge'), join(stage, 'bridge'), {
    recursive: true,
    filter: (source) => !/com\.nox\.bridge\.json$|nox-bridge\.(bat|sh)$/.test(source),
  })
  cpSync(join(repoRoot, 'extension-id.json'), join(stage, 'extension-id.json'))
  cpSync(join(repoRoot, 'scripts', 'release', 'install.mjs'), join(stage, 'install.mjs'))
  cpSync(join(repoRoot, 'scripts', 'release', 'README.md'), join(stage, 'README.md'))
  writeFileSync(join(stage, 'LICENSE'), readFileSync(join(repoRoot, 'LICENSE'), 'utf8'))
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices)

  // Extension-only archive staging: dist files + LICENSE + notices.
  const extStage = mkdtempSync(join(tmpdir(), 'nox-extension-'))
  cpSync(join(repoRoot, 'extension', 'dist'), extStage, { recursive: true })
  writeFileSync(join(extStage, 'LICENSE'), readFileSync(join(repoRoot, 'LICENSE'), 'utf8'))
  writeFileSync(join(extStage, 'THIRD-PARTY-NOTICES.txt'), notices)

  return { version, stage, extStage, bundle, extensionZip, notices }
}

export function zipDirectory(directory, output) {
  rmSync(output, { force: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${directory.replaceAll("'", "''")}\\*' -DestinationPath '${output.replaceAll("'", "''")}' -Force`],
    { stdio: 'inherit' })
  } else {
    execFileSync('zip', ['-qr', output, '.'], { cwd: directory, stdio: 'inherit' })
  }
}

if (isMain) {
  const outDir = process.env.NOX_RELEASE_OUT_DIR ?? root
  const { version, stage, extStage, bundle, extensionZip } = stageRelease({ outDir })
  try {
    zipDirectory(extStage, extensionZip)
    zipDirectory(stage, bundle)
    console.log(`Created ${extensionZip}`)
    console.log(`Created ${bundle}`)
    console.log(`Version ${version} (display v${version}-alpha)`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(extStage, { recursive: true, force: true })
  }
}
