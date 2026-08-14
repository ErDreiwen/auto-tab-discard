import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {inspectDirectory} from '../scripts/archive-inventory.mjs';

const require = createRequire(import.meta.url);
const {
  browserCloseWasNominallyDispatched,
  dispatchBrowserClose,
  extensionTreeSha256,
  legacyManagedStoragePath,
  runtimeRoundTripOutcome,
  safeProfile,
  sanitizeText,
  validateLegacyProfilePath,
  validateRuntimeProbe,
  waitForRuntimeRoundTrip
} = require('../e2e/chromium-minimum-smoke.cjs');
const {cleanupExactProcessTree} = require('../e2e/windows-process-tree.cjs');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Chromium minimum tree digest matches the release inventory algorithm', async () => {
  const extension = path.join(repositoryRoot, 'v3');
  assert.equal(extensionTreeSha256(extension), (await inspectDirectory(extension)).treeSha256);
});

test('Chromium minimum runtime proof requires identity, version, origin, and both worker sentinels', () => {
  const expectedId = 'a'.repeat(32);
  const expectedVersion = '0.6.9.2';
  const probe = {
    id: expectedId,
    message: {
      error: false,
      managed: 'minimum-managed-round-trip',
      session: 'minimum-session-round-trip',
      timedOut: false
    },
    origin: `chrome-extension://${expectedId}`,
    version: expectedVersion,
    webLocks: true
  };
  assert.equal(validateRuntimeProbe({expectedId, expectedVersion, probe}), true);
  assert.throws(() => validateRuntimeProbe({
    expectedId,
    expectedVersion,
    probe: {...probe, message: {...probe.message, session: undefined}}
  }), /both worker response sentinels/);
  assert.throws(() => validateRuntimeProbe({
    expectedId,
    expectedVersion,
    probe: {...probe, message: {...probe.message, timedOut: undefined}}
  }), /timed out/);
  assert.throws(() => validateRuntimeProbe({
    expectedId,
    expectedVersion,
    probe: {...probe, message: {...probe.message, error: undefined}}
  }), /extension error/);
  assert.throws(() => validateRuntimeProbe({
    expectedId,
    expectedVersion,
    probe: {...probe, version: '0.6.9.1'}
  }), /runtime version/);
  assert.throws(() => validateRuntimeProbe({
    expectedId,
    expectedVersion,
    probe: {...probe, webLocks: false}
  }), /Web Locks API/);
});

test('runtime readiness retries target/listener races but accepts only a real sentinel response', async () => {
  const probes = [
    {message: {error: false, timedOut: true}},
    {message: {error: true, timedOut: false}},
    {message: {error: false, managed: 'wrong', session: 'wrong', timedOut: false}},
    {message: {
      error: false,
      managed: 'minimum-managed-round-trip',
      session: 'minimum-session-round-trip',
      timedOut: false
    }}
  ];
  let clock = 0;
  const progress = [];
  const result = await waitForRuntimeRoundTrip({
    attempt: async index => probes[index - 1],
    delay: async milliseconds => clock += milliseconds,
    interval: 10,
    now: () => clock,
    onProgress: state => progress.push({...state}),
    timeout: 100
  });
  assert.equal(result.attempts, 4);
  assert.deepEqual(progress.map(item => item.lastOutcome), [
    'timed-out', 'runtime-error', 'invalid-response', 'passed'
  ]);
  assert.equal(runtimeRoundTripOutcome(result.probe), 'passed');

  clock = 0;
  await assert.rejects(waitForRuntimeRoundTrip({
    attempt: async () => ({message: {error: false, timedOut: true}}),
    delay: async milliseconds => clock += milliseconds,
    interval: 10,
    now: () => clock,
    timeout: 20
  }), error => /bounded attempts \(timed-out\)/.test(error.message) &&
    error.readiness.attempts === 2 && error.readiness.lastOutcome === 'timed-out');
});

test('Chromium minimum emits the stable runtime-round-trip assertion consumed by canary policy', async () => {
  const harness = await readFile(path.join(repositoryRoot, 'e2e', 'chromium-minimum-smoke.cjs'), 'utf8');
  const policy = await readFile(path.join(repositoryRoot, 'scripts', 'browser-canary-policy.mjs'), 'utf8');
  const assertionName = 'storage runtime message completes a module-worker round trip';
  assert.match(harness, new RegExp(`pass\\('${assertionName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`));
  assert.match(policy, new RegExp(`report, '${assertionName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`));
});

