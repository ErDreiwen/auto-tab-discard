#!/usr/bin/env node

// Refresh one fixed, unpacked Chromium copy of the extension for daily use.
// It pulls the current branch, runs the Node test suite (no browser opens),
// and rebuilds the folder in place so its path and extension ID never change.
// Load the folder once with "Load unpacked"; after each update, click Reload.
//
//   node scripts/update-local-extension.mjs [--target DIR] [--skip-pull] [--skip-tests]

import {execFile} from 'node:child_process';
import {copyFile, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {deriveReleaseManifests} from './manifest-policy.mjs';

const exec = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'AutoTabDiscardHardened',
  'chromium'
);
// Same package contents as scripts/package-release.mjs: the tracked v3 tree
// without its icon scratch files, plus the release root documents.
const ROOT_FILES = [
  'FORK_NOTES.md',
  'LICENSE',
  'README.md',
  'docs/DIAGNOSTICS.md',
  'docs/MIGRATIONS.md',
  'docs/PERMISSION_CHANGES.md',
  'docs/RELEASE_PACKAGING.md',
  'docs/release-policy.json'
];
const excludedPath = relative => relative === 'data/icons/convert.txt' ||
  relative.startsWith('data/icons/tmp/');

const parseArguments = arguments_ => {
  const options = {pull: true, target: DEFAULT_TARGET, tests: true};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === '--skip-pull') options.pull = false;
    else if (name === '--skip-tests') options.tests = false;
    else if (name === '--target' && arguments_[index + 1]) options.target = path.resolve(arguments_[++index]);
    else throw new Error('Usage: node scripts/update-local-extension.mjs [--target DIR] [--skip-pull] [--skip-tests]');
  }
  return options;
};

const git = async (...arguments_) => (await exec('git', arguments_, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
})).stdout;

const step = message => process.stdout.write(`${message}\n`);

const pullLatest = async () => {
  if ((await git('status', '--porcelain')).trim()) {
    throw new Error('The repository has uncommitted changes; commit or stash them, or use --skip-pull');
  }
  step('Pulling the latest code...');
  const output = await git('pull', '--ff-only');
  step(`  ${output.trim().split('\n').at(-1)}`);
};

const runTests = async () => {
  step('Running the Node test suite (no browser opens)...');
  try {
    const {stdout} = await exec(process.execPath, ['--test', 'tests/*.test.mjs'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    const summary = stdout.match(/^ℹ pass (\d+)/m)?.[1];
    step(`  ${summary ? `${summary} tests passed` : 'tests passed'}`);
  }
  catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim().split('\n');
    process.stderr.write(`${output.slice(-40).join('\n')}\n`);
    throw new Error('Tests failed; the installed extension was left unchanged');
  }
};

const stagePackage = async staging => {
  await rm(staging, {force: true, recursive: true});
  const tracked = (await git('ls-files', '-z', 'v3')).split('\0').filter(Boolean)
    .map(file => file.slice('v3/'.length))
    .filter(relative => !excludedPath(relative));
  for (const relative of tracked) {
    const destination = path.join(staging, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    if (relative === 'manifest.json') {
      const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'v3', relative), 'utf8'));
      await writeFile(destination, `${JSON.stringify(deriveReleaseManifests(manifest).chromium, null, 2)}\n`);
    }
    else {
      await copyFile(path.join(repositoryRoot, 'v3', relative), destination);
    }
  }
  for (const relative of ROOT_FILES) {
    const destination = path.join(staging, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(path.join(repositoryRoot, relative), destination);
  }
  // The root README replaces v3/README.md, so count unique paths.
  return new Set([...tracked, ...ROOT_FILES]).size;
};

// Replace the folder's contents, never the folder itself: an unpacked
// extension's ID is derived from its path.
const replaceContents = async (staging, target) => {
  await mkdir(target, {recursive: true});
  for (const entry of await readdir(target)) {
    await rm(path.join(target, entry), {force: true, recursive: true});
  }
  for (const entry of await readdir(staging, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const source = path.join(entry.parentPath, entry.name);
    const destination = path.join(target, path.relative(staging, source));
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(source, destination);
  }
  await rm(staging, {force: true, recursive: true});
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.pull) await pullLatest();
  if (options.tests) await runTests();
  const staging = `${options.target}.staging`;
  step('Packaging the Chromium build...');
  const count = await stagePackage(staging);
  await replaceContents(staging, options.target);
  const {version} = JSON.parse(await readFile(path.join(options.target, 'manifest.json'), 'utf8'));
  const commit = (await git('rev-parse', '--short', 'HEAD')).trim();
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  step('');
  step(`Updated ${options.target}`);
  step(`  version ${version}, commit ${commit} (${branch}), ${count} files`);
  step('Now click Reload on "Auto Tab Discard (Hardened)" in edge://extensions or chrome://extensions.');
  step('First time only: turn on Developer mode, click "Load unpacked", and choose the folder above.');
};

main().catch(error => {
  process.stderr.write(`\nUpdate failed: ${error.message}\n`);
  process.exitCode = 1;
});
