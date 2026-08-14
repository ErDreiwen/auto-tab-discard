import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {
  createCanaryEvidence,
  loadCanaryPolicy,
  verifyCanaryEvidence
} from '../scripts/browser-canary-policy.mjs';
import {inventorySha256} from '../scripts/cross-builder-provenance.mjs';

const hash = character => character.repeat(64);
const scenarioNames = [
  'discard-tab',
  'discard-tree-ungrouped',
  'discard-tree-normal-takeover',
  'discard-tree-shift-takeover',
  'discard-window-normal-and-fresh-shift',
  'discard-rights-normal-and-fresh-shift',
  'discard-lefts-normal-and-fresh-shift',
  'discard-other-windows-normal-and-fresh-shift',
  'discard-tabs-normal-and-fresh-shift',
  'release-window',
  'release-rights',
  'release-lefts',
  'release-other-windows',
  'release-tabs',
  'edge-replacement-lineage-observation'
];

const artifact = {
  artifacts: {
    chromium: {
      bytes: 100,
      entryCount: 1,
      file: 'canary.zip',
      inventory: [{bytes: 42, path: 'manifest.json', sha256: hash('d')}],
      sha256: hash('a'),
      treeSha256: hash('b')
    },
    firefox: {
      bytes: 110,
      entryCount: 1,
      file: 'canary.xpi',
      inventory: [{bytes: 52, path: 'manifest.json', sha256: hash('c')}],
      sha256: hash('e'),
      treeSha256: hash('f')
    }
  },
  extensionVersion: '0.6.9.2',
  formatVersion: 4
};

const reproducibility = {
  builders: [
    {id: 'linux', runnerImage: 'ubuntu-test', runnerOs: 'Linux'},
    {id: 'windows', runnerImage: 'windows-test', runnerOs: 'Windows'}
  ],
  canonical: {
    builderId: 'linux',
    commitSha: 'a'.repeat(40),
    extensionVersion: artifact.extensionVersion,
    gitTree: 'b'.repeat(40),
    targets: Object.fromEntries(Object.entries(artifact.artifacts).map(([key, value]) => [key, {
      archiveSha256: value.sha256,
      inventorySha256: inventorySha256(value.inventory),
      treeSha256: value.treeSha256
    }]))
  },
  failures: [],
  schemaVersion: 2,
  status: 'passed'
};

const passingReport = version => ({
  browser: {version},
  cleanup: {process: {exited: true}, profile: {removed: true}},
  crashes: [],
  extension: {treeSha256: artifact.artifacts.chromium.treeSha256, version: artifact.extensionVersion},
  ok: true,
  scenarios: scenarioNames.map(name => ({name, ok: true}))
});

const passingMinimumChromeReport = (version = '102.0.5005.40') => ({
  assertions: [
    'browser reports the exact pinned Chromium minimum',
    'Playwright reports the exact pinned minimum driver',
    'packaged module service-worker target is present',
    'extension options page exposes matching runtime identity and version',
    'storage runtime message completes a module-worker round trip'
  ].map(name => ({name, passed: true})),
  browser: {version},
  cleanup: {
    process: {
      exited: true,
      identityVerified: true,
      jobEmptyVerified: true,
      owner: 'windows-kernel-job',
      ownerExited: true,
      graceful: true,
      forced: {attempted: 0, needed: false, succeeded: 0}
    },
    profile: {removed: true}
  },
  crashes: [],
  driver: {name: 'playwright', version: '1.22.2'},
  extension: {treeSha256: artifact.artifacts.chromium.treeSha256, version: artifact.extensionVersion},
  outcome: 'passed'
});

const passingFirefoxProfile = () => ({
  crashArtifacts: 0,
  crashLocationsChecked: ['profile-minidumps', 'crash-events'],
  externalCrashState: {
    categories: {
      crashReports: {changed: 0, created: 0, removed: 0},
      pendingPings: {changed: 0, created: 0, removed: 0}
    },
    changed: 0,
    created: 0,
    removed: 0
  },
  processExit: 'graceful-exact-tree',
  processTreeCleanup: {
    exited: true,
    identityVerified: true,
    jobEmptyVerified: true,
    owner: 'windows-kernel-job',
    ownerExited: true
  },
  removed: true
});