test('Chromium minimum profile guard and diagnostics keep cleanup isolated and sanitized', () => {
  const root = path.join(repositoryRoot, 'build', 'minimum-profiles');
  assert.equal(safeProfile(root, path.join(root, 'atd-cm-abcdef0123456789')), true);
  assert.equal(safeProfile(root, root), false);
  assert.equal(safeProfile(root, path.join(root, '..', 'atd-cm-escape')), false);
  const sanitized = sanitizeText(`${repositoryRoot} chrome-extension://${'a'.repeat(32)}`);
  assert.doesNotMatch(sanitized, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(sanitized, /<workspace>/);
  assert.match(sanitized, /chrome-extension:\/\/<redacted>/);
});

test('expected Browser.close transport rejection plus Job zero is graceful and never force-killed', async () => {
  const close = await dispatchBrowserClose({
    send: method => {
      assert.equal(method, 'Browser.close');
      return Promise.reject(Error('Protocol error (Browser.close): Target closed.'));
    }
  }, {timeout: 50});
  assert.deepEqual(close, {dispatched: true, status: 'transport-closed'});
  assert.equal(browserCloseWasNominallyDispatched(close), true);

  const cleanup = await cleanupExactProcessTree({records: [{pid: 101}]}, {
    inspect: async () => ({active: 0, remaining: [], unverified: []}),
    nominalCloseSucceeded: browserCloseWasNominallyDispatched(close),
    now: () => 0,
    timeout: 100
  });
  assert.equal(cleanup.graceful, true);
  assert.equal(cleanup.jobEmptyVerified, true);
  assert.deepEqual(cleanup.forced, {attempted: 0, needed: false, succeeded: 0});

  const rejected = await dispatchBrowserClose({
    send: () => Promise.reject(Error('Protocol method was rejected'))
  }, {timeout: 50});
  assert.deepEqual(rejected, {dispatched: true, status: 'rejected'});
  assert.equal(browserCloseWasNominallyDispatched(rejected), false);
});

test('Chromium 102 profile budget admits 259 characters and rejects legacy MAX_PATH', () => {
  const root = path.parse(repositoryRoot).root;
  const relativeManagedPath = path.join(
    'Default', 'Managed Extension Settings', 'a'.repeat(32), 'MANIFEST-000001');
  const profileAt = targetLength => {
    const profileLength = targetLength - 1 - relativeManagedPath.length;
    return `${root}${'p'.repeat(profileLength - root.length)}`;
  };
  const admitted = profileAt(259);
  const rejected = profileAt(260);
  assert.equal(legacyManagedStoragePath(admitted).length, 259);
  assert.equal(validateLegacyProfilePath(admitted), true);
  assert.equal(legacyManagedStoragePath(rejected).length, 260);
  assert.throws(() => validateLegacyProfilePath(rejected), error =>
    error.message === 'The isolated Chromium profile exceeds the Chromium 102 managed-storage MAX_PATH budget');
});

test('Chromium 102 managed schema omits its unsupported top-level closure keyword', async () => {
  const [manifest, schema] = await Promise.all([
    readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../v3/schema.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.equal(manifest.minimum_chrome_version, '102',
    'this compatibility regression is pinned to the declared minimum browser');
  assert.equal(schema.type, 'object');
  assert.equal(Object.hasOwn(schema, 'additionalProperties'), false,
    'Chromium 102 hangs before DevTools while parsing this managed-schema keyword');
  assert.ok(Object.keys(schema.properties || {}).length > 0,
    'the compatible managed schema must retain its explicit policy catalog');
});

test('Chromium minimum harness uses a public extension-page realm and fail-closed cleanup', async () => {
  const source = await readFile(new URL('../e2e/chromium-minimum-smoke.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chromium\.launchPersistentContext/);
  assert.match(source, /launchProcessInExactJob\(\{/);
  assert.match(source, /chromium\.connectOverCDP/);
  assert.match(source, /context\.serviceWorkers\(\)/);
  assert.match(source, /context\.on\('serviceworker', observeWorkerTarget\)/);
  assert.doesNotMatch(source, /worker\.evaluate\(/);
  assert.match(source, /page\.goto\(`chrome-extension:\/\/\$\{extensionId\}/);
  assert.match(source, /return page\.evaluate\(\(\{attemptTimeout, managedSentinel, sessionSentinel\}\) => new Promise/);
  assert.match(source, /chrome\.runtime\.sendMessage\(\{/);
  assert.match(source, /method: 'storage'/);
  assert.match(source, /webLocks: typeof navigator\.locks\?\.request === 'function'/);
  assert.match(source, /serviceWorkerWebLockAcquired: true/);
  assert.match(source,
    /chrome\.permissions\.contains\(\{permissions: \['webNavigation'\]\}, granted =>/);
  assert.match(source, /identityProbe\.frameAccess\.granted === false/);
  assert.match(source,
    /JSON\.stringify\(identityProbe\.frameAccess\.optional\) === '\["webNavigation"\]'/);
  assert.match(source, /identityProbe\.frameAccess\.required\.includes\('webNavigation'\) === false/);
  assert.match(source,
    /frame enumeration remains an ungranted optional permission at Chromium minimum/);
  assert.doesNotMatch(source, /permissions\.request|permissions\.remove/,
    'the minimum gate must observe optional permission state without changing it');
  assert.match(source, /ROUND_TRIP_ATTEMPT_TIMEOUT = 2500/);
  assert.match(source, /ROUND_TRIP_READY_TIMEOUT = 30000/);
  assert.match(source, /const runId = randomBytes\(8\)\.toString\('hex'\)/);
  assert.match(source, /validateLegacyProfilePath\(profile\)/);
  assert.match(source, /const playwright = loadPlaywright\(\)/);
  assert.match(source, /playwright\.version === expectedPlaywrightVersion/);
  assert.match(source, /Playwright reports the exact pinned minimum driver/);
  assert.doesNotMatch(source, /require\('\.\/playwright-runtime\.cjs'\)/);
  assert.match(source, /waitForRuntimeRoundTrip\(\{/);
  assert.match(source, /serviceWorkerTargetChurn/);
  assert.match(source, /report\.browser\.version === expectedVersion/);
  assert.match(source, /cdp\.send\('SystemInfo\.getProcessInfo'\)/);
  assert.match(source, /cdp\.send\('Browser\.close'\)/);
  assert.doesNotMatch(source, /cdpBrowser\.close\(/);
  assert.match(source, /browserCloseWasNominallyDispatched\(close\)/);
  assert.match(source, /await bindExactProcessTree\(launched\)/);
  assert.match(source, /profileSwitch: 'user-data-dir'/);
  assert.match(source, /browserPids\[0\] === controller\.processTree\.rootPid/);
  assert.match(source, /refreshExactProcessTree\(controller\.processTree\)/);
  assert.match(source, /cleanupExactProcessTree\(controller\.processTree/);
  assert.match(source, /report\.cleanup\.process\.identityVerified !== true/);
  assert.match(source, /report\.cleanup\.process\.jobEmptyVerified !== true/);
  assert.match(source, /report\.cleanup\.process\.ownerExited !== true/);
  assert.match(source, /report\.cleanup\.process\.graceful !== true/);
  assert.match(source, /report\.cleanup\.process\.forced\?\.needed !== false/);
  assert.match(source, /owner: 'windows-kernel-job'/);
  assert.match(source, /forceCleanupExactProcessTreeSync\(controller\?\.processTree\)/);
  assert.match(source, /profile was retained because process exit was not verified/);
  assert.match(source, /fs\.rmSync\(profile/);
  assert.doesNotMatch(source, /--disable-gpu/);
});

test('checked controller validates parsed argv so whole-token quoting and spaced profile values stay exact', async () => {
  const source = await readFile(new URL('../e2e/windows-job-controller.cs', import.meta.url), 'utf8');
  assert.match(source, /argument\.StartsWith\("--user-data-dir="/);
  assert.match(source, /SamePath\(value, expectedProfile\)/);
  assert.match(source, /occurrences != 1 \|\| matches != 1/);
  assert.doesNotMatch(source, /CommandLine.*regex|profilePattern/i);
});
