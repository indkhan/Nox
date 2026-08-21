// E1 story 1 — pin the extension ID.
// Native messaging `allowed_origins` takes exact ids and no wildcards, and the Notion OAuth
// redirect URI is https://<id>.chromiumapp.org/. Both break if the id moves, and unpacked
// extensions get a random id unless the manifest carries a `key`.
// Run once: node spikes/gen-key.mjs
import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension-key.json');

if (existsSync(OUT)) {
  console.log(`${OUT} already exists — refusing to overwrite (the id would change).`);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Chrome's id = first 128 bits of sha256(DER public key), hex digits mapped 0-f → a-p.
const hash = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const key = publicKey.toString('base64');

writeFileSync(OUT, JSON.stringify({ id, key, privateKey }, null, 2));

console.log('\n  extension id : ' + id);
console.log('  redirect uri : https://' + id + '.chromiumapp.org/');
console.log('  native origin: chrome-extension://' + id + '/');
console.log('\n  written to extension-key.json (gitignored — keep it, the id depends on it)\n');
