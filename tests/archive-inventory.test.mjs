import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {assertSameInventory, extractArchive, inspectArchive, inspectDirectory} from '../scripts/archive-inventory.mjs';
import {packageRelease} from '../scripts/package-release.mjs';

test('each target archive inventory matches its independently extracted artifact tree', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-inventory-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'v3');
  await mkdir(path.join(source, 'firefox'), {recursive: true});
  await mkdir(path.join(source, 'worker'), {recursive: true});
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await writeFile(path.join(root, 'LICENSE'), 'MPL-2.0 fixture\n');
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0.0',
    background: {
      page: '/firefox/background.html',
      service_worker: 'worker/core.mjs',
      type: 'module'
    }
  }, null, 2)}\n`);
  await writeFile(path.join(source, 'firefox', 'background.html'), [
    '<script type="module" src="compatibility.mjs"></script>',
    '<script type="module" src="/worker/core.mjs"></script>',
    ''
  ].join('\n'));
  await writeFile(path.join(source, 'firefox', 'compatibility.mjs'), 'export {};\n');
  await writeFile(path.join(source, 'worker', 'core.mjs'), 'export {};\n');
  const packaged = await packageRelease({
    repositoryRoot: root,
    outputDirectory: path.join(root, 'out'),
    releaseMode: false
  });
  const inspectedByTarget = {};
  const destinations = {};
  for (const target of ['chromium', 'firefox']) {
    const artifact = packaged.metadata.artifacts[target];
    const archivePath = path.join(packaged.outputDirectory, artifact.file);
    const inspected = await inspectArchive(archivePath);
    const destination = path.join(root, 'extracted', target);
    const extractedFromArchive = await extractArchive(archivePath, destination);
    const extracted = await inspectDirectory(destination);
    assertSameInventory(inspected, extracted);
    assertSameInventory(extractedFromArchive, extracted);
    assert.equal(inspected.treeSha256, artifact.treeSha256);
    assert.equal(inspected.archiveSha256, artifact.sha256);
    assert.equal(inspected.archiveBytes, artifact.bytes);
    assert.deepEqual(inspected.inventory.map(item => item.path), packaged.entries[target]);
    assert.deepEqual(inspected.inventory, artifact.inventory);
    inspectedByTarget[target] = inspected;
    destinations[target] = destination;
  }
  assert.notEqual(inspectedByTarget.chromium.treeSha256, inspectedByTarget.firefox.treeSha256);
  assert.deepEqual(
    inspectedByTarget.chromium.inventory.filter((item, index) =>
      item.sha256 !== inspectedByTarget.firefox.inventory[index].sha256).map(item => item.path),
    ['manifest.json']
  );

  await writeFile(path.join(destinations.chromium, 'worker', 'core.mjs'), 'export const tampered = true;\n');
  const tampered = await inspectDirectory(destinations.chromium);
  assert.throws(() => assertSameInventory(inspectedByTarget.chromium, tampered), /inventory differs/);
});
