import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {
  createBuilderProvenance,
  inventorySha256,
  loadBuilderBundle,
  verifyCrossBuilderProvenance
} from '../scripts/cross-builder-provenance.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const hash = character => character.repeat(64);
const commit = character => character.repeat(40);

const archive = Buffer.from('one deterministic ZIP/XPI byte stream');
const artifact = () => ({
  archives: [
    {bytes: archive.length, file: 'auto-tab-discard-canary.xpi', sha256: digest(archive)},
    {bytes: archive.length, file: 'auto-tab-discard-canary.zip', sha256: digest(archive)}
  ],
  entryCount: 2,
  extensionVersion: '0.6.9.2',
  formatVersion: 3,
  inventory: [
    {bytes: 4, path: 'LICENSE', sha256: hash('a')},
    {bytes: 12, path: 'manifest.json', sha256: hash('b')}
  ],
  sourceTreeSha256: hash('c')
});

const provenance = (builderId, runnerOs, overrides = {}) => createBuilderProvenance({
  artifact: artifact(),
  builderId,
  commitSha: commit('d'),
  gitTree: commit('e'),
  metadataSha256: hash('f'),
  runnerImage: `${builderId}-clean-image-1`,
  runnerOs,
  ...overrides
});

const records = () => [
  {artifact: artifact(), provenance: provenance('linux', 'Linux')},
  {artifact: artifact(), provenance: provenance('windows', 'Windows')}
];

test('inventory hash binds byte-sorted path, size, and content digest', () => {
  const original = artifact().inventory;
  assert.match(inventorySha256(original), /^[a-f\d]{64}$/);
  assert.notEqual(inventorySha256(original), inventorySha256([
    original[0],
    {...original[1], bytes: original[1].bytes + 1}
  ]));
  assert.throws(() => inventorySha256([...original].reverse()), /strictly byte-sorted/);
  assert.throws(() => inventorySha256([original[0], original[0]]), /duplicates/);

  const unsafeArchive = artifact();
  unsafeArchive.archives[0].file = '../outside.xpi';
  assert.throws(() => createBuilderProvenance({
    artifact: unsafeArchive,
    builderId: 'linux',
    commitSha: commit('d'),
    gitTree: commit('e'),
    metadataSha256: hash('f'),
    runnerImage: 'linux-clean-image-1',
    runnerOs: 'Linux'
  }), /archive path is unsafe/);
});

test('independent Linux and Windows builders pass only on one exact commit and artifact', () => {
  const report = verifyCrossBuilderProvenance({builders: records(), canonicalBuilder: 'linux'});
  assert.deepEqual(report, {
    builders: [
      {
        archiveSha256: digest(archive),
        commitSha: commit('d'),
        extensionVersion: '0.6.9.2',
        gitTree: commit('e'),
        id: 'linux',
        inventorySha256: inventorySha256(artifact().inventory),
        metadataSha256: hash('f'),
        runnerImage: 'linux-clean-image-1',
        runnerOs: 'Linux',
        sourceTreeSha256: hash('c')
      },
      {
        archiveSha256: digest(archive),
        commitSha: commit('d'),
        extensionVersion: '0.6.9.2',
        gitTree: commit('e'),
        id: 'windows',
        inventorySha256: inventorySha256(artifact().inventory),
        metadataSha256: hash('f'),
        runnerImage: 'windows-clean-image-1',
        runnerOs: 'Windows',
        sourceTreeSha256: hash('c')
      }
    ],
    canonical: {
      archiveSha256: digest(archive),
      builderId: 'linux',
      commitSha: commit('d'),
      extensionVersion: '0.6.9.2',
      gitTree: commit('e'),
      inventorySha256: inventorySha256(artifact().inventory),
      sourceTreeSha256: hash('c')
    },
    failures: [],
    schemaVersion: 1,
    status: 'passed'
  });
});

