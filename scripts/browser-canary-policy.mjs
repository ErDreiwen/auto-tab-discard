#!/usr/bin/env node

import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {inventorySha256} from './cross-builder-provenance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_POLICY = path.join(repositoryRoot, '.github', 'browser-canary-policy.json');
const DEFAULT_MANIFEST = path.join(repositoryRoot, 'v3', 'manifest.json');
const SHA256 = /^[a-f\d]{64}$/;
const TARGET_ID = /^(?:(?:chrome|edge)-(?:minimum|stable|beta)|firefox-(?:minimum|stable))$/;
const ARTIFACT_KEYS = Object.freeze(['chromium', 'firefox']);
const OWNER = /^@[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const parseJson = async (file, label = file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  }
  catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, {cause: error});
  }
};

const targetKey = ({browser, channel}) => `${browser}-${channel}`;
const major = version => Number.parseInt(String(version || '').match(/\d+/)?.[0] || '', 10);
const dateValue = value => Date.parse(`${value}T23:59:59.999Z`);

const validatePolicy = (policy, manifest, now = new Date()) => {
  const errors = [];
  if (policy?.schemaVersion !== 2) {
    errors.push('policy schemaVersion must be 2');
  }
  if (!Array.isArray(policy?.requiredCapabilities) || policy.requiredCapabilities.length === 0 ||
      policy.requiredCapabilities.some(item => typeof item !== 'string' || !item)) {
    errors.push('requiredCapabilities must be a non-empty string array');
  }
  if (!Array.isArray(policy?.requiredFirefoxCapabilities) ||
      policy.requiredFirefoxCapabilities.length === 0 ||
      policy.requiredFirefoxCapabilities.some(item => typeof item !== 'string' || !item)) {
    errors.push('requiredFirefoxCapabilities must be a non-empty string array');
  }
  if (!Array.isArray(policy?.requiredMinimumChromeCapabilities) ||
      policy.requiredMinimumChromeCapabilities.length === 0 ||
      policy.requiredMinimumChromeCapabilities.some(item => typeof item !== 'string' || !item)) {
    errors.push('requiredMinimumChromeCapabilities must be a non-empty string array');
  }
  if (!Array.isArray(policy?.requiredMinimumFirefoxCapabilities) ||
      policy.requiredMinimumFirefoxCapabilities.length === 0 ||
      policy.requiredMinimumFirefoxCapabilities.some(item => typeof item !== 'string' || !item)) {
    errors.push('requiredMinimumFirefoxCapabilities must be a non-empty string array');
  }
  const targets = Array.isArray(policy?.requiredTargets) ? policy.requiredTargets : [];
  if (targets.length !== 7) {
    errors.push('the canary gate requires exactly seven targets');
  }
  const expected = new Map([
    ['chrome-minimum', 'chromium'],
    ['chrome-stable', 'chromium'],
    ['chrome-beta', 'chromium'],
    ['edge-stable', 'chromium'],
    ['edge-beta', 'chromium'],
    ['firefox-minimum', 'firefox'],
    ['firefox-stable', 'firefox']
  ]);
  for (const target of targets) {
    if (!target || target.id !== targetKey(target) || !TARGET_ID.test(target.id)) {
      errors.push(`invalid required target: ${JSON.stringify(target)}`);
    }
    else if (target.artifact !== expected.get(target.id)) {
      errors.push(`${target.id} must consume the ${expected.get(target.id)} artifact`);
    }
    expected.delete(target?.id);
  }
  if (new Set(targets.map(target => target?.id)).size !== targets.length) {
    errors.push('required target IDs must be unique');
  }
  if (expected.size) {
    errors.push(`missing required targets: ${[...expected.keys()].sort().join(', ')}`);
  }

  const declaredMajor = Number.parseInt(manifest?.minimum_chrome_version, 10);
  if (!Number.isInteger(declaredMajor)) {
    errors.push('manifest minimum_chrome_version must declare a numeric major');
  }
  if (policy?.minimumChrome?.declaredMajor !== declaredMajor) {
    errors.push(`minimum canary ${policy?.minimumChrome?.declaredMajor} does not match manifest minimum ${declaredMajor}`);
  }
  if (policy?.minimumChrome?.target !== 'chrome-minimum') {
    errors.push('minimumChrome.target must be chrome-minimum');
  }
  if (major(policy?.minimumChrome?.engineVersion) !== declaredMajor) {
    errors.push('minimumChrome.engineVersion must exercise the declared browser major');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(policy?.minimumChrome?.playwrightVersion || ''))) {
    errors.push('minimumChrome.playwrightVersion must be an exact three-part version');
  }

  const firefoxMinimum = String(manifest?.browser_specific_settings?.gecko?.strict_min_version || '');
  const firefoxDeclaredMajor = major(firefoxMinimum);
  if (!/^\d+\.\d+$/.test(firefoxMinimum)) {
    errors.push('manifest Firefox strict_min_version must declare an exact two-part version');
  }
  if (policy?.minimumFirefox?.declaredMajor !== firefoxDeclaredMajor) {
    errors.push(`Firefox minimum canary ${policy?.minimumFirefox?.declaredMajor} does not match manifest minimum ${firefoxDeclaredMajor}`);
  }
  if (policy?.minimumFirefox?.target !== 'firefox-minimum') {
    errors.push('minimumFirefox.target must be firefox-minimum');
  }
  if (policy?.minimumFirefox?.engineVersion !== firefoxMinimum) {
    errors.push('minimumFirefox.engineVersion must exactly exercise Firefox strict_min_version');
  }

  const targetIds = new Set(targets.map(target => target?.id));
  const quarantines = Array.isArray(policy?.quarantines) ? policy.quarantines : [];
  const quarantineTargets = new Set();
  for (const [index, quarantine] of quarantines.entries()) {
    const prefix = `quarantine[${index}]`;
    if (!targetIds.has(quarantine?.target)) {
      errors.push(`${prefix}.target must identify one required target`);
    }
    if (quarantineTargets.has(quarantine?.target)) {
      errors.push(`${prefix}.target duplicates another quarantine`);
    }
    quarantineTargets.add(quarantine?.target);
    if (!OWNER.test(String(quarantine?.owner || ''))) {
      errors.push(`${prefix}.owner must be a GitHub @handle`);
    }
    if (!ISO_DATE.test(String(quarantine?.expires || '')) || !Number.isFinite(dateValue(quarantine.expires))) {
      errors.push(`${prefix}.expires must be a real YYYY-MM-DD date`);
    }
    else if (dateValue(quarantine.expires) < now.getTime()) {
      errors.push(`${prefix} expired on ${quarantine.expires}`);
    }
    if (typeof quarantine?.reason !== 'string' || quarantine.reason.trim().length < 10) {
      errors.push(`${prefix}.reason must explain the quarantine`);
    }
    if (!Array.isArray(quarantine?.failureKinds) || quarantine.failureKinds.length === 0 ||
        quarantine.failureKinds.some(item => typeof item !== 'string' || !item)) {
      errors.push(`${prefix}.failureKinds must narrowly list one or more accepted failures`);
    }
  }
  if (errors.length) {
    throw new Error(`Invalid browser canary policy:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
  return policy;
};

export const loadCanaryPolicy = async ({
  manifestPath = DEFAULT_MANIFEST,
  now,
  policyPath = DEFAULT_POLICY
} = {}) => {
  const [manifest, policy] = await Promise.all([
    parseJson(path.resolve(manifestPath), 'extension manifest'),
    parseJson(path.resolve(policyPath), 'browser canary policy')
  ]);
  validatePolicy(policy, manifest, now);
  return {manifest, policy};
};

const scenarioPassed = (report, name) => report?.scenarios?.some(scenario =>
  scenario?.name === name && scenario?.ok === true);

export const deriveCanaryCapabilities = (report, expectedTreeSha256) => {
  const discardScenarios = [
    'discard-tab',
    'discard-tree-ungrouped',
    'discard-tree-normal-takeover',
    'discard-tree-shift-takeover',
    'discard-window-normal-and-fresh-shift',
    'discard-rights-normal-and-fresh-shift',
    'discard-lefts-normal-and-fresh-shift',
    'discard-other-windows-normal-and-fresh-shift',
    'discard-tabs-normal-and-fresh-shift'
  ];
  const releaseScenarios = [
    'release-window', 'release-rights', 'release-lefts', 'release-other-windows', 'release-tabs'
  ];
  const processExited = report?.cleanup?.process?.exited === true;
  return {
    artifactTreeAttested: report?.extension?.treeSha256 === expectedTreeSha256,
    crashFree: Array.isArray(report?.crashes) && report.crashes.length === 0,
    externalTakeover: scenarioPassed(report, 'discard-tree-normal-takeover'),
    freshShiftOverride: [
      'discard-window-normal-and-fresh-shift',
      'discard-rights-normal-and-fresh-shift',
      'discard-lefts-normal-and-fresh-shift',
      'discard-other-windows-normal-and-fresh-shift',
      'discard-tabs-normal-and-fresh-shift'
    ].every(name => scenarioPassed(report, name)),
    isolatedProfileRemoved: report?.cleanup?.profile?.removed === true && processExited,
    popupDiscardMatrix: discardScenarios.every(name => scenarioPassed(report, name)),
    popupReleaseMatrix: releaseScenarios.every(name => scenarioPassed(report, name)),
    replacementLineage: scenarioPassed(report, 'edge-replacement-lineage-observation'),
    versionReported: typeof report?.browser?.version === 'string' && report.browser.version.length > 0
  };
};

const minimumChromeAssertionPassed = (report, name) => report?.assertions?.some(assertion =>
  assertion?.name === name && assertion?.passed === true);

const exactWindowsJobExited = cleanup => cleanup?.owner === 'windows-kernel-job' &&
  cleanup?.exited === true && cleanup?.identityVerified === true &&
  cleanup?.jobEmptyVerified === true && cleanup?.ownerExited === true;

export const deriveMinimumChromeCapabilities = (
  report,
  expectedTreeSha256,
  expectedPlaywrightVersion
) => ({
  artifactTreeAttested: report?.extension?.treeSha256 === expectedTreeSha256,
  crashFree: Array.isArray(report?.crashes) && report.crashes.length === 0,
  exactMinimumVersion: minimumChromeAssertionPassed(
    report, 'browser reports the exact pinned Chromium minimum'),
  exactPlaywrightDriver: report?.driver?.version === expectedPlaywrightVersion &&
    minimumChromeAssertionPassed(report, 'Playwright reports the exact pinned minimum driver'),
  extensionPageRuntime: minimumChromeAssertionPassed(
    report, 'extension options page exposes matching runtime identity and version'),
  isolatedProfileRemoved: report?.cleanup?.profile?.removed === true &&
    exactWindowsJobExited(report?.cleanup?.process) && report?.cleanup?.process?.graceful === true &&
    report?.cleanup?.process?.forced?.needed === false,
  optionalFramePermissionDefaultOff: minimumChromeAssertionPassed(
    report, 'frame enumeration remains an ungranted optional permission at Chromium minimum'),
  runtimeRoundTrip: minimumChromeAssertionPassed(
    report, 'storage runtime message completes a module-worker round trip'),
  serviceWorkerTarget: minimumChromeAssertionPassed(
    report, 'packaged module service-worker target is present'),
  versionReported: typeof report?.browser?.version === 'string' && report.browser.version.length > 0
});

const firefoxAssertionPassed = (report, name) => report?.assertions?.some(assertion =>
  assertion?.name === name && assertion?.passed === true);

const exactMinimumFirefoxCrashEvidence = profile => profile?.crashArtifacts === 0 &&
  JSON.stringify(profile?.crashLocationsChecked) === JSON.stringify(['profile-minidumps', 'crash-events']) &&
  profile?.externalCrashState?.changed === 0 && profile?.externalCrashState?.created === 0 &&
  profile?.externalCrashState?.removed === 0 &&
  ['crashReports', 'pendingPings'].every(category =>
    profile?.externalCrashState?.categories?.[category]?.changed === 0 &&
    profile?.externalCrashState?.categories?.[category]?.created === 0 &&
    profile?.externalCrashState?.categories?.[category]?.removed === 0);

export const deriveFirefoxCapabilities = (report, expectedTreeSha256) => ({
  artifactTreeAttested: report?.extension?.treeSha256 === expectedTreeSha256,
  crashFree: exactMinimumFirefoxCrashEvidence(report?.profile),
  isolatedProfileRemoved: report?.profile?.removed === true &&
    exactWindowsJobExited(report?.profile?.processTreeCleanup) && firefoxAssertionPassed(
      report, 'exact launched Firefox tree exited and isolated profile was deleted'),
  ordinaryDiscard: firefoxAssertionPassed(
    report, 'ordinary discard-tab settles to authoritative discarded/unloaded content state'),
  scopedDiscard: firefoxAssertionPassed(
    report, 'scoped discard-window runtime message reaches the real popup/worker path'),
  versionReported: typeof report?.browser?.version === 'string' && report.browser.version.length > 0
});

export const deriveMinimumFirefoxCapabilities = (
  report,
  expectedTreeSha256,
  expectedArchiveSha256
) => ({
  artifactArchiveAttested: report?.extension?.archiveSha256 === expectedArchiveSha256,
  artifactTreeAttested: report?.extension?.treeSha256 === expectedTreeSha256,
  backgroundRuntimeStarted: firefoxAssertionPassed(
    report, 'Firefox 140 background page and core runtime started without privileged BiDi scope'),
  crashFree: exactMinimumFirefoxCrashEvidence(report?.profile),
  isolatedProfileRemoved: report?.profile?.removed === true &&
    exactWindowsJobExited(report?.profile?.processTreeCleanup) && firefoxAssertionPassed(
      report, 'exact launched Firefox tree exited and isolated profile was deleted'),
  optionalFramePermissionDefaultOff: firefoxAssertionPassed(
    report, 'frame enumeration remains an ungranted optional permission at Firefox minimum'),
  temporaryArchiveInstall: report?.extension?.temporary === true &&
    report?.extension?.installed === true && report?.extension?.idMatchedManifest === true &&
    report?.extension?.installDataType === 'archivePath' && firefoxAssertionPassed(
      report, 'temporary Firefox XPI install via webExtension.install'),
  versionReported: typeof report?.browser?.version === 'string' && report.browser.version.length > 0
});

const artifactVariant = (artifact, key) => {
  if (artifact?.formatVersion !== 4 || !artifact?.artifacts ||
      Object.keys(artifact.artifacts).sort().join(',') !== [...ARTIFACT_KEYS].sort().join(',')) {
    throw new Error('canary artifact metadata must use format 4 and describe chromium and firefox artifacts');
  }
  const value = artifact.artifacts[key];
  const expectedExtension = key === 'chromium' ? '.zip' : '.xpi';
  if (!value || path.posix.extname(value.file || '').toLowerCase() !== expectedExtension ||
      path.posix.basename(value.file || '') !== value.file || !SHA256.test(value.sha256 || '') ||
      !SHA256.test(value.treeSha256 || '') || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      !Number.isSafeInteger(value.entryCount) || value.entryCount <= 0 ||
      !Array.isArray(value.inventory) || value.inventory.length !== value.entryCount) {
    throw new Error(`canary ${key} artifact metadata is invalid`);
  }
  inventorySha256(value.inventory);
  return value;
};

const requiredCapabilities = (policy, target) => target.id === 'chrome-minimum' ?
  policy.requiredMinimumChromeCapabilities : target.id === 'firefox-minimum' ?
    policy.requiredMinimumFirefoxCapabilities : target.browser === 'firefox' ?
      policy.requiredFirefoxCapabilities : policy.requiredCapabilities;

const matchingQuarantine = (policy, target, failures) => policy.quarantines.find(candidate =>
  candidate.target === target && failures.every(failure => candidate.failureKinds.includes(failure.kind)));

export const createCanaryEvidence = ({
  artifact,
  browser,
  channel,
  installedVersion,
  installer,
  policy,
  report,
  runnerImage
}) => {
  const target = `${browser}-${channel}`;
  const targetPolicy = policy.requiredTargets.find(candidate => candidate.id === target);
  if (!targetPolicy) {
    throw new Error(`Unexpected canary target: ${target}`);
  }
  const selectedArtifact = artifactVariant(artifact, targetPolicy.artifact);
  const expectedTreeSha256 = selectedArtifact.treeSha256;
  const capabilities = target === 'chrome-minimum' ? deriveMinimumChromeCapabilities(
    report, expectedTreeSha256, policy.minimumChrome.playwrightVersion
  ) : target === 'firefox-minimum' ? deriveMinimumFirefoxCapabilities(
    report, expectedTreeSha256, selectedArtifact.sha256
  ) : browser === 'firefox' ? deriveFirefoxCapabilities(report, expectedTreeSha256) :
    deriveCanaryCapabilities(report, expectedTreeSha256);
  const failures = [];
  const compatibilitySmoke = target === 'chrome-minimum' || target === 'firefox-minimum';
  if ((browser === 'firefox' || compatibilitySmoke ? report?.outcome !== 'passed' : report?.ok !== true)) {
    failures.push({
      kind: browser === 'firefox' || compatibilitySmoke ? 'smoke-failed' : 'matrix-failed',
      detail: report?.error?.message || (typeof report?.error === 'string' ? report.error : undefined) ||
        (target === 'chrome-minimum' ? 'Chromium minimum compatibility smoke did not pass' :
          browser === 'firefox' ? 'Firefox BiDi smoke did not pass' : 'popup matrix did not pass')
    });
  }
  for (const capability of requiredCapabilities(policy, targetPolicy)) {
    if (capabilities[capability] !== true) {
      failures.push({kind: `capability:${capability}`, detail: `${capability} was not proven`});
    }
  }
  if (report?.extension?.version !== artifact?.extensionVersion) {
    failures.push({
      kind: 'extension-version-mismatch',
      detail: 'reported extension version does not match the canary artifact'
    });
  }
  const reportedVersion = report?.browser?.version || '';
  if (installedVersion && major(installedVersion) !== major(reportedVersion)) {
    failures.push({kind: 'version-mismatch', detail: `installer reported ${installedVersion}; browser reported ${reportedVersion}`});
  }
  const expectedMinimum = browser === 'firefox' ? policy.minimumFirefox : policy.minimumChrome;
  if (channel === 'minimum' && reportedVersion !== expectedMinimum.engineVersion) {
    failures.push({
      kind: 'minimum-version-mismatch',
      detail: `expected exact ${browser === 'firefox' ? 'Firefox' : 'Chromium'} ` +
        `${expectedMinimum.engineVersion}; received ${reportedVersion || 'none'}`
    });
  }
  if (target === 'chrome-minimum' && installedVersion !== policy.minimumChrome.engineVersion) {
    failures.push({
      kind: 'minimum-installer-version-mismatch',
      detail: `expected installer Chromium ${policy.minimumChrome.engineVersion}; received ${installedVersion || 'none'}`
    });
  }
  if (target === 'firefox-minimum' && installedVersion !== policy.minimumFirefox.engineVersion) {
    failures.push({
      kind: 'minimum-installer-version-mismatch',
      detail: `expected installer Firefox ${policy.minimumFirefox.engineVersion}; received ${installedVersion || 'none'}`
    });
  }
  const quarantine = failures.length ? matchingQuarantine(policy, target, failures) : undefined;
  return {
    archiveFile: selectedArtifact.file,
    archiveSha256: selectedArtifact.sha256,
    artifact: targetPolicy.artifact,
    browser,
    capabilities,
    channel,
    extensionVersion: report?.extension?.version || null,
    failures,
    gate: failures.length && !quarantine ? 'red' : 'green',
    installer: {
      name: installer || 'unspecified',
      requestedChannel: channel,
      reportedVersion: installedVersion || null
    },
    quarantine: quarantine ? {
      expires: quarantine.expires,
      failureKinds: quarantine.failureKinds,
      owner: quarantine.owner,
      reason: quarantine.reason
    } : null,
    runnerImage: runnerImage || null,
    schemaVersion: 2,
    treeSha256: expectedTreeSha256,
    status: failures.length ? (quarantine ? 'quarantined' : 'failed') : 'passed',
    target,
    testedVersion: reportedVersion
  };
};

export const verifyCanaryEvidence = ({artifact, evidence, policy, reproducibility}) => {
  const failures = [];
  const byTarget = new Map();
  const declaredTargets = new Set(policy.requiredTargets.map(target => target.id));
  for (const item of evidence) {
    if (byTarget.has(item?.target)) {
      failures.push(`duplicate evidence for ${item?.target}`);
    }
    else if (!declaredTargets.has(item?.target)) {
      failures.push(`unexpected evidence for ${item?.target || '(unknown)'}`);
    }
    else {
      byTarget.set(item?.target, item);
    }
  }
  const expectedArtifacts = Object.fromEntries(ARTIFACT_KEYS.map(key => {
    const value = artifactVariant(artifact, key);
    return [key, {
      archiveFile: value.file,
      archiveSha256: value.sha256,
      inventorySha256: inventorySha256(value.inventory),
      sourceTreeSha256: value.treeSha256
    }];
  }));
  if (reproducibility?.schemaVersion !== 2 || reproducibility?.status !== 'passed' ||
      reproducibility?.failures?.length !== 0) {
    failures.push('independent Linux/Windows reproducibility gate is not passed');
  }
  if (reproducibility?.canonical?.builderId !== 'linux') {
    failures.push('browser-tested artifacts are not from the canonical Linux builder');
  }
  for (const key of ARTIFACT_KEYS) {
    const expected = expectedArtifacts[key];
    const canonical = reproducibility?.canonical?.targets?.[key];
    if (canonical?.archiveSha256 !== expected.archiveSha256) {
      failures.push(`browser-tested ${key} archive differs from the cross-builder canonical archive`);
    }
    if (canonical?.treeSha256 !== expected.sourceTreeSha256) {
      failures.push(`browser-tested ${key} tree differs from the cross-builder canonical tree`);
    }
    if (canonical?.inventorySha256 !== expected.inventorySha256) {
      failures.push(`browser-tested ${key} inventory differs from the cross-builder canonical inventory`);
    }
  }
  if (reproducibility?.canonical?.extensionVersion !== artifact?.extensionVersion) {
    failures.push('browser-tested version differs from the cross-builder canonical version');
  }
  for (const target of policy.requiredTargets) {
    const item = byTarget.get(target.id);
    if (!item) {
      failures.push(`missing evidence for ${target.id}`);
      continue;
    }
    const expected = expectedArtifacts[target.artifact];
    if (item.schemaVersion !== 2) {
      failures.push(`${target.id} evidence schema is not version 2`);
    }
    if (item.gate !== 'green' || !['passed', 'quarantined'].includes(item.status)) {
      failures.push(`${target.id} is not green (${item.status || 'unknown'})`);
    }
    if (item.artifact !== target.artifact) {
      failures.push(`${target.id} references the wrong artifact family`);
    }
    if (item.treeSha256 !== expected.sourceTreeSha256) {
      failures.push(`${target.id} tested a different ${target.artifact} tree`);
    }
    if (item.archiveSha256 !== expected.archiveSha256 || item.archiveFile !== expected.archiveFile) {
      failures.push(`${target.id} references a different archive`);
    }
    if (item.browser !== target.browser || item.channel !== target.channel) {
      failures.push(`${target.id} browser/channel identity does not match policy`);
    }
    if (item.extensionVersion !== artifact.extensionVersion) {
      failures.push(`${target.id} extension version does not match the candidate`);
    }
    if (!item.testedVersion) {
      failures.push(`${target.id} did not record a browser version`);
    }
    for (const capability of requiredCapabilities(policy, target)) {
      if (item.capabilities?.[capability] !== true && item.status !== 'quarantined') {
        failures.push(`${target.id} did not prove ${capability}`);
      }
    }
    if (item.status === 'quarantined') {
      const declared = policy.quarantines.find(candidate => candidate.target === target.id);
      if (!declared || item.quarantine?.owner !== declared.owner || item.quarantine?.expires !== declared.expires) {
        failures.push(`${target.id} has unapproved quarantine evidence`);
      }
    }
  }
  for (const key of ARTIFACT_KEYS) {
    const familyEvidence = evidence.filter(item => item?.artifact === key);
    const seenTrees = new Set(familyEvidence.map(item => item?.treeSha256));
    const seenArchives = new Set(familyEvidence.map(item => item?.archiveSha256));
    if (seenTrees.size > 1) {
      failures.push(`required ${key} channels did not test one source-tree hash`);
    }
    if (seenArchives.size > 1) {
      failures.push(`required ${key} channels did not test one archive hash`);
    }
  }
  return {
    artifacts: Object.fromEntries(ARTIFACT_KEYS.map(key => [key, {
      archiveSha256: expectedArtifacts[key].archiveSha256,
      inventorySha256: expectedArtifacts[key].inventorySha256,
      treeSha256: expectedArtifacts[key].sourceTreeSha256
    }])),
    failures: [...new Set(failures)].sort(),
    reproducibility: {
      builderId: reproducibility?.canonical?.builderId || null,
      status: reproducibility?.status || 'missing'
    },
    schemaVersion: 2,
    status: failures.length ? 'failed' : evidence.some(item => item.status === 'quarantined') ?
      'passed-with-quarantines' : 'passed',
    targets: policy.requiredTargets.map(target => {
      const item = byTarget.get(target.id);
      return {
        artifact: target.artifact,
        id: target.id,
        status: item?.status || 'missing',
        testedVersion: item?.testedVersion || null
      };
    })
  };
};

const parseArguments = arguments_ => {
  const [command, ...rest] = arguments_;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Canary policy arguments must use --name VALUE pairs');
    }
    options[name.slice(2)] = value;
  }
  return {command, options};
};

const readEvidenceDirectory = async directory => {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const evidence = [];
  for (const name of names) {
    const item = await parseJson(path.join(directory, name), `canary evidence ${name}`);
    if (item?.schemaVersion === 2 && typeof item?.target === 'string') {
      evidence.push(item);
    }
  }
  return evidence;
};

const main = async () => {
  const {command, options} = parseArguments(process.argv.slice(2));
  const {policy} = await loadCanaryPolicy({
    manifestPath: options.manifest,
    policyPath: options.policy
  });
  const artifact = await parseJson(path.resolve(options.artifact || ''), 'canary artifact metadata');
  if (command === 'record') {
    const report = await parseJson(path.resolve(options.report || ''), 'popup matrix report');
    const evidence = createCanaryEvidence({
      artifact,
      browser: options.browser,
      channel: options.channel,
      installedVersion: options['installed-version'],
      installer: options.installer,
      policy,
      report,
      runnerImage: options['runner-image']
    });
    await writeFile(path.resolve(options.output || ''), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (evidence.gate !== 'green') {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'verify') {
    if (!options['reproducibility-gate']) {
      throw new Error('Canary verification requires --reproducibility-gate FILE');
    }
    const [evidence, reproducibility] = await Promise.all([
      readEvidenceDirectory(path.resolve(options['evidence-dir'] || '')),
      parseJson(path.resolve(options['reproducibility-gate']), 'cross-builder reproducibility gate')
    ]);
    const report = verifyCanaryEvidence({artifact, evidence, policy, reproducibility});
    await writeFile(path.resolve(options.output || ''), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'failed') {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('Usage: browser-canary-policy.mjs record|verify --policy FILE --manifest FILE --artifact FILE ...');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
