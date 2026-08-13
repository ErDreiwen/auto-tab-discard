import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {packageRelease} from '../scripts/package-release.mjs';

const exec = promisify(execFile);
const git = (root, ...arguments_) => exec('git', ['-C', root, ...arguments_], {windowsHide: true});
const evidence = [{id: 'fixture-gate', path: 'tests/evidence.json', status: 'passed'}];

const createRepository = async (t, manifest = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-package-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'v3', 'worker'), {recursive: true});
  await mkdir(path.join(root, 'docs'), {recursive: true});
  await mkdir(path.join(root, 'tests'), {recursive: true});
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await writeFile(path.join(root, 'LICENSE'), 'MPL-2.0 fixture\n');
  await writeFile(path.join(root, 'FORK_NOTES.md'), '# Notes\n');
  await writeFile(path.join(root, 'docs', 'MIGRATIONS.md'), '# Migrations\n');
  await writeFile(path.join(root, 'docs', 'PERMISSION_CHANGES.md'), '# Permissions\n');
  await writeFile(path.join(root, 'tests', 'evidence.json'), '{"passed":true}\n');
  await writeFile(path.join(root, 'v3', 'worker', 'core.mjs'), 'export {};\n');
  await writeFile(path.join(root, 'v3', 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    name: 'Expected Name',
    version: '2.0.0',
    background: {service_worker: 'worker/core.mjs', type: 'module'},
    ...manifest
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'docs', 'release-policy.json'), `${JSON.stringify({
    releaseName: 'Expected Name',
    releaseVersion: '2.0.0',
    archiveBaseName: 'fixture-2.0.0'
  }, null, 2)}\n`);
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.name', 'Release Fixture');
  await git(root, 'config', 'user.email', 'release-fixture@example.invalid');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
};

test('strict packaging enforces evidence, manifest identity, version, and archive name', async t => {
  await t.test('evidence is required', async t => {
    const root = await createRepository(t);
    await assert.rejects(packageRelease({repositoryRoot: root, baseName: 'fixture-2.0.0'}), /test-evidence/);
  });
  await t.test('name mismatch', async t => {
    const root = await createRepository(t, {name: 'Wrong Name'});
    await assert.rejects(packageRelease({repositoryRoot: root, baseName: 'fixture-2.0.0', testEvidence: evidence}), /name mismatch/);
  });
  await t.test('version mismatch', async t => {
    const root = await createRepository(t, {version: '2.0.1'});
    await assert.rejects(packageRelease({repositoryRoot: root, baseName: 'fixture-2.0.0', testEvidence: evidence}), /version mismatch/);
  });
  await t.test('archive name mismatch', async t => {
    const root = await createRepository(t);
    await assert.rejects(packageRelease({repositoryRoot: root, baseName: 'wrong-name', testEvidence: evidence}), /archive name mismatch/);
  });
});

test('strict packaging requires three non-empty normalized release notes', async t => {
  for (const [relative, mutation, expected] of [
    ['FORK_NOTES.md', 'remove', /Required release root file is unavailable/],
    ['docs/MIGRATIONS.md', 'empty', /Required release note is empty after normalization: docs\/MIGRATIONS\.md/],
    ['docs/PERMISSION_CHANGES.md', 'empty', /Required release note is empty after normalization: docs\/PERMISSION_CHANGES\.md/]
  ]) {
    await t.test(`${relative} ${mutation}`, async t => {
      const root = await createRepository(t);
      const target = path.join(root, ...relative.split('/'));
      if (mutation === 'remove') {
        await rm(target);
      }
      else {
        await writeFile(target, '\uFEFF\r\n\t \r\n');
      }
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', `${mutation} note`);
      await assert.rejects(packageRelease({
        repositoryRoot: root,
        baseName: 'fixture-2.0.0',
        testEvidence: evidence
      }), expected);
    });
  }
});

test('strict packaging records commit, tree, release-note digest, source digest, and evidence', async t => {
  const root = await createRepository(t);
  const result = await packageRelease({
    repositoryRoot: root,
    baseName: 'fixture-2.0.0',
    outputDirectory: path.join(root, 'build', 'results'),
    testEvidence: evidence
  });
  assert.match(result.metadata.provenance.commitSha, /^[a-f\d]{40,64}$/);
  assert.match(result.metadata.provenance.gitTree, /^[a-f\d]{40,64}$/);
  assert.match(result.metadata.provenance.releaseNotes.sha256, /^[a-f\d]{64}$/);
  assert.deepEqual(Object.keys(result.metadata.provenance.notes), [
    'FORK_NOTES.md',
    'docs/MIGRATIONS.md',
    'docs/PERMISSION_CHANGES.md'
  ]);
  assert.ok(Object.values(result.metadata.provenance.notes)
    .every(note => note.bytes > 0 && /^[a-f\d]{64}$/.test(note.sha256)));
  assert.match(result.metadata.sourceTreeSha256, /^[a-f\d]{64}$/);
  assert.deepEqual(result.metadata.testEvidence.map(({id, path: evidencePath, status}) => ({id, path: evidencePath, status})), evidence);
  assert.match(result.metadata.testEvidence[0].sha256, /^[a-f\d]{64}$/);
  assert.ok(result.metadata.testEvidence[0].bytes > 0);
});
