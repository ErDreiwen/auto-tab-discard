import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {appendFileSync, renameSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, truncate, writeFile} from 'node:fs/promises';

import {inspectDirectory} from '../scripts/archive-inventory.mjs';

const require = createRequire(import.meta.url);
const {
  crashArtifacts,
  diffExternalFirefoxCrashState,
  externalFirefoxCrashRoots,
  extensionTreeSha256,
  firefoxCrashEnvironment,
  firefoxCrashIsolation,
  firefoxCrashLocations,
  safeProfile,
  sanitizeText,
  snapshotExternalFirefoxCrashState
} = require('../e2e/firefox-bidi-smoke.cjs');

test('Firefox smoke sanitizes private paths, extension origins, and fixture identities', () => {
  const source = [
    path.resolve('secret-workspace', 'extension'),
    'C:\\Users\\alice\\private',
    'moz-extension://12345678-1234-1234-1234-123456789abc/data/popup/index.html',
    'http://127.0.0.1:4567/firefox-bidi-smoke/12345678-1234-1234-1234-123456789abc/ordinary',
    'WebDriver BiDi listening on ws://127.0.0.1:9222',
    'incoming connection from 127.0.0.1:9223',
    'Firefox BiDi ordinary 12345678-1234-1234-1234-123456789abc'
  ].join(' ');
  const sanitized = sanitizeText(source);

  assert.doesNotMatch(sanitized, /Users\\alice|moz-extension:\/\/1234|127\.0\.0\.1:\d+|12345678-1234/);
  assert.match(sanitized, /<user-path>|<workspace>/);
  assert.match(sanitized, /moz-extension:\/\/<redacted>/);
  assert.match(sanitized, /<fixture-url>/);
  assert.match(sanitized, /<loopback-url>/);
  assert.match(sanitized, /<loopback-endpoint>/);
  assert.match(sanitized, /Firefox BiDi ordinary <token>/);
});

test('Firefox profile cleanup accepts only named children of the configured root', () => {
  const root = path.resolve('e2e', '.profiles');
  assert.equal(safeProfile(root, path.join(root, 'firefox-bidi-smoke-1')), true);
  assert.equal(safeProfile(root, root), false);
  assert.equal(safeProfile(root, path.resolve(root, '..', 'firefox-bidi-smoke-1')), false);
  assert.equal(safeProfile(root, path.join(root, 'unrelated-profile')), false);
});

test('Firefox evidence uses the canonical archive-inventory tree digest without exposing a path', async () => {
  const extension = path.resolve(import.meta.dirname, '..', 'v3');
  const inventory = await inspectDirectory(extension);
  assert.equal(extensionTreeSha256(extension), inventory.treeSha256);

  const source = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');
  assert.match(source, /treeSha256: extensionTreeSha256\(extension\)/);
  assert.match(source,
    /hash\.update\(entry\.path, 'utf8'\)[\s\S]*hash\.update\('\\0'\)[\s\S]*hash\.update\(entry\.data\)[\s\S]*hash\.update\('\\0'\)/);
  assert.doesNotMatch(source, /extension: \{[^}]*\bpath\s*:/s);
});

