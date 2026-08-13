import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {assertSameInventory, extractArchive, inspectArchive, inspectDirectory} from '../scripts/archive-inventory.mjs';
import {packageRelease} from '../scripts/package-release.mjs';

test('final ZIP inventory matches the safely extracted artifact tree', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-inventory-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'v3');
  await mkdir(path.join(source, 'worker'), {recursive: true});
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await writeFile(path.join(root, 'LICENSE'), 'MPL-2.0 fixture\n');
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0.0',
    background: {service_worker: 'worker/core.mjs', type: 'module'}
  }, null, 2)}\n`);
  await writeFile(path.join(source, 'worker', 'core.mjs'), 'export {};\n');
  const packaged = await packageRelease({
    repositoryRoot: root,
    outputDirectory: path.join(root, 'out'),
    releaseMode: false
  });
  const archivePath = path.join(packaged.outputDirectory, packaged.archives.find(item => item.file.endsWith('.zip')).file);
  const inspected = await inspectArchive(archivePath);
  const destination = path.join(root, 'extracted');
  const extractedFromArchive = await extractArchive(archivePath, destination);
  const extracted = await inspectDirectory(destination);
  assertSameInventory(inspected, extracted);
  assertSameInventory(extractedFromArchive, extracted);
  assert.equal(inspected.treeSha256, packaged.metadata.sourceTreeSha256);
  assert.deepEqual(inspected.inventory.map(item => item.path), packaged.entries);
  assert.deepEqual(inspected.inventory, packaged.metadata.inventory);

  await writeFile(path.join(destination, 'worker', 'core.mjs'), 'export const tampered = true;\n');
  const tampered = await inspectDirectory(destination);
  assert.throws(() => assertSameInventory(inspected, tampered), /inventory differs/);
});
