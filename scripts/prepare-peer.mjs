import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const peer = resolve(root, 'peer');
const check = process.argv.includes('--check');
const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/genosdb/package.json'), 'utf8'));
if (pkg.version !== '0.34.0') throw new Error('Review server compatibility before changing GenosDB.');
const copies = [
  ['node_modules/genosdb/dist/genossrv.min.js', 'vendor/genossrv.min.js'],
  ['node_modules/genosdb/LICENSE', 'vendor/LICENSE'],
  ['src/model.ts', 'shared/model.ts'],
  ['src/store.ts', 'shared/store.ts'],
  ['src/peer-proof.mjs', 'shared/verify.mjs'],
];
for (const [source, target] of copies) {
  if (check) {
    const actual = await readFile(resolve(peer, target));
    if (!actual.equals(await readFile(resolve(root, source)))) throw new Error(`Stale peer file: ${target}. Run npm run peer:prepare.`);
  } else {
    await mkdir(dirname(resolve(peer, target)), { recursive: true });
    await copyFile(resolve(root, source), resolve(peer, target));
  }
}
const manifest = { genosdb: pkg.version, sha256: {} };
for (const target of ['server.ts', 'policy.ts', ...copies.map(([, target]) => target)]) {
  manifest.sha256[target] = createHash('sha256').update(await readFile(resolve(peer, target))).digest('hex');
}
const content = JSON.stringify(manifest, null, 2) + '\n';
if (check) {
  if (await readFile(resolve(peer, 'manifest.json'), 'utf8') !== content) throw new Error('Stale peer manifest. Run npm run peer:prepare.');
} else await writeFile(resolve(peer, 'manifest.json'), content);
console.log(check ? 'Peer files and checksums match.' : 'Prepared standalone Bun peer files.');
