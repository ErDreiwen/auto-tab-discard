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
const TARGET_ID = /^(?:chrome|edge)-(?:minimum|stable|beta)$/;
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
  if (policy?.schemaVersion !== 1) {
    errors.push('policy schemaVersion must be 1');
  }
  if (!Array.isArray(policy?.requiredCapabilities) || policy.requiredCapabilities.length === 0 ||
      policy.requiredCapabilities.some(item => typeof item !== 'string' || !item)) {
    errors.push('requiredCapabilities must be a non-empty string array');
  }
  const targets = Array.isArray(policy?.requiredTargets) ? policy.requiredTargets : [];
  if (targets.length !== 5) {
    errors.push('the canary gate requires exactly five targets');
  }
  const expected = new Set([
    'chrome-minimum', 'chrome-stable', 'chrome-beta', 'edge-stable', 'edge-beta'
  ]);
  for (const target of targets) {
    if (!target || target.id !== targetKey(target) || !TARGET_ID.test(target.id)) {
      errors.push(`invalid required target: ${JSON.stringify(target)}`);
    }
    expected.delete(target?.id);
  }
  if (new Set(targets.map(target => target?.id)).size !== targets.length) {
    errors.push('required target IDs must be unique');
  }
  if (expected.size) {
    errors.push(`missing required targets: ${[...expected].sort().join(', ')}`);
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

const archiveDigest = artifact => {
  const digests = new Set((artifact?.archives || []).map(item => item?.sha256));
  if (digests.size !== 1 || !SHA256.test([...digests][0] || '')) {
    throw new Error('canary artifact metadata must attest one shared archive SHA-256');
  }
  return [...digests][0];
};

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
  if (!policy.requiredTargets.some(candidate => candidate.id === target)) {
    throw new Error(`Unexpected canary target: ${target}`);
  }
  const expectedTreeSha256 = artifact?.sourceTreeSha256;
  if (!SHA256.test(expectedTreeSha256 || '')) {
    throw new Error('canary artifact metadata has no valid sourceTreeSha256');
  }
  const capabilities = deriveCanaryCapabilities(report, expectedTreeSha256);
  const failures = [];
  if (report?.ok !== true) {
    failures.push({kind: 'matrix-failed', detail: report?.error?.message || 'popup matrix did not pass'});
  }
  for (const capability of policy.requiredCapabilities) {
    if (capabilities[capability] !== true) {
      failures.push({kind: `capability:${capability}`, detail: `${capability} was not proven`});
    }
  }
  const reportedVersion = report?.browser?.version || '';
  if (installedVersion && major(installedVersion) !== major(reportedVersion)) {
    failures.push({kind: 'version-mismatch', detail: `installer reported ${installedVersion}; browser reported ${reportedVersion}`});
  }
  if (channel === 'minimum' && major(reportedVersion) !== policy.minimumChrome.declaredMajor) {
    failures.push({
      kind: 'minimum-version-mismatch',
      detail: `expected browser major ${policy.minimumChrome.declaredMajor}; received ${reportedVersion || 'none'}`
    });
  }
  const quarantine = failures.length ? matchingQuarantine(policy, target, failures) : undefined;
  return {
    archiveSha256: archiveDigest(artifact),
    browser,
    capabilities,
    channel,
    extensionVersion: report?.extension?.version || artifact?.extensionVersion,
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
    schemaVersion: 1,
    sourceTreeSha256: expectedTreeSha256,
    status: failures.length ? (quarantine ? 'quarantined' : 'failed') : 'passed',
    target,
    testedVersion: reportedVersion
  };
};

export const verifyCanaryEvidence = ({artifact, evidence, policy, reproducibility}) => {
  const failures = [];
  const byTarget = new Map();
  for (const item of evidence) {
    if (byTarget.has(item?.target)) {
      failures.push(`duplicate evidence for ${item?.target}`);
    }
    else {
      byTarget.set(item?.target, item);
    }
  }
  const expectedArchive = archiveDigest(artifact);
  const expectedTree = artifact?.sourceTreeSha256;
  const expectedInventory = inventorySha256(artifact?.inventory);
  if (reproducibility?.schemaVersion !== 1 || reproducibility?.status !== 'passed' ||
      reproducibility?.failures?.length !== 0) {
    failures.push('independent Linux/Windows reproducibility gate is not passed');
  }
  if (reproducibility?.canonical?.builderId !== 'linux') {
    failures.push('browser-tested artifact is not the canonical Linux builder artifact');
  }
  if (reproducibility?.canonical?.archiveSha256 !== expectedArchive) {
    failures.push('browser-tested archive differs from the cross-builder canonical archive');
  }
  if (reproducibility?.canonical?.sourceTreeSha256 !== expectedTree) {
    failures.push('browser-tested tree differs from the cross-builder canonical tree');
  }
  if (reproducibility?.canonical?.inventorySha256 !== expectedInventory) {
    failures.push('browser-tested inventory differs from the cross-builder canonical inventory');
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
    if (item.gate !== 'green' || !['passed', 'quarantined'].includes(item.status)) {
      failures.push(`${target.id} is not green (${item.status || 'unknown'})`);
    }
    if (item.sourceTreeSha256 !== expectedTree) {
      failures.push(`${target.id} tested a different source tree`);
    }
    if (item.archiveSha256 !== expectedArchive) {
      failures.push(`${target.id} references a different archive`);
    }
    if (item.browser !== target.browser || item.channel !== target.channel) {
      failures.push(`${target.id} browser/channel identity does not match policy`);
    }
    if (!item.testedVersion) {
      failures.push(`${target.id} did not record a browser version`);
    }
    for (const capability of policy.requiredCapabilities) {
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
  const seenTrees = new Set(evidence.map(item => item?.sourceTreeSha256));
  const seenArchives = new Set(evidence.map(item => item?.archiveSha256));
  if (seenTrees.size > 1) {
    failures.push('required channels did not test one source-tree hash');
  }
  if (seenArchives.size > 1) {
    failures.push('required channels did not test one archive hash');
  }
  return {
    archiveSha256: expectedArchive,
    failures: [...new Set(failures)].sort(),
    reproducibility: {
      builderId: reproducibility?.canonical?.builderId || null,
      inventorySha256: reproducibility?.canonical?.inventorySha256 || null,
      status: reproducibility?.status || 'missing'
    },
    schemaVersion: 1,
    sourceTreeSha256: expectedTree,
    status: failures.length ? 'failed' : evidence.some(item => item.status === 'quarantined') ?
      'passed-with-quarantines' : 'passed',
    targets: policy.requiredTargets.map(target => {
      const item = byTarget.get(target.id);
      return {id: target.id, status: item?.status || 'missing', testedVersion: item?.testedVersion || null};
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
    if (item?.schemaVersion === 1 && typeof item?.target === 'string') {
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
