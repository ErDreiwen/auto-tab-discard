import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  access, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink,
  unlink, writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {normalizeRepositoryRelativePath, packageRelease} from '../scripts/package-release.mjs';
import {extractArchive} from '../scripts/archive-inventory.mjs';
import {createExclusiveReleaseWorkspace} from '../scripts/release-gate.mjs';
import {assertUnaliasedReleaseWorkspace} from '../scripts/release-context.mjs';

const exec = promisify(execFile);
const git = (root, ...arguments_) => exec('git', ['-C', root, ...arguments_], {windowsHide: true});
const evidence = [{id: 'fixture-gate', path: 'tests/evidence.json', status: 'passed'}];
const absent = target => assert.rejects(access(target), error => error?.code === 'ENOENT');

const createRepository = async (t, manifest = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-package-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'v3', 'firefox'), {recursive: true});
  await mkdir(path.join(root, 'v3', 'worker'), {recursive: true});
  await mkdir(path.join(root, 'docs'), {recursive: true});
  await mkdir(path.join(root, 'tests'), {recursive: true});
  await writeFile(path.join(root, '.gitignore'), '/build/\n');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await writeFile(path.join(root, 'LICENSE'), 'MPL-2.0 fixture\n');
  await writeFile(path.join(root, 'FORK_NOTES.md'), '# Notes\n');
  await writeFile(path.join(root, 'docs', 'MIGRATIONS.md'), '# Migrations\n');
  await writeFile(path.join(root, 'docs', 'PERMISSION_CHANGES.md'), '# Permissions\n');
  await writeFile(path.join(root, 'tests', 'evidence.json'), '{"passed":true}\n');
  await writeFile(path.join(root, 'v3', 'firefox', 'background.html'), [
    '<script type="module" src="compatibility.mjs"></script>',
    '<script type="module" src="/worker/core.mjs"></script>',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'v3', 'firefox', 'compatibility.mjs'), 'export {};\n');
  await writeFile(path.join(root, 'v3', 'worker', 'core.mjs'), 'export {};\n');
  await writeFile(path.join(root, 'v3', 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    name: 'Expected Name',
    version: '2.0.0',
    background: {
      page: '/firefox/background.html',
      service_worker: 'worker/core.mjs',
      type: 'module'
    },
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

const materializeTrackedSymlink = async (root, relativePath, target) => {
  const absolute = path.join(root, ...relativePath.split('/'));
  await git(root, 'config', 'core.symlinks', 'false');
  await rm(absolute, {recursive: true, force: true});
  await mkdir(path.dirname(absolute), {recursive: true});
  await writeFile(absolute, target, 'utf8');
  const {stdout: object} = await git(root, 'hash-object', '-w', '--', absolute);
  await git(root, 'update-index', '--add', '--cacheinfo',
    `120000,${object.trim()},${relativePath}`);
  await git(root, 'commit', '--quiet', '-m', `materialized symlink ${relativePath}`);
  assert.equal((await lstat(absolute)).isSymbolicLink(), false);
  assert.equal((await git(root, 'status', '--porcelain=v1')).stdout.trim(), '');
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

test('target derivation fails closed on a noncanonical background or Firefox loader', async t => {
  await t.test('source background has an extra scripts fallback', async t => {
    const root = await createRepository(t, {background: {
      page: '/firefox/background.html',
      scripts: ['firefox/compatibility.mjs', 'worker/core.mjs'],
      service_worker: 'worker/core.mjs',
      type: 'module'
    }});
    await assert.rejects(packageRelease({
      repositoryRoot: root,
      outputDirectory: path.join(root, 'build', 'invalid-background'),
      releaseMode: false
    }), /background must contain exactly page, service_worker, and type/);
  });

  await t.test('background page reverses compatibility and core ordering', async t => {
    const root = await createRepository(t);
    await writeFile(path.join(root, 'v3', 'firefox', 'background.html'), [
      '<script type="module" src="/worker/core.mjs"></script>',
      '<script type="module" src="compatibility.mjs"></script>',
      ''
    ].join('\n'));
    await assert.rejects(packageRelease({
      repositoryRoot: root,
      outputDirectory: path.join(root, 'build', 'invalid-loader-order'),
      releaseMode: false
    }), /must load compatibility\.mjs exactly once before worker\/core\.mjs/);
  });

  await t.test('background page dependency is absent', async t => {
    const root = await createRepository(t);
    await rm(path.join(root, 'v3', 'firefox', 'compatibility.mjs'));
    await assert.rejects(packageRelease({
      repositoryRoot: root,
      outputDirectory: path.join(root, 'build', 'missing-loader-dependency'),
      releaseMode: false
    }), /Firefox background loader dependency is missing.*firefox\/compatibility\.mjs/);
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
  assert.match(result.metadata.artifacts.chromium.treeSha256, /^[a-f\d]{64}$/);
  assert.match(result.metadata.artifacts.firefox.treeSha256, /^[a-f\d]{64}$/);
  assert.notEqual(result.metadata.artifacts.chromium.treeSha256,
    result.metadata.artifacts.firefox.treeSha256);
  assert.deepEqual(result.metadata.testEvidence.map(({id, path: evidencePath, status}) => ({id, path: evidencePath, status})), evidence);
  assert.match(result.metadata.testEvidence[0].sha256, /^[a-f\d]{64}$/);
  assert.ok(result.metadata.testEvidence[0].bytes > 0);
});

test('strict packaging rejects core.symlinks=false placeholders for root, doc, and evidence inputs', async t => {
  for (const [label, relativePath] of [
    ['root', 'README.md'],
    ['doc', 'docs/MIGRATIONS.md'],
    ['evidence', 'tests/evidence.json']
  ]) {
    await t.test(label, async t => {
      const root = await createRepository(t);
      await materializeTrackedSymlink(root, relativePath, '../outside-release-input');
      await assert.rejects(packageRelease({
        repositoryRoot: root,
        baseName: 'fixture-2.0.0',
        testEvidence: evidence
      }), new RegExp(`${relativePath.replace(/[./]/g, '\\$&')}: symbolic link in Git tree`));
      await absent(path.join(root, 'build', 'results'));
    });
  }
});

test('strict packaging rejects nonregular root, doc, and evidence inputs before output mutation', async t => {
  for (const [label, relativePath, evidenceReferences] of [
    ['root', 'README.md', evidence],
    ['doc', 'docs/MIGRATIONS.md', evidence],
    ['evidence', 'build/evidence/report.json', [
      {id: 'fixture-gate', path: 'build/evidence/report.json', status: 'passed'}
    ]]
  ]) {
    await t.test(label, async t => {
      const root = await createRepository(t);
      const target = path.join(root, ...relativePath.split('/'));
      await rm(target, {recursive: true, force: true});
      await mkdir(target, {recursive: true});
      await writeFile(path.join(target, 'child.txt'), 'not a regular release input\n');
      if (!relativePath.startsWith('build/')) {
        await git(root, 'add', '-A');
        await git(root, 'commit', '--quiet', '-m', `nonregular ${relativePath}`);
      }
      await assert.rejects(packageRelease({
        repositoryRoot: root,
        baseName: 'fixture-2.0.0',
        testEvidence: evidenceReferences
      }), /must be a regular file/);
      await absent(path.join(root, 'build', 'results'));
    });
  }
});

test('strict evidence cannot traverse a live repository-escaping directory link', async t => {
  const root = await createRepository(t);
  const external = await mkdtemp(path.join(tmpdir(), 'outside-release-evidence-'));
  t.after(() => rm(external, {recursive: true, force: true}));
  await writeFile(path.join(external, 'report.json'), '{"passed":true}\n');
  await mkdir(path.join(root, 'build'), {recursive: true});
  await symlink(external, path.join(root, 'build', 'linked-evidence'),
    process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(packageRelease({
    repositoryRoot: root,
    baseName: 'fixture-2.0.0',
    testEvidence: [{
      id: 'fixture-gate',
      path: 'build/linked-evidence/report.json',
      status: 'passed'
    }]
  }), /resolves outside the repository/);
  await absent(path.join(root, 'build', 'results'));
});

test('release output contract rejects source overlap, aliases, files, and unignored repository paths before writes', async t => {
  const root = await createRepository(t);
  const sourceRoot = path.join(root, 'v3');
  const cases = [
    ['source root', sourceRoot, /must not equal or be inside the release source/],
    ['source child', path.join(sourceRoot, 'release-output'), /must not equal or be inside the release source/],
    ['unignored repository path', path.join(root, 'dist'), /must be Git-ignored/]
  ];
  for (const [label, outputDirectory, expected] of cases) {
    await t.test(label, async () => {
      await assert.rejects(packageRelease({
        repositoryRoot: root,
        outputDirectory,
        releaseMode: false
      }), expected);
      if (outputDirectory !== sourceRoot) {
        await absent(outputDirectory);
      }
    });
  }

  const outputFile = path.join(root, 'build', 'not-a-directory');
  await mkdir(path.dirname(outputFile), {recursive: true});
  await writeFile(outputFile, 'existing file\n');
  await assert.rejects(packageRelease({
    repositoryRoot: root,
    outputDirectory: outputFile,
    releaseMode: false
  }), /Release output is not a directory/);
  assert.equal(await readFile(outputFile, 'utf8'), 'existing file\n');

  const alias = path.join(root, 'build', 'source-alias');
  await symlink(sourceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageRelease({
    repositoryRoot: root,
    outputDirectory: path.join(alias, 'nested-output'),
    releaseMode: false
  }), /must not equal or be inside the release source/);
  await absent(path.join(sourceRoot, 'nested-output'));
});

test('default, external, and ignored repository outputs retain identical release bytes', async t => {
  const root = await createRepository(t);
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'external-release-output-'));
  t.after(() => rm(externalRoot, {recursive: true, force: true}));
  const variants = [
    await packageRelease({
      repositoryRoot: root,
      baseName: 'fixture-2.0.0',
      testEvidence: evidence
    }),
    await packageRelease({
      repositoryRoot: root,
      baseName: 'fixture-2.0.0',
      outputDirectory: path.join(externalRoot, 'artifacts'),
      testEvidence: evidence
    }),
    await packageRelease({
      repositoryRoot: root,
      baseName: 'fixture-2.0.0',
      outputDirectory: path.join(root, 'build', 'alternate-results'),
      testEvidence: evidence
    })
  ];
  assert.deepEqual(variants.map(item => item.metadata), [
    variants[0].metadata,
    variants[0].metadata,
    variants[0].metadata
  ]);
  for (const file of ['fixture-2.0.0.zip', 'fixture-2.0.0.xpi', 'checksums.json', 'SHA256SUMS']) {
    const bytes = await Promise.all(variants.map(item => readFile(path.join(item.outputDirectory, file))));
    assert.ok(bytes.slice(1).every(item => item.equals(bytes[0])), `${file} must be output-path independent`);
  }
});

test('publication rejects symlink, nonregular, and multiply-linked artifact targets without victim writes', async t => {
  for (const kind of ['symbolic link', 'directory', 'hardlink']) {
    await t.test(kind, async t => {
      const root = await createRepository(t);
      const outputDirectory = path.join(root, 'build', `unsafe-${kind.replace(' ', '-')}`);
      await mkdir(outputDirectory, {recursive: true});
      const target = path.join(outputDirectory, 'fixture-2.0.0.zip');
      let victim;
      let expected;
      if (kind === 'symbolic link') {
        victim = path.join(root, 'build', 'junction-victim');
        await mkdir(victim, {recursive: true});
        await writeFile(path.join(victim, 'sentinel.txt'), 'junction victim\n');
        await symlink(victim, target, process.platform === 'win32' ? 'junction' : 'dir');
        expected = /symbolic link/;
      }
      else if (kind === 'directory') {
        await mkdir(target, {recursive: true});
        await writeFile(path.join(target, 'sentinel.txt'), 'directory victim\n');
        expected = /not a regular file/;
      }
      else {
        victim = path.join(outputDirectory, 'hardlink-victim.bin');
        await writeFile(victim, 'hardlink victim bytes\n');
        await link(victim, target);
        expected = /multiply linked/;
      }

      await assert.rejects(packageRelease({
        repositoryRoot: root,
        baseName: 'fixture-2.0.0',
        outputDirectory,
        releaseMode: false
      }), expected);
      if (kind === 'symbolic link') {
        assert.equal(await readFile(path.join(victim, 'sentinel.txt'), 'utf8'), 'junction victim\n');
      }
      else if (kind === 'directory') {
        assert.equal(await readFile(path.join(target, 'sentinel.txt'), 'utf8'), 'directory victim\n');
      }
      else {
        assert.equal(await readFile(victim, 'utf8'), 'hardlink victim bytes\n');
        assert.equal(await readFile(target, 'utf8'), 'hardlink victim bytes\n');
      }
      assert.deepEqual((await readdir(outputDirectory)).filter(name =>
        name.startsWith('.release-stage-') || name.startsWith('.release-backup-')), []);
    });
  }
});

test('late publication conflict rolls back every already-published artifact', async t => {
  const root = await createRepository(t);
  const outputDirectory = path.join(root, 'build', 'late-publication-conflict');
  let injected = false;
  await assert.rejects(packageRelease({
    repositoryRoot: root,
    baseName: 'fixture-2.0.0',
    outputDirectory,
    releaseMode: false,
    hooks: {
      beforePublishFile: async ({file}) => {
        if (file === 'SHA256SUMS') {
          injected = true;
          await mkdir(path.join(outputDirectory, file));
        }
      }
    }
  }), /not a regular file/);
  assert.equal(injected, true);
  for (const file of ['fixture-2.0.0.zip', 'fixture-2.0.0.xpi', 'checksums.json']) {
    await absent(path.join(outputDirectory, file));
  }
  assert.equal((await lstat(path.join(outputDirectory, 'SHA256SUMS'))).isDirectory(), true);
  assert.deepEqual((await readdir(outputDirectory)).filter(name =>
    name.startsWith('.release-stage-') || name.startsWith('.release-backup-')), []);
});

test('strict packaging remains bound to the recorded Git tree after a post-status worktree mutation', async t => {
  const root = await createRepository(t);
  const sourcePath = path.join(root, 'v3', 'worker', 'core.mjs');
  const committedBytes = await readFile(sourcePath);
  const outputDirectory = path.join(root, 'build', 'immutable-tree-output');
  const result = await packageRelease({
    repositoryRoot: root,
    baseName: 'fixture-2.0.0',
    outputDirectory,
    testEvidence: evidence,
    hooks: {
      afterReleaseContext: async () => {
        await writeFile(sourcePath, 'export const racedWorktreeMutation = true;\n');
      }
    }
  });
  const extracted = path.join(root, 'build', 'immutable-tree-extracted');
  await extractArchive(path.join(outputDirectory, result.artifacts.chromium.file), extracted);
  assert.deepEqual(await readFile(path.join(extracted, 'worker', 'core.mjs')), committedBytes);
  assert.notDeepEqual(await readFile(sourcePath), committedBytes);
  assert.match(result.releaseContext.commitSha, /^[a-f\d]{40,64}$/);
  assert.match(result.releaseContext.gitTree, /^[a-f\d]{40,64}$/);
});

test('repository-relative evidence syntax rejects POSIX, drive, UNC, and traversal forms on every host', () => {
  for (const invalid of [
    '/tmp/report.json',
    'C:\\temp\\report.json',
    'C:relative-report.json',
    '\\\\server\\share\\report.json',
    'tests/evidence.json:alternate-stream',
    '../report.json',
    'tests/../report.json',
    'tests//report.json',
    'tests/./report.json'
  ]) {
    assert.throws(() => normalizeRepositoryRelativePath(invalid, 'Test-evidence path'),
      /repository-relative|canonical repository-relative/);
  }
  assert.equal(normalizeRepositoryRelativePath('tests\\evidence.json'), 'tests/evidence.json');
});

test('release gate isolates evidence in ignored repository staging and reserves requested output for final artifacts', async () => {
  const gate = await readFile(path.resolve(import.meta.dirname, '..', 'scripts', 'release-gate.mjs'), 'utf8');
  const edge = await readFile(path.resolve(import.meta.dirname, '..', 'e2e', 'edge-frozen-smoke.cjs'), 'utf8');
  const initialization = gate.slice(gate.indexOf('export const releaseGate'), gate.indexOf('const blockers = []'));
  assert.match(gate, /releaseWorkspaceParent = path\.join\(repositoryRoot, 'build'\)/);
  assert.match(gate, /mkdtemp\(path\.join\(workspaceParent, 'rg-'\)\)/);
  assert.doesNotMatch(initialization, /rm\(outputDirectory, \{recursive: true/,
    'an existing workspace pathname must never receive recursive deletion authority');
  assert.ok(initialization.indexOf('await assertReleaseContext(') <
    initialization.indexOf('await createExclusiveReleaseWorkspace('),
  'the immutable Git context must be bound before exclusive staging is created');
  assert.match(gate, /outputDirectory: artifactOutputDirectory,[\s\S]*releaseMode: true/);
  assert.match(gate, /inspectArchive\(path\.join\(artifactOutputDirectory, described\.file\)\)/);
  assert.match(gate, /artifactDirectory: artifactOutputDirectory/);
  assert.match(gate, /'--results-root', frozenDirectory/);
  assert.match(edge, /option\('results-root', DEFAULT_RESULTS_ROOT\)/);
});

test('release-gate workspace preflight rejects an escaping junction before mutation', async t => {
  const root = await createRepository(t);
  const external = await mkdtemp(path.join(tmpdir(), 'outside-release-workspace-'));
  t.after(() => rm(external, {recursive: true, force: true}));
  await mkdir(path.join(root, 'build'), {recursive: true});
  const linked = path.join(root, 'build', 'release-gate-work');
  await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertUnaliasedReleaseWorkspace({
    repositoryRoot: root,
    workspaceDirectory: linked
  }), /symbolic-link component/);
  assert.deepEqual(await readFile(path.join(root, '.gitignore'), 'utf8'), '/build/\n');
  await absent(path.join(external, 'evidence'));
});

test('release-gate junction swap after preflight cannot redirect recursive deletion', async t => {
  const root = await createRepository(t);
  const external = await mkdtemp(path.join(tmpdir(), 'swapped-release-workspace-'));
  t.after(() => rm(external, {recursive: true, force: true}));
  await writeFile(path.join(external, 'sentinel.txt'), 'must survive\n');
  const workspaceParent = path.join(root, 'build');
  const parkedParent = path.join(root, 'build-before-swap');
  let swapped = false;
  try {
    await assert.rejects(createExclusiveReleaseWorkspace({
      repositoryRoot: root,
      sourceRoot: path.join(root, 'v3'),
      workspaceParent,
      beforeCreate: async () => {
        await rename(workspaceParent, parkedParent);
        await symlink(external, workspaceParent, process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true;
      }
    }), /symbolic-link component|must remain inside the repository/);
    assert.equal(swapped, true);
    assert.equal(await readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'must survive\n');
    assert.deepEqual(await readdir(external), ['sentinel.txt'],
      'the swapped target must receive neither deletion nor workspace creation');
  }
  finally {
    if (swapped) {
      if (process.platform === 'win32') {
        await rmdir(workspaceParent);
      }
      else {
        await unlink(workspaceParent);
      }
      await rename(parkedParent, workspaceParent);
    }
  }
});