const passingFirefoxReport = version => ({
  assertions: [
    'ordinary discard-tab settles to authoritative discarded/unloaded content state',
    'scoped discard-window runtime message reaches the real popup/worker path',
    'exact launched Firefox tree exited and isolated profile was deleted'
  ].map(name => ({name, passed: true})),
  browser: {version},
  extension: {treeSha256: artifact.artifacts.firefox.treeSha256, version: artifact.extensionVersion},
  outcome: 'passed',
  profile: passingFirefoxProfile()
});

const passingMinimumFirefoxReport = (version = '140.0') => ({
  assertions: [
    'temporary Firefox XPI install via webExtension.install',
    'Firefox 140 background page and core runtime started without privileged BiDi scope',
    'exact launched Firefox tree exited and isolated profile was deleted'
  ].map(name => ({name, passed: true})),
  browser: {version},
  extension: {
    archiveSha256: artifact.artifacts.firefox.sha256,
    idMatchedManifest: true,
    installDataType: 'archivePath',
    installed: true,
    temporary: true,
    treeSha256: artifact.artifacts.firefox.treeSha256,
    version: artifact.extensionVersion
  },
  outcome: 'passed',
  profile: passingFirefoxProfile()
});

test('canary policy matches the declared browser minimum and has the exact required channel set', async () => {
  const {manifest, policy} = await loadCanaryPolicy();
  assert.equal(policy.minimumChrome.declaredMajor, Number.parseInt(manifest.minimum_chrome_version, 10));
  assert.equal(policy.minimumChrome.engineVersion, '102.0.5005.40');
  assert.equal(policy.minimumFirefox.declaredMajor,
    Number.parseInt(manifest.browser_specific_settings.gecko.strict_min_version, 10));
  assert.equal(policy.minimumFirefox.engineVersion, '140.0');
  assert.deepEqual(policy.requiredTargets.map(target => target.id).sort(), [
    'chrome-beta', 'chrome-minimum', 'chrome-stable', 'edge-beta', 'edge-stable',
    'firefox-minimum', 'firefox-stable'
  ]);
  assert.deepEqual(Object.fromEntries(policy.requiredTargets.map(target => [target.id, target.artifact])), {
    'chrome-beta': 'chromium',
    'chrome-minimum': 'chromium',
    'chrome-stable': 'chromium',
    'edge-beta': 'chromium',
    'edge-stable': 'chromium',
    'firefox-minimum': 'firefox',
    'firefox-stable': 'firefox'
  });
  assert.deepEqual(policy.quarantines, []);
});

test('seven green records bind Chromium channels to ZIP and Firefox to XPI', async () => {
  const {policy} = await loadCanaryPolicy();
  const evidence = policy.requiredTargets.map(target => createCanaryEvidence({
    artifact,
    browser: target.browser,
    channel: target.channel,
    installedVersion: target.id === 'firefox-minimum' ? '140.0' :
      target.browser === 'firefox' ? '153.0' :
      target.channel === 'minimum' ? '102.0.5005.40' : '151.0.0.0',
    installer: `test/${target.id}`,
    policy,
    report: target.id === 'chrome-minimum' ? passingMinimumChromeReport() :
      target.id === 'firefox-minimum' ? passingMinimumFirefoxReport() :
      target.browser === 'firefox' ? passingFirefoxReport('153.0') :
      passingReport('151.0.0.0'),
    runnerImage: 'windows-test'
  }));
  const gate = verifyCanaryEvidence({artifact, evidence, policy, reproducibility});
  assert.equal(gate.status, 'passed', gate.failures.join('\n'));
  assert.equal(gate.failures.length, 0);
  assert.ok(evidence.every(item => item.gate === 'green'));
  assert.deepEqual(gate.artifacts, {
    chromium: {
      archiveSha256: hash('a'),
      inventorySha256: inventorySha256(artifact.artifacts.chromium.inventory),
      treeSha256: hash('b')
    },
    firefox: {
      archiveSha256: hash('e'),
      inventorySha256: inventorySha256(artifact.artifacts.firefox.inventory),
      treeSha256: hash('f')
    }
  });
  assert.ok(evidence.filter(item => item.browser !== 'firefox').every(item =>
    item.artifact === 'chromium' && item.archiveFile === 'canary.zip' &&
    item.treeSha256 === hash('b') && item.archiveSha256 === hash('a')));
  assert.deepEqual(evidence.find(item => item.browser === 'firefox'), {
    ...evidence.find(item => item.browser === 'firefox'),
    archiveFile: 'canary.xpi',
    archiveSha256: hash('e'),
    artifact: 'firefox',
    treeSha256: hash('f')
  });

  evidence[2] = {...evidence[2], treeSha256: hash('c')};
  const mismatch = verifyCanaryEvidence({artifact, evidence, policy, reproducibility});
  assert.equal(mismatch.status, 'failed');
  assert.ok(mismatch.failures.some(message => message.includes('different chromium tree')));

  const crossBuilderMismatch = verifyCanaryEvidence({
    artifact,
    evidence: evidence.map((item, index) => index === 2 ? {
      ...item,
      treeSha256: artifact.artifacts.chromium.treeSha256
    } : item),
    policy,
    reproducibility: {
      ...reproducibility,
      canonical: {
        ...reproducibility.canonical,
        targets: {
          ...reproducibility.canonical.targets,
          chromium: {...reproducibility.canonical.targets.chromium, archiveSha256: hash('9')}
        }
      }
    }
  });
  assert.equal(crossBuilderMismatch.status, 'failed');
  assert.ok(crossBuilderMismatch.failures.some(message => message.includes('chromium archive differs')));

  const swappedFirefox = evidence.map(item => item.target === 'firefox-stable' ? {
    ...item,
    archiveFile: artifact.artifacts.chromium.file,
    archiveSha256: artifact.artifacts.chromium.sha256,
    artifact: 'chromium',
    treeSha256: artifact.artifacts.chromium.treeSha256
  } : item);
  const swappedGate = verifyCanaryEvidence({artifact, evidence: swappedFirefox, policy, reproducibility});
  assert.equal(swappedGate.status, 'failed');
  assert.ok(swappedGate.failures.some(message => message.includes('firefox-stable references the wrong artifact family')));
});

