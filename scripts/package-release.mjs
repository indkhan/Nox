import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'extension', 'dist', 'manifest.json'), 'utf8'))
const stage = join(root, '.release', `nox-v${version}`)
const bundle = join(root, `nox-v${version}.zip`)
const extensionZip = join(root, `nox-extension-v${version}.zip`)

rmSync(join(root, '.release'), { recursive: true, force: true })
rmSync(bundle, { force: true })
rmSync(extensionZip, { force: true })
mkdirSync(join(stage, 'extension'), { recursive: true })
cpSync(join(root, 'extension', 'dist'), join(stage, 'extension', 'dist'), { recursive: true })
cpSync(join(root, 'bridge'), join(stage, 'bridge'), {
  recursive: true,
  filter: (source) => !/com\.nox\.bridge\.json$|nox-bridge\.(bat|sh)$/.test(source),
})
cpSync(join(root, 'extension-id.json'), join(stage, 'extension-id.json'))
cpSync(join(root, 'scripts', 'release', 'install.mjs'), join(stage, 'install.mjs'))
cpSync(join(root, 'scripts', 'release', 'README.md'), join(stage, 'README.md'))

zipDirectory(join(root, 'extension', 'dist'), extensionZip)
zipDirectory(stage, bundle)
console.log(`Created ${extensionZip}`)
console.log(`Created ${bundle}`)

function zipDirectory(directory, output) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${directory.replaceAll("'", "''")}\\*' -DestinationPath '${output.replaceAll("'", "''")}' -Force`],
    { stdio: 'inherit' })
  } else {
    execFileSync('zip', ['-qr', output, '.'], { cwd: directory, stdio: 'inherit' })
  }
}
