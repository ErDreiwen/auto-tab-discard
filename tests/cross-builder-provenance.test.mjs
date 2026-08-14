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

const archives = Object.freeze({
  chromium: Buffer.from('deterministic Chromium ZIP byte stream'),
  firefox: Buffer.from('deterministic Firefox XPI byte stream')
});
const inventories = () => ({
  chromium: [
    {bytes: 4, path: 'LICENSE', sha256: hash('a')},
    {bytes: 21, path: 'manifest.json', sha256: hash('b')}
  ],
  firefox: [
    {bytes: 4, path: 'LICENSE', sha256: hash('a')},
    {bytes: 20, path: 'manifest.json', sha256: hash('c')}
  ]
});
const artifact = () => ({
  artifacts: {
    chromium: {
      bytes: archives.chromium.length,
      entryCount: 2,
      file: 'auto-tab-discard-canary.zip',
      inventory: inventories().chromium,
      sha256: digest(archives.chromium),
      treeSha256: hash('d')
    },
    firefox: {
      bytes: archives.firefox.length,
      entryCount: 2,
      file: 'auto-tab-discard-canary.xpi',
      inventory: inventories().firefox,
      sha256: digest(archives.firefox),
      treeSha256: hash('e')
    }
  },
  extensionVersion: '0.6.9.2',
  formatVersion: 4
});

const targetEvidence = target => ({
  archiveBytes: archives[target].length,
  archiveSha256: digest(archives[target]),
  inventoryEntries: 2,
  inventorySha256: inventorySha256(inventories()[target]),
  treeSha256: target === 'chromium' ? hash('d') : hash('e')
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
  const original = artifact().artifacts.chromium.inventory;
  assert.match(inventorySha256(original), /^[a-f\d]{64}$/);
  assert.notEqual(inventorySha256(original), inventorySha256([
    original[0],
    {...original[1], bytes: original[1].bytes + 1}
  ]));
  assert.throws(() => inventorySha256([...original].reverse()), /strictly byte-sorted/);
  assert.throws(() => inventorySha256([original[0], original[0]]), /duplicates/);

  const unsafeArchive = artifact();
  unsafeArchive.artifacts.firefox.file = '../outside.xpi';
  assert.throws(() => createBuilderProvenance({
    artifact: unsafeArchive,
    builderId: 'linux',
    commitSha: commit('d'),
    gitTree: commit('e'),
    metadataSha256: hash('f'),
    runnerImage: 'linux-clean-image-1',
    runnerOs: 'Linux'
  }), /firefox archive path is unsafe/);

  const incomplete = artifact();
  delete incomplete.artifacts.firefox;
  assert.throws(() => createBuilderProvenance({
    artifact: incomplete,
    builderId: 'linux',
    commitSha: commit('d'),
    gitTree: commit('e'),
    metadataSha256: hash('f'),
    runnerImage: 'linux-clean-image-1',
    runnerOs: 'Linux'
  }), /exactly chromium and firefox/);
});

test('independent Linux and Windows builders pass only on one exact commit and artifact', () => {
  const report = verifyCrossBuilderProvenance({builders: records(), canonicalBuilder: 'linux'});
  assert.deepEqual(report, {
    builders: [
      {
        commitSha: commit('d'),
        extensionVersion: '0.6.9.2',
        gitTree: commit('e'),
        id: 'linux',
        metadataSha256: hash('f'),
        runnerImage: 'linux-clean-image-1',
        runnerOs: 'Linux',
        targets: {
          chromium: targetEvidence('chromium'),
          firefox: targetEvidence('firefox')
        }
      },
      {
        commitSha: commit('d'),
        extensionVersion: '0.6.9.2',
        gitTree: commit('e'),
        id: 'windows',
        metadataSha256: hash('f'),
        runnerImage: 'windows-clean-image-1',
        runnerOs: 'Windows',
        targets: {
          chromium: targetEvidence('chromium'),
          firefox: targetEvidence('firefox')
        }
      }
    ],
    canonical: {
      builderId: 'linux',
      commitSha: commit('d'),
      extensionVersion: '0.6.9.2',
      gitTree: commit('e'),
      targets: {
        chromium: targetEvidence('chromium'),
        firefox: targetEvidence('firefox')
      }
    },
    failures: [],
    schemaVersion: 2,
    status: 'passed'
  });
});

test('every archive, tree, inventory, metadata, version, and Git mismatch is fatal', () => {
  for (const target of ['chromium', 'firefox']) {
    for (const [field, value, expected] of [
      ['archiveSha256', hash('1'), 'archive SHA-256 mismatch'],
      ['archiveBytes', archives[target].length + 1, 'archive byte count mismatch'],
      ['treeSha256', hash('2'), 'tree SHA-256 mismatch'],
      ['inventorySha256', hash('3'), 'inventory SHA-256 mismatch'],
      ['inventoryEntries', 3, 'inventory entry count mismatch']
    ]) {
      const builders = records();
      builders[1] = {
        ...builders[1],
        provenance: {
          ...builders[1].provenance,
          artifact: {
            ...builders[1].provenance.artifact,
            targets: {
              ...builders[1].provenance.artifact.targets,
              [target]: {...builders[1].provenance.artifact.targets[target], [field]: value}
            }
          }
        }
      };
      const report = verifyCrossBuilderProvenance({builders, canonicalBuilder: 'linux'});
      assert.equal(report.status, 'failed', `${target}.${field}`);
      assert.ok(report.failures.some(failure => failure.includes(`${target} ${expected}`)), `${target}.${field}`);
    }
  }

  for (const [field, value, expected] of [
    ['metadataSha256', hash('4'), 'metadata SHA-256 mismatch'],
    ['extensionVersion', '9.9.9', 'extension version mismatch']
  ]) {
    const builders = records();
    builders[1] = {
      ...builders[1],
      provenance: {
        ...builders[1].provenance,
        artifact: {...builders[1].provenance.artifact, [field]: value}
      }
    };
    const report = verifyCrossBuilderProvenance({builders});
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
      writeFile(path.join(directory, 'auto-tab-discard-canary.zip'), archives.chromium),
      writeFile(path.join(directory, 'auto-tab-discard-canary.xpi'), archives.firefox)
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
