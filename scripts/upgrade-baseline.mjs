import {execFile} from 'node:child_process';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const SAFE_REF = /^v\d+\.\d+\.\d+(?:\.\d+)?$/;

const git = async (repositoryRoot, arguments_, options = {}) => {
  const result = await exec('git', arguments_, {
    cwd: repositoryRoot,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
};

const materializeUpgradeBaseline = async ({
  outputDirectory,
  ref = 'v0.6.9.1',
  repositoryRoot,
  subdirectory = 'v3'
}) => {
  if (!SAFE_REF.test(ref) || subdirectory !== 'v3') {
    throw Error('upgrade baseline must be a fixed version tag and the v3 tree');
  }
  const verifiedRef = `refs/tags/${ref}^{commit}`;
  const commitSha = String(await git(repositoryRoot, ['rev-parse', '--verify', verifiedRef])).trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw Error(`upgrade baseline tag did not resolve to a commit: ${ref}`);
  }
  const listing = await git(repositoryRoot, [
    'ls-tree', '-r', '-z', ref, '--', subdirectory
  ], {binary: true});
  const records = Buffer.from(listing).toString('utf8').split('\0').filter(Boolean);
  if (records.length === 0) {
    throw Error(`upgrade baseline has no ${subdirectory} tree: ${ref}`);
  }

  await rm(outputDirectory, {force: true, recursive: true});
  for (const record of records) {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match) {
      throw Error(`malformed Git tree record in ${ref}`);
    }
    const [, mode, type, object, name] = match;
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode) ||
        !name.startsWith(`${subdirectory}/`)) {
      throw Error(`unsupported baseline tree entry: ${mode} ${type} ${name}`);
    }
    const relative = name.slice(subdirectory.length + 1).replaceAll('\\', '/');
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error(`unsafe baseline tree path: ${name}`);
    }
    const target = path.join(outputDirectory, ...relative.split('/'));
    await mkdir(path.dirname(target), {recursive: true});
    if (mode === '120000') {
      const link = Buffer.from(await git(repositoryRoot, ['cat-file', 'blob', object], {binary: true}))
        .toString('utf8').trim();
      // v0.6.9.1 ships its documentation as this one repository-relative
      // symlink. Materialize the tagged target as a regular file so the
      // Windows unpacked extension is an actual checkout equivalent without
      // permitting arbitrary or host-resolved links.
      if (name !== 'v3/README.md' || link !== '../README.md') {
        throw Error(`unsupported baseline symbolic link: ${name} -> ${link}`);
      }
      await writeFile(target, await git(repositoryRoot, ['show', `${ref}:README.md`], {binary: true}));
    }
    else {
      await writeFile(target, await git(repositoryRoot, ['cat-file', 'blob', object], {binary: true}));
    }
  }

  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'));
  if (manifest.version !== ref.slice(1)) {
    throw Error(`baseline manifest ${manifest.version} does not match tag ${ref}`);
  }
  return {commitSha, files: records.length, ref, version: manifest.version};
};

export {materializeUpgradeBaseline};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const repositoryRoot = path.resolve(value('repository') ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const outputDirectory = value('output');
  if (!outputDirectory) {
    process.stderr.write('Usage: node scripts/upgrade-baseline.mjs --output PATH [--ref v0.6.9.1]\n');
    process.exitCode = 1;
  }
  else {
    materializeUpgradeBaseline({
      outputDirectory: path.resolve(outputDirectory),
      ref: value('ref') || 'v0.6.9.1',
      repositoryRoot
    }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
  }
}
