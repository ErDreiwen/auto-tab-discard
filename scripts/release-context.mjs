import {execFile} from 'node:child_process';
import {access, lstat, readdir, realpath} from 'node:fs/promises';
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

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`));
};

const containsPosixPath = (root, candidate) => candidate === root || candidate.startsWith(`${root}/`);

const findTrackedReleaseSymlinks = async (
  repositoryRoot,
  sourceRoot,
  injectedPaths = [],
  commitSha = 'HEAD'
) => {
  const relativeSource = path.relative(repositoryRoot, sourceRoot).split(path.sep).join('/');
  const listing = await git(repositoryRoot, 'ls-tree', '-r', '-z', commitSha);
  return listing.split('\0').filter(Boolean).flatMap(record => {
    if (!record.startsWith('120000 ')) {
      return [];
    }
    const separator = record.indexOf('\t');
    if (separator === -1) {
      throw new Error('Git returned a malformed release-tree entry');
    }
    const trackedPath = record.slice(separator + 1).replaceAll('\\', '/');
    const included = containsPosixPath(relativeSource, trackedPath) || injectedPaths.some(input =>
      trackedPath === input || input.startsWith(`${trackedPath}/`));
    if (!included) {
      return [];
    }
    const prefix = `${relativeSource}/`;
    return [{
      path: trackedPath.startsWith(prefix) ? trackedPath.slice(prefix.length) : trackedPath,
      reason: 'symbolic link in Git tree'
    }];
  }).sort((a, b) => binaryCompare(a.path, b.path));
};

const resolveFuturePath = async target => {
  const suffix = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const resolved = await realpath(cursor);
      const status = await lstat(resolved);
      if (suffix.length && !status.isDirectory()) {
        throw new Error(`Release output has a non-directory ancestor: ${cursor}`);
      }
      if (!suffix.length && !status.isDirectory()) {
        throw new Error(`Release output is not a directory: ${target}`);
      }
      return path.resolve(resolved, ...suffix);
    }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`Release output has no resolvable directory ancestor: ${target}`, {cause: error});
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};

const gitIgnored = async (repositoryRoot, relativePath) => {
  try {
    await git(repositoryRoot, 'check-ignore', '--quiet', '--no-index', '--', relativePath);
    return true;
  }
  catch (error) {
    if (error?.code === 1) {
      return false;
    }
    throw new Error(`Unable to verify the release output ignore policy: ${relativePath}`, {cause: error});
  }
};

export const assertReleaseOutput = async ({repositoryRoot, sourceRoot, outputDirectory} = {}) => {
  if (!repositoryRoot || !outputDirectory) {
    throw new Error('Release output validation requires repositoryRoot and outputDirectory');
  }
  repositoryRoot = path.resolve(repositoryRoot);
  sourceRoot = path.resolve(sourceRoot || path.join(repositoryRoot, 'v3'));
  outputDirectory = path.resolve(outputDirectory);

  const [resolvedRepository, resolvedSource, resolvedOutput] = await Promise.all([
    realpath(repositoryRoot),
    realpath(sourceRoot),
    resolveFuturePath(outputDirectory)
  ]);
  if (isWithin(sourceRoot, outputDirectory) || isWithin(resolvedSource, resolvedOutput)) {
    throw new Error(`Release output must not equal or be inside the release source: ${outputDirectory}`);
  }

  const internalPaths = [];
  if (isWithin(repositoryRoot, outputDirectory)) {
    internalPaths.push(path.relative(repositoryRoot, outputDirectory));
  }
  if (isWithin(resolvedRepository, resolvedOutput)) {
    internalPaths.push(path.relative(resolvedRepository, resolvedOutput));
  }
  for (const relative of [...new Set(internalPaths.map(item => item.split(path.sep).join('/')))]) {
    if (!relative || !await gitIgnored(repositoryRoot, relative)) {
      throw new Error(`Release output inside the repository must be Git-ignored: ${outputDirectory}`);
    }
  }
  return resolvedOutput;
};

export const assertUnaliasedReleaseWorkspace = async ({repositoryRoot, workspaceDirectory} = {}) => {
  if (!repositoryRoot || !workspaceDirectory) {
    throw new Error('Release workspace validation requires repositoryRoot and workspaceDirectory');
  }
  repositoryRoot = path.resolve(repositoryRoot);
  workspaceDirectory = path.resolve(workspaceDirectory);
  const relative = path.relative(repositoryRoot, workspaceDirectory);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Release-gate workspace must remain inside the repository');
  }
  let cursor = repositoryRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const status = await lstat(cursor);
      if (status.isSymbolicLink()) {
        throw new Error(`Release-gate workspace contains a symbolic-link component: ${cursor}`);
      }
      if (!status.isDirectory()) {
        throw new Error(`Release-gate workspace contains a non-directory component: ${cursor}`);
      }
    }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return workspaceDirectory;
      }
      throw error;
    }
  }
  return workspaceDirectory;
};

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

export const assertReleaseContext = async ({repositoryRoot, sourceRoot, injectedPaths = []} = {}) => {
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

  const commitSha = await git(repositoryRoot, 'rev-parse', 'HEAD');
  const status = await git(repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all');
  if (status) {
    const sample = status.split(/\r?\n/).slice(0, 8).join('\n');
    throw new Error(`Release mode requires a clean worktree; Git reported:\n${sample}`);
  }

  // Git can materialize a mode-120000 entry as an ordinary placeholder file
  // when core.symlinks=false. Inspect the committed tree so that platform
  // checkout behavior cannot weaken the release-source policy.
  const trackedSymlinks = await findTrackedReleaseSymlinks(
    repositoryRoot,
    sourceRoot,
    injectedPaths,
    commitSha
  );
  if (trackedSymlinks.length) {
    throw new Error(`Release source contains forbidden Git entries:\n${trackedSymlinks
      .map(item => `${item.path}: ${item.reason}`).join('\n')}`);
  }

  const forbidden = await findForbiddenReleaseEntries(sourceRoot);
  if (forbidden.length) {
    throw new Error(`Release source contains forbidden entries:\n${forbidden
      .map(item => `${item.path}: ${item.reason}`).join('\n')}`);
  }

  if (await git(repositoryRoot, 'rev-parse', 'HEAD') !== commitSha) {
    throw new Error('Release mode rejects a worktree whose Git HEAD changed during validation');
  }

  return {
    commitSha,
    gitTree: await git(repositoryRoot, 'rev-parse', `${commitSha}^{tree}`),
    repositoryRoot,
    sourceRoot
  };
};
