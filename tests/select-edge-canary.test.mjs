import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const script = path.resolve(import.meta.dirname, '../scripts/select-edge-canary.ps1');
const powershell = process.platform === 'win32' ? path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
) : 'pwsh';
const versionedWindowsExecutable = 'C:\\Windows\\System32\\notepad.exe';

const fixture = async (t, channel = 'stable') => {
  const root = await mkdtemp(path.join(tmpdir(), 'edge-canary-select-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const edge = path.join(
    root,
    'Microsoft',
    channel === 'beta' ? 'Edge Beta' : 'Edge',
    'Application',
    'msedge.exe'
  );
  await mkdir(path.dirname(edge), {recursive: true});
  await copyFile(versionedWindowsExecutable, edge);
  return {edge, environment: path.join(root, 'github-env.txt'), root};
};

const run = (arguments_, options = {}) => exec(powershell, [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', script,
  ...arguments_
], {encoding: 'utf8', windowsHide: true, ...options});

const withPath = value => ({
  ...Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.toLowerCase() !== 'path')),
  Path: value
});

test('Edge selector source is channel-exact, version-derived, and fail-closed on PATH ambiguity', async () => {
  const source = (await readFile(script, 'utf8')).replaceAll('\r\n', '\n');
  assert.match(source, /\[ValidateSet\('stable', 'beta'\)\]/);
  assert.match(source, /'\\Microsoft\\Edge Beta\\Application\\msedge\.exe'/);
  assert.match(source, /'\\Microsoft\\Edge\\Application\\msedge\.exe'/);
  assert.match(source, /\.EndsWith\([\s\S]+\[System\.StringComparison\]::OrdinalIgnoreCase/);
  assert.match(source, /Get-Command \$PathCommand -All -CommandType Application/);
  assert.match(source, /if \(\$pathCandidates\.Count -gt 1\)[\s\S]+PATH resolved more than one/);
  assert.match(source, /\$selected\.VersionInfo\.ProductVersion[\s\S]+\$selected\.VersionInfo\.FileVersion/);
  assert.match(source, /\^\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+\$/);
  assert.match(source, /CANARY_EXECUTABLE=\$\(\$selected\.FullName\)/);
  assert.match(source, /CANARY_INSTALLED_VERSION=\$version/);
});

test('Edge selector prefers a valid action path and records its actual numeric file version', {
  skip: process.platform !== 'win32'
}, async t => {
  const {edge, environment} = await fixture(t);
  const {stdout} = await run([
    '-ActionPath', edge,
    '-Channel', 'stable',
    '-EnvironmentFile', environment,
    '-PathCommand', ''
  ]);
  const selected = JSON.parse(stdout.trim());
  assert.equal(path.resolve(selected.executable), path.resolve(edge));
  assert.match(selected.version, /^\d+\.\d+\.\d+\.\d+$/);
  const lines = (await readFile(environment, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(lines, [
    `CANARY_EXECUTABLE=${path.resolve(edge)}`,
    'CANARY_INSTALLER=browser-actions/setup-edge@v1+verified-file-version',
    `CANARY_INSTALLED_VERSION=${selected.version}`
  ]);
  assert.notEqual(selected.version, 'stable');
});

test('Edge selector falls back from an empty action output to an exact known executable', {
  skip: process.platform !== 'win32'
}, async t => {
  const {edge, environment} = await fixture(t, 'beta');
  const {stdout} = await run([
    '-ActionPath', '',
    '-Channel', 'beta',
    '-EnvironmentFile', environment,
    '-KnownPath', edge,
    '-PathCommand', ''
  ]);
  const selected = JSON.parse(stdout.trim());
  assert.equal(path.resolve(selected.executable), path.resolve(edge));
  assert.match(selected.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.notEqual(selected.version, 'beta');
});

test('Edge selector accepts a channel-exact PATH fallback and still reads the file version', {
  skip: process.platform !== 'win32'
}, async t => {
  const {edge, environment} = await fixture(t, 'beta');
  const {stdout} = await run([
    '-ActionPath', '',
    '-Channel', 'beta',
    '-EnvironmentFile', environment,
    '-KnownPath', path.join(path.dirname(edge), 'missing', 'msedge.exe'),
    '-PathCommand', edge
  ]);
  const selected = JSON.parse(stdout.trim());
  assert.equal(path.resolve(selected.executable), path.resolve(edge));
  assert.match(selected.version, /^\d+\.\d+\.\d+\.\d+$/);
});

test('Edge selector rejects an executable from the wrong release channel', {
  skip: process.platform !== 'win32'
}, async t => {
  const {edge, environment} = await fixture(t, 'stable');
  await assert.rejects(run([
    '-ActionPath', edge,
    '-Channel', 'beta',
    '-EnvironmentFile', environment,
    '-KnownPath', edge,
    '-PathCommand', ''
  ]), /Unable to resolve an existing msedge\.exe/);
});

test('Edge selector rejects ambiguous channel-exact PATH candidates', {
  skip: process.platform !== 'win32'
}, async t => {
  const {edge, environment, root} = await fixture(t, 'beta');
  const second = path.join(
    root, 'alternate', 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'
  );
  await mkdir(path.dirname(second), {recursive: true});
  await copyFile(versionedWindowsExecutable, second);
  await assert.rejects(run([
    '-ActionPath', '',
    '-Channel', 'beta',
    '-EnvironmentFile', environment,
    '-KnownPath', path.join(root, 'missing', 'msedge.exe')
  ], {
    env: withPath([path.dirname(edge), path.dirname(second)].join(path.delimiter))
  }), /PATH resolved more than one beta Edge executable/);
});

test('Edge selector fails closed when action, known, and PATH candidates are unavailable', {
  skip: process.platform !== 'win32'
}, async t => {
  const {environment, root} = await fixture(t);
  const missing = path.join(root, 'missing', 'msedge.exe');
  await mkdir(path.dirname(missing), {recursive: true});
  await assert.rejects(run([
    '-ActionPath', missing,
    '-Channel', 'stable',
    '-EnvironmentFile', environment,
    '-KnownPath', missing,
    '-PathCommand', ''
  ]), /Unable to resolve an existing msedge\.exe/);
});
