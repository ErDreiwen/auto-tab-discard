import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {lstat, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {assertReleaseContext, findForbiddenReleaseEntries} from '../scripts/release-context.mjs';

const exec = promisify(execFile);
const git = (root, ...arguments_) => exec('git', ['-C', root, ...arguments_], {windowsHide: true});

const repository = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-context-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'v3'));
  await writeFile(path.join(root, 'v3', 'manifest.json'), '{}\n');
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.name', 'Release Fixture');
  await git(root, 'config', 'user.email', 'release-fixture@example.invalid');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
};

test('strict release context records a clean Git commit and tree', async t => {
  const root = await repository(t);
  const context = await assertReleaseContext({repositoryRoot: root});
  assert.match(context.commitSha, /^[a-f\d]{40,64}$/);
  assert.match(context.gitTree, /^[a-f\d]{40,64}$/);
  assert.equal(context.repositoryRoot, path.resolve(root));
  assert.equal(context.sourceRoot, path.join(path.resolve(root), 'v3'));
});

test('strict release context rejects dirty, transitional, and nested worktrees', async t => {
  await t.test('dirty', async t => {
    const root = await repository(t);
    await writeFile(path.join(root, 'dirty.txt'), 'dirty\n');
    await assert.rejects(assertReleaseContext({repositoryRoot: root}), /clean worktree/);
  });

  await t.test('merge in progress', async t => {
    const root = await repository(t);
    const {stdout: gitDirectory} = await git(root, 'rev-parse', '--git-dir');
    const {stdout: head} = await git(root, 'rev-parse', 'HEAD');
    const resolved = path.resolve(root, gitDirectory.trim());
    await writeFile(path.join(resolved, 'MERGE_HEAD'), `${head.trim()}\n`);
    await assert.rejects(assertReleaseContext({repositoryRoot: root}), /in-progress merge/);
  });

  await t.test('nested repository root', async t => {
    const root = await repository(t);
    await assert.rejects(assertReleaseContext({repositoryRoot: path.join(root, 'v3')}), /Nested release root/);
  });

  await t.test('noncanonical source root', async t => {
    const root = await repository(t);
    await mkdir(path.join(root, 'alternate'));
    await assert.rejects(
      assertReleaseContext({repositoryRoot: root, sourceRoot: path.join(root, 'alternate')}),
      /repository v3 root/
    );
  });
});

test('forbidden release material is detected even when committed', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, 'v3', 'signing.key'), 'fixture-secret\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'forbidden fixture');
  assert.deepEqual(await findForbiddenReleaseEntries(path.join(root, 'v3')), [{
    path: 'signing.key',
    reason: 'secret, signed, or nested archive material'
  }]);
  await assert.rejects(assertReleaseContext({repositoryRoot: root}), /signing\.key/);
});

test('tracked release symlinks are rejected when core.symlinks hides them as regular files', async t => {
  const root = await repository(t);
  const readme = path.join(root, 'v3', 'README.md');
  await writeFile(readme, '../README.md');
  await git(root, 'config', 'core.symlinks', 'false');
  const {stdout: object} = await git(root, 'hash-object', '-w', '--', readme);
  await git(root, 'update-index', '--add', '--cacheinfo',
    `120000,${object.trim()},v3/README.md`);
  await git(root, 'commit', '--quiet', '-m', 'tracked symlink fixture');

  assert.equal((await lstat(readme)).isSymbolicLink(), false,
    'the fixture must reproduce a checkout that hides Git symlink mode');
  assert.equal((await git(root, 'status', '--porcelain=v1')).stdout.trim(), '');
  await assert.rejects(assertReleaseContext({repositoryRoot: root}),
    /README\.md: symbolic link in Git tree/);
});