test('Firefox stable evidence directly requires bounded external crash proof and exact Job exit', async () => {
  const {policy} = await loadCanaryPolicy();
  const evidenceFor = (report, installer) => createCanaryEvidence({
    artifact,
    browser: 'firefox',
    channel: 'stable',
    installedVersion: '153.0',
    installer,
    policy,
    report,
    runnerImage: 'windows-test'
  });
  assert.equal(evidenceFor(passingFirefoxReport('153.0'), 'test/stable-valid').status, 'passed');

  const changedExternalCrash = passingFirefoxReport('153.0');
  changedExternalCrash.profile.externalCrashState.categories.pendingPings.created = 1;
  assert.ok(evidenceFor(changedExternalCrash, 'test/stable-external-crash').failures.some(item =>
    item.kind === 'capability:crashFree'));

  const uncheckedLocation = passingFirefoxReport('153.0');
  uncheckedLocation.profile.crashLocationsChecked = ['profile-minidumps'];
  assert.ok(evidenceFor(uncheckedLocation, 'test/stable-unchecked-location').failures.some(item =>
    item.kind === 'capability:crashFree'));

  const liveOwner = passingFirefoxReport('153.0');
  liveOwner.profile.processTreeCleanup.ownerExited = false;
  assert.ok(evidenceFor(liveOwner, 'test/stable-live-owner').failures.some(item =>
    item.kind === 'capability:isolatedProfileRemoved'));
});

