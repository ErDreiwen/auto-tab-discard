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
  archives: [
    {bytes: 100, file: 'canary.xpi', sha256: hash('a')},
    {bytes: 100, file: 'canary.zip', sha256: hash('a')}
  ],
  entryCount: 1,
  extensionVersion: '0.6.9.2',
  formatVersion: 3,
  inventory: [{bytes: 42, path: 'manifest.json', sha256: hash('d')}],
  sourceTreeSha256: hash('b')
};

const reproducibility = {
  builders: [
    {id: 'linux', runnerImage: 'ubuntu-test', runnerOs: 'Linux'},
    {id: 'windows', runnerImage: 'windows-test', runnerOs: 'Windows'}
  ],
  canonical: {
    archiveSha256: hash('a'),
    builderId: 'linux',
    commitSha: 'a'.repeat(40),
    extensionVersion: artifact.extensionVersion,
    gitTree: 'b'.repeat(40),
    inventorySha256: inventorySha256(artifact.inventory),
    sourceTreeSha256: artifact.sourceTreeSha256
  },
  failures: [],
  schemaVersion: 1,
  status: 'passed'
};

const passingReport = version => ({
  browser: {version},
  cleanup: {process: {exited: true}, profile: {removed: true}},
  crashes: [],
  extension: {treeSha256: artifact.sourceTreeSha256, version: artifact.extensionVersion},
  ok: true,
  scenarios: scenarioNames.map(name => ({name, ok: true}))
});

test('canary policy matches the declared browser minimum and has the exact required channel set', async () => {
  const {manifest, policy} = await loadCanaryPolicy();
  assert.equal(policy.minimumChrome.declaredMajor, Number.parseInt(manifest.minimum_chrome_version, 10));
  assert.equal(policy.minimumChrome.engineVersion, '102.0.5005.40');
  assert.deepEqual(policy.requiredTargets.map(target => target.id).sort(), [
    'chrome-beta', 'chrome-minimum', 'chrome-stable', 'edge-beta', 'edge-stable'
  ]);
  assert.deepEqual(policy.quarantines, []);
});

test('five green records must attest one exact artifact tree and archive', async () => {
  const {policy} = await loadCanaryPolicy();
  const evidence = policy.requiredTargets.map(target => createCanaryEvidence({
    artifact,
    browser: target.browser,
    channel: target.channel,
    installedVersion: target.channel === 'minimum' ? '102.0.5005.40' : '151.0.0.0',
    installer: `test/${target.id}`,
    policy,
    report: passingReport(target.channel === 'minimum' ? '102.0.5005.40' : '151.0.0.0'),
    runnerImage: 'windows-test'
  }));
  const gate = verifyCanaryEvidence({artifact, evidence, policy, reproducibility});
  assert.equal(gate.status, 'passed');
  assert.equal(gate.failures.length, 0);
  assert.ok(evidence.every(item => item.gate === 'green'));
  assert.ok(evidence.every(item => item.sourceTreeSha256 === artifact.sourceTreeSha256));
  assert.ok(evidence.every(item => item.archiveSha256 === hash('a')));

  evidence[2] = {...evidence[2], sourceTreeSha256: hash('c')};
  const mismatch = verifyCanaryEvidence({artifact, evidence, policy, reproducibility});
  assert.equal(mismatch.status, 'failed');
  assert.ok(mismatch.failures.some(message => message.includes('different source tree')));

  const crossBuilderMismatch = verifyCanaryEvidence({
    artifact,
    evidence: evidence.map((item, index) => index === 2 ? {...item, sourceTreeSha256: artifact.sourceTreeSha256} : item),
    policy,
    reproducibility: {
      ...reproducibility,
      canonical: {...reproducibility.canonical, archiveSha256: hash('e')}
    }
  });
  assert.equal(crossBuilderMismatch.status, 'failed');
  assert.ok(crossBuilderMismatch.failures.some(message => message.includes('cross-builder canonical archive')));
});

test('minimum evidence fails closed when the observed browser is not the declared major', async () => {
  const {policy} = await loadCanaryPolicy();
  const evidence = createCanaryEvidence({
    artifact,
    browser: 'chrome',
    channel: 'minimum',
    installedVersion: '151.0.0.0',
    installer: 'test',
    policy,
    report: passingReport('151.0.0.0')
  });
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.gate, 'red');
  assert.ok(evidence.failures.some(failure => failure.kind === 'minimum-version-mismatch'));
});

test('quarantines require an owner, future expiry, reason, and narrow failure kinds', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atd-canary-policy-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const realPolicy = JSON.parse(await readFile(new URL('../.github/browser-canary-policy.json', import.meta.url), 'utf8'));
  const manifestPath = path.join(directory, 'manifest.json');
  const policyPath = path.join(directory, 'policy.json');
  await writeFile(manifestPath, JSON.stringify({minimum_chrome_version: '102'}));
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

test('workflow schedules Stable/Beta channels, the declared minimum, and a same-artifact gate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/browser-canaries.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  for (const id of ['chrome-minimum', 'chrome-stable', 'chrome-beta', 'edge-stable', 'edge-beta']) {
    assert.match(workflow, new RegExp(`id: ${id}`));
  }
  assert.match(workflow, /playwright@1\.22\.2/);
  assert.match(workflow, /CANARY_INSTALLED_VERSION=102\.0\.5005\.40/);
  assert.match(workflow, /browser-actions\/setup-chrome@v2/);
  assert.match(workflow, /browser-actions\/setup-edge@v1/);
  assert.match(workflow, /name: \$\{\{ env\.CANARY_ARTIFACT_NAME \}\}/);
  assert.match(workflow, /package-linux:/);
  assert.match(workflow, /package-windows:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /clean: true/);
  assert.match(workflow, /persist-credentials: false/);
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
});