test('Firefox smoke source uses raw BiDi, temporary path install, scoped runtime command, and exact-tree cleanup', async () => {
  const source = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');

  assert.match(source, /new WebSocket\(url\)/);
  assert.match(source, /bidi\.send\('session\.new'/);
  assert.match(source, /bidi\.send\('webExtension\.install'/);
  assert.match(source, /\{path: extension, type: 'path'\}/);
  assert.match(source, /'moz:permanent': false/);
  assert.match(source, /manifest\.browser_specific_settings\?\.gecko\?\.id/);
  assert.match(source, /extensionHandle === extensionId/);
  assert.doesNotMatch(source, /c2c003ee-bd69-42a2-b0e9-6f34222cb046/);
  assert.match(source, /'moz:scope': 'chrome'/);
  assert.match(source, /runPopupCommand\(bidi, controllerContext, 'discard-window'\)/);
  assert.match(source, /onSpawn: child =>/);
  assert.match(source, /WebDriver BiDi command timed out/);
  assert.match(source, /summarizePostSettlement/);
  assert.match(source, /extra ordinary navigation, including an aborted reload/);
  assert.match(source, /removeTabs\(bidi, controllerContext/);
  assert.match(source, /launchProcessInExactJob\(\{/);
  assert.match(source, /await bindExactProcessTree\(launched\)/);
  assert.match(source, /refreshExactProcessTree\(browser\.processTree\)/);
  assert.match(source, /cleanupExactProcessTree\(browser\.processTree/);
  assert.match(source, /cleanup\.exited === true && cleanup\.identityVerified === true/);
  assert.match(source, /forceCleanupExactProcessTreeSync\(browser\?\.processTree\)/);
  assert.match(source, /PID-only Firefox cleanup is forbidden on Windows/);
  assert.doesNotMatch(source, /taskkill/i);
  const emergencyCleanup = source.slice(
    source.indexOf('const emergencyCleanup ='),
    source.indexOf("process.once('exit', emergencyCleanup)")
  );
  assert.doesNotMatch(emergencyCleanup, /removeProfile/);
  assert.match(source, /cleanup\.jobEmptyVerified === true &&[\s\S]*cleanup\.ownerExited === true/);
  assert.match(source, /ensure\(!browser\?\.child \|\| processExitVerified,[\s\S]*crash\/profile cleanup was skipped/);
  assert.match(source,
    /report\.profile\.crashArtifacts = artifacts;[\s\S]*report\.profile\.crashLocationsChecked =[\s\S]*report\.profile\.externalCrashState = externalCrashChanges;[\s\S]*ensure\(externalCrashChanges\.changed === 0[\s\S]*ensure\(artifacts === 0/,
  'profile and external crash evidence must be recorded before either assertion can fail');
});

test('Firefox crash reporting is non-reporting, isolated, and checked across every exact crash location', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atd-firefox-crash-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const profile = path.join(root, 'profile');
  const appData = path.join(root, 'appdata');
  const isolation = firefoxCrashIsolation(profile);
  for (const directory of Object.values(isolation)) {
    await mkdir(directory, {recursive: true});
  }

  const environment = firefoxCrashEnvironment(profile, {
    KEEP_ME: 'yes',
    APPDATA: appData,
    MOZ_APP_DATA: 'C:\\unsupported-app-data',
    MOZ_LOCAL_APP_DATA: 'C:\\unsupported-local-app-data',
    MOZ_CRASHREPORTER_AUTO_SUBMIT: '1',
    MOZ_CRASHREPORTER_DATA_DIRECTORY: 'C:\\outside-data',
    MOZ_CRASHREPORTER_DISABLE: '1',
    MOZ_CRASHREPORTER_EVENTS_DIRECTORY: 'C:\\outside-events',
    MOZ_CRASHREPORTER_FULLDUMP: '1',
    MOZ_CRASHREPORTER_PING_DIRECTORY: 'C:\\outside-pings',
    MOZ_CRASHREPORTER_URL: 'https://example.invalid/private'
  });
  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal(environment.APPDATA, appData);
  assert.equal(environment.MOZ_CRASHREPORTER, '1');
  assert.equal(environment.MOZ_CRASHREPORTER_NO_REPORT, '1');
  assert.equal(environment.MOZ_APP_DATA, undefined);
  assert.equal(environment.MOZ_LOCAL_APP_DATA, undefined);
  assert.equal(environment.CRASHES_EVENTS_DIR, isolation.events);
  assert.equal(environment.MOZ_CRASHREPORTER_DATA_DIRECTORY, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_EVENTS_DIRECTORY, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_PING_DIRECTORY, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_AUTO_SUBMIT, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_DISABLE, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_FULLDUMP, undefined);
  assert.equal(environment.MOZ_CRASHREPORTER_URL, undefined);
  assert.deepEqual(firefoxCrashLocations(profile).map(location => location.name), [
    'profile-minidumps', 'crash-events'
  ]);

  assert.equal(crashArtifacts(profile), 0);
  await writeFile(path.join(isolation.minidumps, 'one.dmp'), 'dump');
  await writeFile(path.join(isolation.events, 'event'), 'event');
  assert.equal(crashArtifacts(profile), 2);

  const resolver = {resolveApplicationData: () => appData};
  const externalRoots = externalFirefoxCrashRoots(environment, 'win32', resolver);
  assert.deepEqual(externalRoots.map(item => item.root.replaceAll('\\', '/').slice(appData.length + 1)), [
    'Mozilla/Firefox/Crash Reports', 'Mozilla/Firefox/Pending Pings'
  ]);
  const crashReports = externalRoots.find(item => item.category === 'crashReports').root;
  const pendingPings = externalRoots.find(item => item.category === 'pendingPings').root;
  await mkdir(crashReports, {recursive: true});
  await mkdir(pendingPings, {recursive: true});
  await writeFile(path.join(crashReports, 'LastCrash'), 'baseline');
  await writeFile(path.join(crashReports, 'InstallTime140'), 'baseline');
  const before = snapshotExternalFirefoxCrashState(environment, 'win32', resolver);
  await writeFile(path.join(crashReports, 'LastCrash'), 'changed');
  await writeFile(path.join(crashReports, 'InstallTime140'), 'changed metadata');
  await writeFile(path.join(crashReports, 'InstallTime140-new'), 'new metadata');
  await writeFile(path.join(pendingPings, 'new-ping'), 'ping');
  const after = snapshotExternalFirefoxCrashState(environment, 'win32', resolver);
  const changes = diffExternalFirefoxCrashState(before, after);
  assert.deepEqual(changes, {
    categories: {
      crashReports: {changed: 1, created: 0, removed: 0},
      pendingPings: {changed: 0, created: 1, removed: 0}
    },
    allowedCrashReporterSettings: {changed: 0, created: 0},
    allowedInstallTime: {changed: 1, created: 1},
    changed: 1,
    created: 1,
    removed: 0
  });
  assert.doesNotMatch(JSON.stringify(changes), /LastCrash|new-ping|appdata/i,
    'external crash-state report contains only fixed categories and counts');

  assert.throws(() => externalFirefoxCrashRoots({}, 'win32', resolver), /absolute APPDATA/);
  assert.throws(() => externalFirefoxCrashRoots(environment, 'win32', {
    resolveApplicationData: () => path.join(root, 'different-appdata')
  }), /mismatch/);

  await rm(crashReports, {force: true, recursive: true});
  await mkdir(crashReports, {recursive: true});
  const oversized = path.join(crashReports, 'oversized.dmp');
  await writeFile(oversized, '');
  await truncate(oversized, 256 * 1024 * 1024 + 1);
  assert.throws(() => snapshotExternalFirefoxCrashState(environment, 'win32', resolver),
    /byte bound/);

  await rm(crashReports, {force: true, recursive: true});
  await mkdir(path.join(crashReports, 'one', 'two', 'three'), {recursive: true});
  assert.throws(() => snapshotExternalFirefoxCrashState(environment, 'win32', {
    ...resolver,
    maxDepth: 2
  }), /depth bound/);

  await rm(crashReports, {force: true, recursive: true});
  await mkdir(crashReports, {recursive: true});
  await Promise.all(['one', 'two', 'three'].map(name => writeFile(path.join(crashReports, name), name)));
  assert.throws(() => snapshotExternalFirefoxCrashState(environment, 'win32', {
    ...resolver,
    maxEntries: 2
  }), /entry bound/);

  await rm(crashReports, {force: true, recursive: true});
  await mkdir(crashReports, {recursive: true});
  const replaceTarget = path.join(crashReports, 'replace.dmp');
  await writeFile(replaceTarget, 'original');
  let replaced = false;
  assert.throws(() => snapshotExternalFirefoxCrashState(environment, 'win32', {
    ...resolver,
    beforeOpen: absolute => {
      if (!replaced && absolute === replaceTarget) {
        replaced = true;
        renameSync(absolute, `${absolute}.old`);
        writeFileSync(absolute, 'replacement');
      }
    }
  }), /replaced file/);

  await rm(crashReports, {force: true, recursive: true});
  await mkdir(crashReports, {recursive: true});
  const growthTarget = path.join(crashReports, 'growth.dmp');
  await writeFile(growthTarget, Buffer.alloc(128 * 1024, 1));
  let grew = false;
  assert.throws(() => snapshotExternalFirefoxCrashState(environment, 'win32', {
    ...resolver,
    afterReadChunk: ({absolute, readCount}) => {
      if (!grew && absolute === growthTarget && readCount === 1) {
        grew = true;
        appendFileSync(absolute, 'growth');
      }
    }
  }), /unstable file/);

  const hostileAppData = process.platform === 'win32' ?
    String.raw`\\hostile-server\private-user-id` : path.join(root, 'private-user-id');
  const hostileEnvironment = {APPDATA: hostileAppData};
  assert.throws(() => snapshotExternalFirefoxCrashState(hostileEnvironment, 'win32', {
    beforeRoot: externalRoot => {
      throw Error(`EACCES ${externalRoot}`);
    },
    resolveApplicationData: () => hostileAppData
  }), error => error.message === 'Firefox external crash-state snapshot I/O failed' &&
    !/hostile-server|private-user-id/i.test(error.message));

  const smokeSource = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');
  const scanner = smokeSource.slice(
    smokeSource.indexOf('const snapshotExternalFirefoxCrashStateUnsafe ='),
    smokeSource.indexOf('const diffExternalFirefoxCrashState =')
  );
  assert.match(scanner, /opendirSync/);
  assert.match(scanner, /openSync/);
  assert.match(scanner, /fstatSync/);
  assert.match(scanner, /readSync/);
  assert.doesNotMatch(scanner, /readFileSync/);
});

test('Firefox external crash-state diff allows only top-level crash reporter settings creation and change', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atd-firefox-settings-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const appData = path.join(root, 'appdata');
  const environment = {APPDATA: appData};
  const options = {resolveApplicationData: () => appData};
  const [{root: crashReports}] = externalFirefoxCrashRoots(environment, 'win32', options);
  await mkdir(crashReports, {recursive: true});

  const beforeCreation = snapshotExternalFirefoxCrashState(environment, 'win32', options);
  const settings = path.join(crashReports, 'CrAsHrEpOrTeR_SeTtInGs.JsOn');
  await writeFile(settings, '{"submit_report":true}');
  const afterCreation = snapshotExternalFirefoxCrashState(environment, 'win32', options);
  assert.deepEqual(diffExternalFirefoxCrashState(beforeCreation, afterCreation), {
    categories: {
      crashReports: {changed: 0, created: 0, removed: 0},
      pendingPings: {changed: 0, created: 0, removed: 0}
    },
    allowedCrashReporterSettings: {changed: 0, created: 1},
    allowedInstallTime: {changed: 0, created: 0},
    changed: 0,
    created: 0,
    removed: 0
  });

  await writeFile(settings, '{"submit_report":false,"changed":true}');
  const afterChange = snapshotExternalFirefoxCrashState(environment, 'win32', options);
  assert.deepEqual(diffExternalFirefoxCrashState(afterCreation, afterChange), {
    categories: {
      crashReports: {changed: 0, created: 0, removed: 0},
      pendingPings: {changed: 0, created: 0, removed: 0}
    },
    allowedCrashReporterSettings: {changed: 1, created: 0},
    allowedInstallTime: {changed: 0, created: 0},
    changed: 0,
    created: 0,
    removed: 0
  });
});

test('Firefox external crash-state diff rejects settings removal, lookalikes, and nested names', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atd-firefox-settings-negative-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const appData = path.join(root, 'appdata');
  const environment = {APPDATA: appData};
  const options = {resolveApplicationData: () => appData};
  const [{root: crashReports}] = externalFirefoxCrashRoots(environment, 'win32', options);
  await mkdir(path.join(crashReports, 'nested'), {recursive: true});
  const settings = path.join(crashReports, 'crashreporter_settings.json');
  await writeFile(settings, '{"submit_report":true}');
  const before = snapshotExternalFirefoxCrashState(environment, 'win32', options);

  await rm(settings);
  await writeFile(path.join(crashReports, 'crashreporter_settings.json.bak'), 'lookalike');
  await writeFile(path.join(crashReports, 'nested', 'crashreporter_settings.json'), 'nested');
  const after = snapshotExternalFirefoxCrashState(environment, 'win32', options);
  assert.deepEqual(diffExternalFirefoxCrashState(before, after), {
    categories: {
      crashReports: {changed: 0, created: 2, removed: 1},
      pendingPings: {changed: 0, created: 0, removed: 0}
    },
    allowedCrashReporterSettings: {changed: 0, created: 0},
    allowedInstallTime: {changed: 0, created: 0},
    changed: 0,
    created: 2,
    removed: 1
  });
});

test('Firefox minimum mode installs the exact XPI and proves Firefox 140 background startup without privileged BiDi', async () => {
  const source = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');
  const minimumVerifier = source.slice(
    source.indexOf('const verifyMinimumRuntime ='),
    source.indexOf('const safeProfile =')
  );

  assert.match(source, /minimumStartupOnly \? \{path: archive, type: 'archivePath'\}/);
  assert.match(source, /archiveSha256: createHash\('sha256'\)\.update\(fs\.readFileSync\(archive\)\)\.digest\('hex'\)/);
  assert.match(source, /user_pref\("remote\.active-protocols", 3\)/);
  assert.match(source, /minimumStartupOnly[\s\S]*process\.platform === 'win32'/);
  assert.match(source, /allowSystemAccess: !minimumStartupOnly/);
  assert.match(source, /\.\.\.\(allowSystemAccess \? \['--remote-allow-system-access'\] : \[\]\)/);
  assert.match(source, /report\.browser\.version === expectedVersion/);
  assert.match(minimumVerifier, /\/json\/new/);
  assert.match(source, /const putJson = url => requestJson\(url, 'PUT'\)/);
  assert.match(minimumVerifier, /await putJson/);
  assert.match(minimumVerifier, /moz-extension:\/\/\$\{uuid\}\/data\/popup\/index\.html/);
  assert.match(minimumVerifier, /moz-extension:\/\/\$\{uuid\}\/firefox\/background\.html/);
  assert.match(minimumVerifier, /chrome\.runtime\.getBackgroundPage/);
  assert.match(source, /cdp\.send\('Runtime\.evaluate'/);
  assert.match(minimumVerifier, /cdpEvaluateJson\(cdp/);
  assert.match(minimumVerifier, /runtimeMessageHandled: true/);
  assert.match(minimumVerifier, /\[102,102,102,255\]/);
  assert.doesNotMatch(minimumVerifier, /moz:scope|remote-allow-system-access/);
});

test('release gate binds Chromium and Firefox evidence to their target-specific extracted artifact digests', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const edgeStart = gate.indexOf('const frozenDirectory =');
  const firefoxStart = gate.indexOf("id: 'firefox-bidi-smoke'", edgeStart);
  assert.ok(edgeStart > 0 && firefoxStart > edgeStart, 'browser evidence blocks exist in release order');

  const edgeBlock = gate.slice(edgeStart, firefoxStart);
  const firefoxBlock = gate.slice(firefoxStart, gate.indexOf('for (const result of browserRuns)', firefoxStart));
  assert.match(edgeBlock, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(edgeBlock, /tested tree digest does not match the release artifact/);
  assert.match(firefoxBlock, /'--extension', firefoxExtractedRoot/);
  assert.match(firefoxBlock, /report\.extension\?\.treeSha256 !== firefoxArchiveInventory\.treeSha256/);
  assert.match(firefoxBlock, /tested tree digest does not match the release artifact/);
  assert.match(gate, /const chromiumArtifact = await extractPackagedArtifact\('chromium'\)/);
  assert.match(gate, /const firefoxArtifact = await extractPackagedArtifact\('firefox'\)/);
});