test('Chromium minimum evidence requires the exact 102 build and compatibility capabilities', async () => {
  const {policy} = await loadCanaryPolicy();
  const valid = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.40',
    installer: 'test',
    policy,
    report: passingMinimumChromeReport()
  });
  assert.equal(valid.status, 'passed');
  assert.equal(valid.capabilities.exactMinimumVersion, true);
  assert.equal(valid.capabilities.exactPlaywrightDriver, true);
  assert.equal(valid.capabilities.extensionPageRuntime, true);
  assert.equal(valid.capabilities.runtimeRoundTrip, true);
  assert.equal(valid.capabilities.serviceWorkerTarget, true);

  const wrongVersion = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.41',
    installer: 'test',
    policy,
    report: passingMinimumChromeReport('102.0.5005.41')
  });
  assert.equal(wrongVersion.status, 'failed');
  assert.equal(wrongVersion.gate, 'red');
  assert.ok(wrongVersion.failures.some(failure => failure.kind === 'minimum-version-mismatch'));
  assert.ok(wrongVersion.failures.some(failure => failure.kind === 'minimum-installer-version-mismatch'));

  const missingRoundTripReport = passingMinimumChromeReport();
  missingRoundTripReport.assertions = missingRoundTripReport.assertions.filter(assertion =>
    !assertion.name.includes('module-worker round trip'));
  const missingRoundTrip = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.40',
    installer: 'test',
    policy,
    report: missingRoundTripReport
  });
  assert.ok(missingRoundTrip.failures.some(failure => failure.kind === 'capability:runtimeRoundTrip'));

  const wrongDriverReport = passingMinimumChromeReport();
  wrongDriverReport.driver.version = '1.23.0';
  const wrongDriver = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.40',
    installer: 'test',
    policy,
    report: wrongDriverReport
  });
  assert.ok(wrongDriver.failures.some(failure =>
    failure.kind === 'capability:exactPlaywrightDriver'));

  const unboundCleanupReport = passingMinimumChromeReport();
  unboundCleanupReport.cleanup.process.identityVerified = false;
  const unboundCleanup = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.40',
    installer: 'test',
    policy,
    report: unboundCleanupReport
  });
  assert.ok(unboundCleanup.failures.some(failure =>
    failure.kind === 'capability:isolatedProfileRemoved'));

  for (const [field, value] of [
    ['jobEmptyVerified', false],
    ['ownerExited', false],
    ['owner', 'pid-only']
  ]) {
    const report = passingMinimumChromeReport();
    report.cleanup.process[field] = value;
    const evidence = createCanaryEvidence({
      artifact,
      browser: 'chrome',
      channel: 'minimum',
      installedVersion: '102.0.5005.40',
      installer: `test/${field}`,
      policy,
      report
    });
    assert.ok(evidence.failures.some(failure =>
      failure.kind === 'capability:isolatedProfileRemoved'), field);
  }

  const forcedCleanupReport = passingMinimumChromeReport();
  forcedCleanupReport.cleanup.process.graceful = false;
  forcedCleanupReport.cleanup.process.forced = {attempted: 1, needed: true, succeeded: 1};
  const forcedCleanup = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '102.0.5005.40',
    installer: 'test/forced-cleanup',
    policy,
    report: forcedCleanupReport
  });
  assert.ok(forcedCleanup.failures.some(failure =>
    failure.kind === 'capability:isolatedProfileRemoved'));
});

test('Firefox minimum evidence requires exact 140.0, the XPI hash, and background runtime startup', async () => {
  const {policy} = await loadCanaryPolicy();
  const valid = createCanaryEvidence({
    artifact,
    browser: 'firefox',
    channel: 'minimum',
    installedVersion: '140.0',
    installer: 'test',
    policy,
    report: passingMinimumFirefoxReport(),
    runnerImage: 'ubuntu-test'
  });
  assert.equal(valid.status, 'passed');
  assert.equal(valid.capabilities.artifactArchiveAttested, true);
  assert.equal(valid.capabilities.backgroundRuntimeStarted, true);
  assert.equal(valid.capabilities.temporaryArchiveInstall, true);

  for (const [name, report, installedVersion, failure] of [
    ['wrong browser patch', passingMinimumFirefoxReport('140.0.1'), '140.0.1', 'minimum-version-mismatch'],
    ['wrong archive', {
      ...passingMinimumFirefoxReport(),
      extension: {...passingMinimumFirefoxReport().extension, archiveSha256: hash('9')}
    }, '140.0', 'capability:artifactArchiveAttested'],
    ['missing runtime startup', {
      ...passingMinimumFirefoxReport(),
      assertions: passingMinimumFirefoxReport().assertions.filter(assertion =>
        !assertion.name.includes('background page and core runtime'))
    }, '140.0', 'capability:backgroundRuntimeStarted']
  ]) {
    const evidence = createCanaryEvidence({
      artifact,
      browser: 'firefox',
      channel: 'minimum',
      installedVersion,
      installer: `test/${name}`,
      policy,
      report
    });
    assert.equal(evidence.status, 'failed', name);
    assert.ok(evidence.failures.some(item => item.kind === failure), name);
  }

  const changedExternalCrash = passingMinimumFirefoxReport();
  changedExternalCrash.profile.externalCrashState.changed = 1;
  const crashEvidence = createCanaryEvidence({
    artifact,
    browser: 'firefox',
    channel: 'minimum',
    installedVersion: '140.0',
    installer: 'test/external-crash-change',
    policy,
    report: changedExternalCrash
  });
  assert.ok(crashEvidence.failures.some(item => item.kind === 'capability:crashFree'));

  const inconsistentCrashCounts = passingMinimumFirefoxReport();
  inconsistentCrashCounts.profile.externalCrashState.categories.pendingPings.created = 1;
  const inconsistentEvidence = createCanaryEvidence({
    artifact,
    browser: 'firefox',
    channel: 'minimum',
    installedVersion: '140.0',
    installer: 'test/inconsistent-crash-counts',
    policy,
    report: inconsistentCrashCounts
  });
  assert.ok(inconsistentEvidence.failures.some(item => item.kind === 'capability:crashFree'));

  const liveOwner = passingMinimumFirefoxReport();
  liveOwner.profile.processTreeCleanup.ownerExited = false;
  const cleanupEvidence = createCanaryEvidence({
    artifact,
    browser: 'firefox',
    channel: 'minimum',
    installedVersion: '140.0',
    installer: 'test/live-job-owner',
    policy,
    report: liveOwner
  });
  assert.ok(cleanupEvidence.failures.some(item => item.kind === 'capability:isolatedProfileRemoved'));
});