test('every archive, tree, inventory, metadata, version, and Git mismatch is fatal', () => {
  const fields = [
    ['archiveSha256', hash('1'), 'archive SHA-256 mismatch'],
    ['archiveBytes', archive.length + 1, 'archive byte count mismatch'],
    ['sourceTreeSha256', hash('2'), 'source-tree SHA-256 mismatch'],
    ['inventorySha256', hash('3'), 'inventory SHA-256 mismatch'],
    ['inventoryEntries', 3, 'inventory entry count mismatch'],
    ['metadataSha256', hash('4'), 'metadata SHA-256 mismatch'],
    ['extensionVersion', '9.9.9', 'extension version mismatch']
  ];
  for (const [field, value, expected] of fields) {
    const builders = records();
    builders[1] = {
      ...builders[1],
      provenance: {
        ...builders[1].provenance,
        artifact: {...builders[1].provenance.artifact, [field]: value}
      }
    };
    const report = verifyCrossBuilderProvenance({builders, canonicalBuilder: 'linux'});
    assert.equal(report.status, 'failed', field);
    assert.ok(report.failures.some(failure => failure.includes(expected)), field);
  }

  for (const [field, value, expected] of [
    ['commitSha', commit('1'), 'Git commit mismatch'],
    ['gitTree', commit('2'), 'Git tree mismatch']
  ]) {
    const builders = records();
    builders[1] = {
      ...builders[1],
      provenance: {
        ...builders[1].provenance,
        source: {...builders[1].provenance.source, [field]: value}
      }
    };
    const report = verifyCrossBuilderProvenance({builders});
    assert.equal(report.status, 'failed', field);
    assert.ok(report.failures.some(failure => failure.includes(expected)), field);
  }
});

test('missing, duplicate, wrong-OS, and nonindependent builders fail closed', () => {
  const missing = verifyCrossBuilderProvenance({builders: records().slice(0, 1)});
  assert.equal(missing.status, 'failed');
  assert.ok(missing.failures.includes('missing required clean builder: windows'));

  const duplicateRecords = records();
  duplicateRecords[1] = {
    ...duplicateRecords[1],
    provenance: {
      ...duplicateRecords[1].provenance,
      builder: {...duplicateRecords[1].provenance.builder, id: 'linux'}
    }
  };
  const duplicate = verifyCrossBuilderProvenance({builders: duplicateRecords});
  assert.equal(duplicate.status, 'failed');
  assert.ok(duplicate.failures.includes('duplicate builder provenance for linux'));

  const wrongOsRecords = records();
  wrongOsRecords[1] = {
    ...wrongOsRecords[1],
    provenance: {
      ...wrongOsRecords[1].provenance,
      builder: {...wrongOsRecords[1].provenance.builder, runnerOs: 'Linux'}
    }
  };
  const wrongOs = verifyCrossBuilderProvenance({builders: wrongOsRecords});
  assert.equal(wrongOs.status, 'failed');
  assert.ok(wrongOs.failures.includes('windows builder must run on Windows'));
});

test('bundle loading hashes actual ZIP/XPI and metadata bytes before trusting attestations', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atd-builder-provenance-'));
  t.after(() => rm(root, {recursive: true, force: true}));

  const writeBundle = async (builderId, runnerOs) => {
    const directory = path.join(root, builderId);
    await mkdir(directory, {recursive: true});
    const metadata = artifact();
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const attestation = createBuilderProvenance({
      artifact: metadata,
      builderId,
      commitSha: commit('d'),
      gitTree: commit('e'),
      metadataSha256: digest(metadataBytes),
      runnerImage: `${builderId}-clean-image-1`,
      runnerOs
    });
    await Promise.all([
      writeFile(path.join(directory, 'checksums.json'), metadataBytes),
      writeFile(path.join(directory, 'builder-provenance.json'), `${JSON.stringify(attestation, null, 2)}\n`),
      writeFile(path.join(directory, 'auto-tab-discard-canary.zip'), archive),
      writeFile(path.join(directory, 'auto-tab-discard-canary.xpi'), archive)
    ]);
    return directory;
  };

  const linux = await writeBundle('linux', 'Linux');
  const windows = await writeBundle('windows', 'Windows');
  const report = verifyCrossBuilderProvenance({
    builders: await Promise.all([loadBuilderBundle(linux), loadBuilderBundle(windows)])
  });
  assert.equal(report.status, 'passed');

  await writeFile(path.join(windows, 'auto-tab-discard-canary.zip'), 'tampered');
  await assert.rejects(loadBuilderBundle(windows), /bytes do not match metadata/);
  assert.match(await readFile(path.join(linux, 'builder-provenance.json'), 'utf8'), /"cleanCheckout": true/);
});

test('workflow verifier exits nonzero whenever its report is not passed', async () => {
  const source = await readFile(new URL('../scripts/cross-builder-provenance.mjs', import.meta.url), 'utf8');
  const prepare = await readFile(new URL('../scripts/prepare-canary-artifact.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(report\.status !== 'passed'\) \{\s*process\.exitCode = 1;/);
  assert.match(prepare, /assertReleaseContext\(\{repositoryRoot, sourceRoot\}\)/);
  assert.ok(
    prepare.indexOf('assertReleaseContext({repositoryRoot, sourceRoot})') <
      prepare.indexOf('packageRelease({'),
    'clean checkout identity must be asserted before source packaging'
  );
  assert.match(prepare, /builder-provenance\.json/);
});
