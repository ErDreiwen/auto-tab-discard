import {execFile} from 'node:child_process';
import {access, readdir} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const git = async (repositoryRoot, ...arguments_) => {
  const {stdout} = await exec('git', ['-C', repositoryRoot, ...arguments_], {
    encoding: 'utf8',
    windowsHide: true
  });
  return stdout.trim();
};

const exists = async target => {
  try {
    await access(target);
    return true;
  }
  catch {
    return false;
  }
};

const stateFiles = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
  ['rebase-apply', 'rebase'],
  ['rebase-merge', 'rebase']
];

const forbiddenName = relativePath => {
  const name = path.posix.basename(relativePath).toLowerCase();
  const parts = relativePath.toLowerCase().split('/');
  if (parts.some(part => part === '.git' || part === 'node_modules')) {
    return 'nested repository/dependency root';
  }
  if (name === '.env' || name.startsWith('.env.') || name === '.npmrc') {
    return 'environment or registry credentials';
  }
  if (/\.(?:pem|key|p12|pfx|jks|keystore|crx|zip|xpi|tar|tgz|gz|7z)$/i.test(name)) {
    return 'secret, signed, or nested archive material';
  }
  if (name.endsWith('~') || /\.(?:bak|orig|rej|swp)$/i.test(name)) {
    return 'editor or merge residue';
  }
  return undefined;
};

export const findForbiddenReleaseEntries = async (sourceRoot, directory = '') => {
  const absolute = path.join(sourceRoot, ...directory.split('/').filter(Boolean));
  const dirents = await readdir(absolute, {withFileTypes: true});
  dirents.sort((a, b) => binaryCompare(a.name, b.name));
  const findings = [];
  for (const dirent of dirents) {
    const relativePath = path.posix.join(directory, dirent.name);
    const reason = forbiddenName(relativePath);
    if (reason) {
      findings.push({path: relativePath, reason});
      continue;
    }
    if (dirent.isSymbolicLink()) {
      findings.push({path: relativePath, reason: 'symbolic link'});
    }
    else if (dirent.isDirectory()) {
      findings.push(...await findForbiddenReleaseEntries(sourceRoot, relativePath));
    }
  }
  return findings.sort((a, b) => binaryCompare(a.path, b.path));
};

export const assertReleaseContext = async ({repositoryRoot, sourceRoot} = {}) => {
  if (!repositoryRoot) {
    throw new Error('Release mode requires repositoryRoot');
  }
  repositoryRoot = path.resolve(repositoryRoot);
  sourceRoot = path.resolve(sourceRoot || path.join(repositoryRoot, 'v3'));

  let topLevel;
  try {
    topLevel = path.resolve(await git(repositoryRoot, 'rev-parse', '--show-toplevel'));
  }
  catch (error) {
    throw new Error(`Release root is not a Git worktree: ${repositoryRoot}`, {cause: error});
  }
  if (topLevel !== repositoryRoot) {
    throw new Error(`Nested release root is forbidden: expected ${topLevel}, received ${repositoryRoot}`);
  }
  const expectedSource = path.join(repositoryRoot, 'v3');
  if (sourceRoot !== expectedSource) {
    throw new Error(`Release source must be the repository v3 root: expected ${expectedSource}, received ${sourceRoot}`);
  }

  for (const [gitPath, label] of stateFiles) {
    const resolved = await git(repositoryRoot, 'rev-parse', '--git-path', gitPath);
    if (await exists(path.resolve(repositoryRoot, resolved))) {
      throw new Error(`Release mode rejects a worktree with an in-progress ${label}`);
    }
  }

  const status = await git(repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all');
  if (status) {
    const sample = status.split(/\r?\n/).slice(0, 8).join('\n');
    throw new Error(`Release mode requires a clean worktree; Git reported:\n${sample}`);
  }

  const forbidden = await findForbiddenReleaseEntries(sourceRoot);
  if (forbidden.length) {
    throw new Error(`Release source contains forbidden entries:\n${forbidden
      .map(item => `${item.path}: ${item.reason}`).join('\n')}`);
  }

  return {
    commitSha: await git(repositoryRoot, 'rev-parse', 'HEAD'),
    gitTree: await git(repositoryRoot, 'rev-parse', 'HEAD^{tree}'),
    repositoryRoot,
    sourceRoot
  };
};