test('quarantines require an owner, future expiry, reason, and narrow failure kinds', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atd-canary-policy-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const realPolicy = JSON.parse(await readFile(new URL('../.github/browser-canary-policy.json', import.meta.url), 'utf8'));
  const manifestPath = path.join(directory, 'manifest.json');
  const policyPath = path.join(directory, 'policy.json');
  await writeFile(manifestPath, JSON.stringify({
    browser_specific_settings: {gecko: {strict_min_version: '140.0'}},
    minimum_chrome_version: '102'
  }));
  realPolicy.quarantines = [{
    expires: '2000-01-01',
    failureKinds: [],
    owner: 'nobody',
    reason: 'short',
    target: 'edge-beta'
  }];
  await writeFile(policyPath, JSON.stringify(realPolicy));
  await assert.rejects(
    loadCanaryPolicy({manifestPath, now: new Date('2026-08-12T00:00:00Z'), policyPath}),
    error => /owner must be a GitHub @handle/.test(error.message) &&
      /expired on 2000-01-01/.test(error.message) && /failureKinds/.test(error.message)
  );
});

test('workflow schedules browser channels and binds each to its target artifact', async () => {
  const workflow = (await readFile(
    new URL('../.github/workflows/browser-canaries.yml', import.meta.url),
    'utf8'
  )).replaceAll('\r\n', '\n');
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  for (const id of [
    'chrome-minimum', 'chrome-stable', 'chrome-beta', 'edge-stable', 'edge-beta',
    'firefox-minimum', 'firefox-stable'
  ]) {
    assert.match(workflow, new RegExp(`id: ${id}`));
  }
  assert.match(workflow, /playwright@1\.22\.2/);
  assert.match(workflow, /CANARY_INSTALLED_VERSION=102\.0\.5005\.40/);
  assert.match(workflow, /browser-actions\/setup-chrome@v2/);
  assert.match(workflow, /\.\/scripts\/select-edge-canary\.ps1/);
  assert.match(workflow, /EDGE_ACTION_PATH: \$\{\{ steps\.edge\.outputs\.edge-path \}\}/);
  const edgeSelection = workflow.slice(
    workflow.indexOf('name: Select Edge channel binary'),
    workflow.indexOf('name: Run popup matrix against the extracted artifact')
  );
  assert.match(edgeSelection, /-EnvironmentFile \$env:GITHUB_ENV/);
  assert.doesNotMatch(edgeSelection, /steps\.edge\.outputs\.edge-version/);
  assert.match(workflow, /name: \$\{\{ env\.CANARY_ARTIFACT_NAME \}\}/);
  assert.match(workflow, /package-linux:/);
  assert.match(workflow, /package-windows:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /clean: true/);
  assert.match(workflow, /persist-credentials: false/);

  const packageLinux = workflow.slice(
    workflow.indexOf('\n  package-linux:'),
    workflow.indexOf('\n  package-windows:')
  );
  const checkoutIndex = packageLinux.indexOf('uses: actions/checkout@');
  const baselineIndex = packageLinux.indexOf(
    'name: Fetch and verify the immutable v0.6.9.1 upgrade baseline'
  );
  const unitIndex = packageLinux.indexOf('name: Unit and model tests');
  const buildIndex = packageLinux.indexOf(
    'name: Build the canonical canary artifact from a clean Linux checkout'
  );
  assert.ok(checkoutIndex >= 0 && baselineIndex > checkoutIndex &&
    unitIndex > baselineIndex && buildIndex > unitIndex);

  const baselineStep = packageLinux.slice(baselineIndex, unitIndex);
  assert.match(baselineStep, /git fetch --no-tags --depth=1 \\\n\s+https:\/\/github\.com\/rNeomy\/auto-tab-discard\.git \\\n\s+refs\/tags\/v0\.6\.9\.1:refs\/tags\/v0\.6\.9\.1/);
  assert.match(baselineStep,
    /git rev-parse --verify 'refs\/tags\/v0\.6\.9\.1\^\{tag\}'\)" = \\\n\s+'a76dd7a40307703796a5fa9cf40ea605eaf69b52'/);
  assert.match(baselineStep,
    /git rev-parse --verify 'refs\/tags\/v0\.6\.9\.1\^\{commit\}'\)" = \\\n\s+'f26fa353bd4b624d98fc92a4eb33ab54bd381376'/);
  assert.doesNotMatch(baselineStep, /(?:^|\s)(?:--force|-f)(?:\s|\\|$)/m);
  assert.doesNotMatch(baselineStep, /(?:^|\s)\+refs\/tags\//m);
  assert.match(packageLinux,
    /name: Unit and model tests\s+run: node --test --test-concurrency=1 tests\/\*\.test\.mjs/);

  assert.match(workflow, /artifact-reproducibility-gate:/);
  assert.match(workflow, /cross-builder-provenance\.mjs verify/);
  assert.match(workflow, /--builder-dir build\/repro\/linux/);
  assert.match(workflow, /--builder-dir build\/repro\/windows/);
  assert.match(workflow, /--canonical-builder linux/);
  assert.match(workflow, /browser-canary-gate:/);
  assert.match(workflow, /browser-canary-policy\.mjs verify/);
  assert.match(workflow, /--reproducibility-gate build\/canary\/reproducibility\/cross-builder-gate\.json/);
  assert.match(workflow,
    /needs: \[package-linux, package-windows, artifact-reproducibility-gate, browser-canary\]/);

  const browserJob = workflow.slice(
    workflow.indexOf('\n  browser-canary:'),
    workflow.indexOf('\n  browser-canary-gate:')
  );
  assert.match(browserJob, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.equal((browserJob.match(/uses: actions\/setup-node@/g) || []).length, 1);
  assert.match(browserJob,
    /node-version: \$\{\{ matrix\.id == 'chrome-minimum' && '16\.20\.2' \|\| '24' \}\}/);
  const targetRows = [...browserJob.matchAll(
    /- id: (chrome-minimum|chrome-stable|chrome-beta|edge-stable|edge-beta|firefox-minimum|firefox-stable)\n\s+artifact: (chromium|firefox)\n\s+browser: (chrome|edge|firefox)\n\s+channel: (minimum|stable|beta)\n\s+runner: (ubuntu-latest|windows-2022|windows-latest)/g
  )];
  assert.deepEqual(targetRows.map(match => match[1]), [
    'chrome-minimum', 'chrome-stable', 'chrome-beta', 'edge-stable', 'edge-beta',
    'firefox-minimum', 'firefox-stable'
  ]);
  assert.deepEqual(Object.fromEntries(targetRows.map(match => [match[1], {
    artifact: match[2],
    browser: match[3],
    runner: match[5]
  }])), {
    'chrome-beta': {artifact: 'chromium', browser: 'chrome', runner: 'windows-latest'},
    'chrome-minimum': {artifact: 'chromium', browser: 'chrome', runner: 'windows-2022'},
    'chrome-stable': {artifact: 'chromium', browser: 'chrome', runner: 'windows-latest'},
    'edge-beta': {artifact: 'chromium', browser: 'edge', runner: 'windows-latest'},
    'edge-stable': {artifact: 'chromium', browser: 'edge', runner: 'windows-latest'},
    'firefox-minimum': {artifact: 'firefox', browser: 'firefox', runner: 'windows-2022'},
    'firefox-stable': {artifact: 'firefox', browser: 'firefox', runner: 'windows-latest'}
  });
  const popupMatrixStep = browserJob.slice(
    browserJob.indexOf('name: Run popup matrix against the extracted artifact'),
    browserJob.indexOf('name: Upload sanitized popup-matrix diagnostics')
  );
  assert.doesNotMatch(popupMatrixStep, /--playwright-managed-launch/);
  assert.match(popupMatrixStep, /if: matrix\.browser != 'firefox' && matrix\.id != 'chrome-minimum'/);
  const chromiumMinimum = browserJob.slice(
    browserJob.indexOf('name: Run Chromium minimum compatibility smoke against the exact ZIP tree'),
    browserJob.indexOf('name: Run popup matrix against the extracted artifact')
  );
  assert.match(chromiumMinimum, /if: matrix\.id == 'chrome-minimum'/);
  assert.match(chromiumMinimum, /e2e\/chromium-minimum-smoke\.cjs/);
  assert.match(chromiumMinimum, /--expected-version 102\.0\.5005\.40/);
  assert.match(chromiumMinimum, /--expected-playwright-version 1\.22\.2/);
  assert.match(chromiumMinimum, /--extension \(Resolve-Path build\/canary\/extracted\)/);
  assert.match(chromiumMinimum, /--results-root \(Resolve-Path build\/canary\/raw\)/);

  const extractionStep = browserJob.slice(
    browserJob.indexOf('name: Extract the attested extension archive'),
    browserJob.indexOf('name: Install current Playwright driver')
  );
  assert.match(extractionStep, /if \('\$\{\{ matrix\.artifact \}\}' -eq 'firefox'\)/);
  assert.match(extractionStep, /auto-tab-discard-canary\.xpi/);
  assert.match(extractionStep, /auto-tab-discard-canary\.zip/);
  assert.match(extractionStep, /System\.IO\.Compression\.ZipFile/);
  const firefoxMinimum = browserJob.slice(
    browserJob.indexOf('uses: browser-actions/setup-firefox@'),
    browserJob.indexOf('name: Select preinstalled Firefox Stable binary')
  );
  assert.match(firefoxMinimum,
    /browser-actions\/setup-firefox@0bc507ddf224827e3b1af68e014d5e42ab93e795/);
  assert.match(firefoxMinimum, /firefox-version: '140\.0'/);
  assert.match(firefoxMinimum, /& \$executable --version/);
  assert.match(firefoxMinimum, /\$version -ne '140\.0'/);
  const firefoxStep = browserJob.slice(
    browserJob.indexOf('name: Select preinstalled Firefox Stable binary'),
    browserJob.indexOf('name: Upload sanitized popup-matrix diagnostics')
  );
  assert.match(firefoxStep, /github-hosted-runner-image-preinstalled-firefox/);
  assert.match(firefoxStep, /e2e\/firefox-bidi-smoke\.cjs/);
  assert.match(firefoxStep, /'--extension', \(Resolve-Path build\/canary\/extracted\)/);
  assert.match(firefoxStep, /'--results-root', \(Resolve-Path build\/canary\/raw\)/);
  assert.match(firefoxStep, /--minimum-startup-only/);
  assert.match(firefoxStep, /--expected-version', '140\.0'/);
  assert.match(firefoxStep, /--archive', \(Resolve-Path build\/canary\/auto-tab-discard-canary\.xpi\)/);

  const minimumStep = browserJob.indexOf(
    'name: Run Chromium minimum compatibility smoke against the exact ZIP tree');
  const matrixStep = browserJob.indexOf('name: Run popup matrix against the extracted artifact');
  const diagnosticsStep = browserJob.indexOf('name: Upload sanitized popup-matrix diagnostics');
  const attestationStep = browserJob.indexOf('name: Attest browser version, capabilities, and target artifact hashes');
  assert.ok(minimumStep >= 0 && matrixStep > minimumStep && diagnosticsStep > matrixStep &&
    attestationStep > diagnosticsStep);
  const diagnostics = browserJob.slice(diagnosticsStep, attestationStep);
  assert.match(diagnostics,
    /if: steps\.chromium_minimum_smoke\.outcome == 'failure' \|\| steps\.chromium_matrix\.outcome == 'failure' \|\| steps\.firefox_smoke\.outcome == 'failure'/);
  assert.match(diagnostics,
    /name: popup-matrix-diagnostics-\$\{\{ matrix\.id \}\}-\$\{\{ github\.sha \}\}/);
  assert.match(diagnostics, /path: build\/canary\/raw\/\*\.json/);
  assert.match(diagnostics, /if-no-files-found: error/);
  assert.doesNotMatch(diagnostics, /canary-evidence/);
  assert.match(workflow, /pattern: canary-evidence-\*-\$\{\{ github\.sha \}\}/);
});
