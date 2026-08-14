#!/usr/bin/env node

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {promisify, TextDecoder} from 'node:util';

import {inspectArchive} from './archive-inventory.mjs';
import {inventorySha256} from './cross-builder-provenance.mjs';

export const PREDICATE_TYPE = 'https://github.com/ErDreiwen/auto-tab-discard/attestations/release/v2';
export const TRUSTED_RELEASE_REF = 'refs/tags/v0.6.9.2';
export const TRUSTED_REPOSITORY = 'ErDreiwen/auto-tab-discard';
export const TRUSTED_SIGNER_WORKFLOW =
  'ErDreiwen/auto-tab-discard/.github/workflows/browser-canaries.yml';
export const TRUSTED_ROOT_SHA256 = '65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c';

const SHA256 = /^[a-f\d]{64}$/;
const GIT_OBJECT = /^[a-f\d]{40,64}$/;
const TAG_REF = /^refs\/tags\/v\d+(?:\.\d+){2,3}$/;
const ARTIFACT_TARGETS = Object.freeze(['chromium', 'firefox']);
const TARGET_EXTENSIONS = Object.freeze({chromium: '.zip', firefox: '.xpi'});
const METADATA_KEYS = Object.freeze([
  'artifacts',
  'extensionVersion',
  'formatVersion',
  'localeCount',
  'provenance',
  'rootFiles',
  'source',
  'testEvidence',
  'zipEpoch'
]);
const ARTIFACT_KEYS = Object.freeze([
  'bytes',
  'entryCount',
  'file',
  'inventory',
  'sha256',
  'treeSha256'
]);
const INVENTORY_KEYS = Object.freeze(['bytes', 'path', 'sha256']);
const NOTE_PATHS = Object.freeze([
  'FORK_NOTES.md',
  'docs/MIGRATIONS.md',
  'docs/PERMISSION_CHANGES.md'
]);
const REQUIRED_BROWSER_TARGETS = Object.freeze([
  'chrome-minimum',
  'chrome-stable',
  'chrome-beta',
  'edge-stable',
  'edge-beta',
  'firefox-minimum',
  'firefox-stable'
]);
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const UTF8 = new TextDecoder('utf-8', {fatal: true});
const exec = promisify(execFile);
const normalizedText = data => Buffer.from(UTF8.decode(data)
  .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), 'utf8');
const sortedValue = value => Array.isArray(value) ? value.map(sortedValue) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort(binaryCompare).map(key => [key, sortedValue(value[key])])) : value;
const canonical = value => JSON.stringify(sortedValue(value));

const validateJsonOrJsonLines = (data, label) => {
  const text = UTF8.decode(data).trim();
  if (!text) {
    throw new Error(`${label} file is empty`);
  }
  try {
    JSON.parse(text);
    return;
  }
  catch {
    try {
      const lines = text.split('\n').filter(Boolean);
      if (!lines.length) throw new Error('empty');
      lines.forEach(line => JSON.parse(line));
    }
    catch (error) {
      throw new Error(`${label} file is not valid JSON or JSONL`, {cause: error});
    }
  }
};

const safeFileName = (value, label) => {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.basename(value) !== value) {
    throw new Error(`${label} must be a safe file name`);
  }
  return value;
};

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      canonical(Object.keys(value).sort(binaryCompare)) !== canonical([...expected].sort(binaryCompare))) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value;
};

const validateGitObject = (value, label) => {
  if (!GIT_OBJECT.test(value || '')) {
    throw new Error(`${label} must be a lowercase Git object ID`);
  }
  return value;
};

const noteBindings = entries => Object.freeze(Object.fromEntries(NOTE_PATHS.map(notePath => {
  const entry = entries.find(candidate => candidate.path === notePath);
  if (!entry || !normalizedText(entry.data).equals(entry.data) ||
      UTF8.decode(entry.data).trim().length === 0) {
    throw new Error(`Release archive requires a non-empty normalized note: ${notePath}`);
  }
  return [notePath, Object.freeze({bytes: entry.bytes, sha256: entry.sha256})];
})));

const exactTargetMap = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort(binaryCompare).join(',') !== [...ARTIFACT_TARGETS].sort(binaryCompare).join(',')) {
    throw new Error(`${label} must describe exactly chromium and firefox`);
  }
  return value;
};

const validateMetadataShape = (metadata, label) => {
  if (metadata?.formatVersion !== 4) {
    throw new Error(`${label} must use format 4`);
  }
  exactKeys(metadata, METADATA_KEYS, label);
  if (typeof metadata.source !== 'string' || !metadata.source || metadata.source.includes('\\') ||
      path.posix.basename(metadata.source) !== metadata.source ||
      typeof metadata.extensionVersion !== 'string' || !metadata.extensionVersion ||
      metadata.zipEpoch !== '1980-01-01T00:00:00.000Z' ||
      !Number.isSafeInteger(metadata.localeCount) || metadata.localeCount < 0 ||
      !Array.isArray(metadata.rootFiles) || !Array.isArray(metadata.testEvidence) ||
      !metadata.provenance || typeof metadata.provenance !== 'object' || Array.isArray(metadata.provenance)) {
    throw new Error(`${label} has invalid shared metadata`);
  }
  const rootFiles = new Set();
  for (const rootFile of metadata.rootFiles) {
    if (typeof rootFile !== 'string' || !localExtensionPath(rootFile) || rootFiles.has(rootFile)) {
      throw new Error(`${label} has invalid rootFiles`);
    }
    rootFiles.add(rootFile);
  }
  const artifacts = exactTargetMap(metadata.artifacts, `${label} artifacts`);
  const bases = new Set();
  for (const target of ARTIFACT_TARGETS) {
    const artifact = exactKeys(artifacts[target], ARTIFACT_KEYS, `${label} ${target} artifact`);
    const extension = TARGET_EXTENSIONS[target];
    const file = safeFileName(artifact.file, `${label} ${target} archive name`);
    if (path.posix.extname(file).toLowerCase() !== extension ||
        !SHA256.test(artifact.sha256 || '') || !SHA256.test(artifact.treeSha256 || '') ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 ||
        !Number.isSafeInteger(artifact.entryCount) || artifact.entryCount < 1 ||
        !Array.isArray(artifact.inventory) || artifact.inventory.length !== artifact.entryCount) {
      throw new Error(`${label} has invalid ${target} artifact metadata`);
    }
    bases.add(file.slice(0, -extension.length));
    artifact.inventory.forEach((item, index) => {
      exactKeys(item, INVENTORY_KEYS, `${label} ${target} inventory[${index}]`);
    });
    inventorySha256(artifact.inventory);
  }
  if (bases.size !== 1) {
    throw new Error(`${label} artifacts must share one archive base name`);
  }
  return metadata;
};

const validateReleasePolicy = policy => {
  if (policy?.formatVersion !== 1 || policy?.attestation?.predicateType !== PREDICATE_TYPE ||
      policy.attestation.repository !== TRUSTED_REPOSITORY ||
      policy.attestation.signerWorkflow !== TRUSTED_SIGNER_WORKFLOW ||
      policy.attestation.trustedRootSha256 !== TRUSTED_ROOT_SHA256) {
    throw new Error('Release policy has an invalid attestation trust identity');
  }
  if (policy.releaseRef !== TRUSTED_RELEASE_REF ||
      policy.releaseRef !== `refs/tags/v${policy.releaseVersion}` || !TAG_REF.test(policy.releaseRef || '')) {
    throw new Error('Release policy does not describe the trusted release ref and version');
  }
  safeFileName(policy.archiveBaseName, 'Release archive base name');
  return policy;
};

const releaseSubjectNames = policy => Object.freeze(Object.fromEntries(ARTIFACT_TARGETS.map(target =>
  [target, `${policy.archiveBaseName}${TARGET_EXTENSIONS[target]}`])));

export const validateReleaseSubjectMetadata = ({sourceMetadata, subjectMetadata, policy}) => {
  validateReleasePolicy(policy);
  validateMetadataShape(sourceMetadata, 'Source metadata');
  validateMetadataShape(subjectMetadata, 'Release-subject metadata');
  if (sourceMetadata.extensionVersion !== policy.releaseVersion ||
      subjectMetadata.extensionVersion !== policy.releaseVersion) {
    throw new Error('Release-subject metadata version does not match release policy');
  }
  const expected = structuredClone(sourceMetadata);
  const names = releaseSubjectNames(policy);
  for (const target of ARTIFACT_TARGETS) {
    expected.artifacts[target].file = names[target];
  }
  if (canonical(subjectMetadata) !== canonical(expected)) {
    throw new Error('Release-subject metadata may differ from source metadata only in target archive filenames');
  }
  return subjectMetadata;
};

export const deriveReleaseSubjectMetadata = ({metadata, policy}) => {
  validateReleasePolicy(policy);
  validateMetadataShape(metadata, 'Source metadata');
  const result = structuredClone(metadata);
  const names = releaseSubjectNames(policy);
  for (const target of ARTIFACT_TARGETS) {
    result.artifacts[target].file = names[target];
  }
  validateReleaseSubjectMetadata({policy, sourceMetadata: metadata, subjectMetadata: result});
  return result;
};

export const writeReleaseSubjectMetadata = async ({metadataPath, outputPath, policyPath}) => {
  metadataPath = path.resolve(metadataPath);
  outputPath = path.resolve(outputPath);
  policyPath = path.resolve(policyPath);
  if (metadataPath === outputPath) {
    throw new Error('Source and release-subject metadata must be distinct files');
  }
  const [metadataBytes, policyBytes] = await Promise.all([
    readFile(metadataPath),
    readFile(policyPath)
  ]);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const policy = JSON.parse(normalizedText(policyBytes).toString('utf8'));
  const result = deriveReleaseSubjectMetadata({metadata, policy});
  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(outputPath, resultBytes);
  return Object.freeze({
    metadata: result,
    metadataPath: outputPath,
    metadataSha256: sha256(resultBytes),
    sourceMetadataSha256: sha256(metadataBytes)
  });
};

const localExtensionPath = value => typeof value === 'string' && value.length > 0 &&
  !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) &&
  !value.split(/[?#]/, 1)[0].split('/').includes('..');

const parseManifest = (entry, target) => {
  try {
    return JSON.parse(UTF8.decode(entry.data));
  }
  catch (error) {
    throw new Error(`${target} manifest.json is not valid UTF-8 JSON`, {cause: error});
  }
};

const validateManifestOnlyDelta = (records, extensionVersion) => {
  const chromiumEntries = records.chromium.inspected.entries;
  const firefoxEntries = records.firefox.inspected.entries;
  if (chromiumEntries.length !== firefoxEntries.length || chromiumEntries.some((entry, index) =>
    entry.path !== firefoxEntries[index]?.path)) {
    throw new Error('Chromium and Firefox archive path sets differ');
  }
  for (const [index, chromium] of chromiumEntries.entries()) {
    if (chromium.path === 'manifest.json') continue;
    const firefox = firefoxEntries[index];
    if (chromium.bytes !== firefox.bytes || chromium.sha256 !== firefox.sha256 ||
        !chromium.data.equals(firefox.data)) {
      throw new Error(`Chromium and Firefox non-manifest entry differs: ${chromium.path}`);
    }
  }
  const chromiumEntry = chromiumEntries.find(entry => entry.path === 'manifest.json');
  const firefoxEntry = firefoxEntries.find(entry => entry.path === 'manifest.json');
  if (!chromiumEntry || !firefoxEntry || chromiumEntry.data.equals(firefoxEntry.data)) {
    throw new Error('Release artifacts require one distinct manifest.json per target');
  }
  const chromium = parseManifest(chromiumEntry, 'Chromium');
  const firefox = parseManifest(firefoxEntry, 'Firefox');
  const {background: chromiumBackground, ...chromiumCommon} = chromium;
  const {background: firefoxBackground, ...firefoxCommon} = firefox;
  if (canonical(chromiumCommon) !== canonical(firefoxCommon)) {
    throw new Error('Chromium and Firefox manifests differ outside background');
  }
  if (chromium.manifest_version !== 3 || firefox.manifest_version !== 3 ||
      chromium.version !== extensionVersion || firefox.version !== extensionVersion) {
    throw new Error('Target manifests do not match the release manifest version and extension version');
  }
  if (canonical(Object.keys(chromiumBackground || {}).sort(binaryCompare)) !==
      canonical(['service_worker', 'type']) || chromiumBackground.service_worker !== 'worker/core.mjs' ||
      chromiumBackground.type !== 'module' || !localExtensionPath(chromiumBackground.service_worker) ||
      !chromiumEntries.some(entry => entry.path === chromiumBackground.service_worker)) {
    throw new Error('Chromium manifest background must be the local module service worker only');
  }
  if (canonical(Object.keys(firefoxBackground || {}).sort(binaryCompare)) !== canonical(['page']) ||
      firefoxBackground.page !== '/firefox/background.html' || !localExtensionPath(firefoxBackground.page) ||
      !firefoxEntries.some(entry => entry.path === firefoxBackground.page.replace(/^\/+/, ''))) {
    throw new Error('Firefox manifest background must be the local background page only');
  }
  return Object.freeze({chromium: chromiumEntry, firefox: firefoxEntry});
};

const exactArtifactPair = async ({directory, metadata, subjectBaseName}) => {
  const artifacts = exactTargetMap(metadata?.artifacts, 'Release metadata artifacts');
  safeFileName(`${subjectBaseName}.zip`, 'Release archive base name');
  const records = {};
  for (const target of ARTIFACT_TARGETS) {
    const artifact = artifacts[target];
    const extension = TARGET_EXTENSIONS[target];
    const describedFile = safeFileName(artifact?.file, `${target} metadata archive name`);
    const name = `${subjectBaseName}${extension}`;
    if (describedFile !== name || path.posix.extname(describedFile).toLowerCase() !== extension ||
        !SHA256.test(artifact?.sha256 || '') || !SHA256.test(artifact?.treeSha256 || '') ||
        !Number.isSafeInteger(artifact?.bytes) || artifact.bytes < 0 ||
        !Number.isSafeInteger(artifact?.entryCount) || artifact.entryCount < 1 ||
        !Array.isArray(artifact?.inventory) || artifact.inventory.length !== artifact.entryCount) {
      throw new Error(`Release metadata has invalid ${target} artifact metadata`);
    }
    inventorySha256(artifact.inventory);
    const inspected = await inspectArchive(path.join(directory, name));
    if (inspected.archiveSha256 !== artifact.sha256 || inspected.archiveBytes !== artifact.bytes) {
      throw new Error(`Archive bytes do not match release metadata: ${name}`);
    }
    if (inspected.treeSha256 !== artifact.treeSha256 ||
        canonical(inspected.inventory) !== canonical(artifact.inventory)) {
      throw new Error(`Archive inventory does not match release metadata: ${name}`);
    }
    records[target] = Object.freeze({artifact, inspected, name, target});
  }
  const manifests = validateManifestOnlyDelta(records, metadata.extensionVersion);
  return Object.freeze({manifests, records: Object.freeze(records)});
};

const loadPassedGate = async (file, label, expected, validate) => {
  const bytes = await readFile(file);
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.status !== 'passed') {
    throw new Error(`${label} must have status passed`);
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actual = field.includes('.') ? field.split('.').reduce((item, key) => item?.[key], value) : value[field];
    if (actual !== expectedValue) {
      throw new Error(`${label} ${field} does not match the candidate`);
    }
  }
  validate?.(value);
  return {bytes: bytes.length, sha256: sha256(bytes)};
};

const validateTargetBindings = (targets, label) => {
  exactTargetMap(targets, `${label} target map`);
  for (const target of ARTIFACT_TARGETS) {
    const value = targets[target];
    for (const field of ['archiveSha256', 'inventorySha256', 'treeSha256']) {
      if (!SHA256.test(value?.[field] || '')) {
        throw new Error(`${label} ${target}.${field} is invalid`);
      }
    }
    if (value.archiveBytes !== undefined && (!Number.isSafeInteger(value.archiveBytes) || value.archiveBytes < 0)) {
      throw new Error(`${label} ${target}.archiveBytes is invalid`);
    }
    if (value.inventoryEntries !== undefined &&
        (!Number.isSafeInteger(value.inventoryEntries) || value.inventoryEntries < 1)) {
      throw new Error(`${label} ${target}.inventoryEntries is invalid`);
    }
  }
  return targets;
};

const validateReproducibilityGate = (gate, extensionVersion, sourceMetadataSha256) => {
  const builders = Array.isArray(gate?.builders) ? gate.builders : [];
  if (gate?.schemaVersion !== 2 || !Array.isArray(gate?.failures) || gate.failures.length !== 0 ||
      gate?.canonical?.builderId !== 'linux' || gate.canonical.extensionVersion !== extensionVersion ||
      builders.length !== 2 ||
      !builders.some(item => item?.id === 'linux' && item?.runnerOs === 'Linux' && item?.runnerImage) ||
      !builders.some(item => item?.id === 'windows' && item?.runnerOs === 'Windows' && item?.runnerImage)) {
    throw new Error('Cross-builder gate does not contain the exact clean Linux/Windows passing evidence');
  }
  const canonicalTargets = validateTargetBindings(gate.canonical.targets, 'Cross-builder canonical');
  builders.forEach(builder => {
    const targets = validateTargetBindings(builder.targets, `${builder.id || 'unknown'} builder`);
    if (canonical(targets) !== canonical(canonicalTargets)) {
      throw new Error(`${builder.id || 'unknown'} builder target bindings differ from the canonical builder`);
    }
    if (builder.extensionVersion !== extensionVersion || builder.commitSha !== gate.canonical.commitSha ||
        builder.gitTree !== gate.canonical.gitTree) {
      throw new Error(`${builder.id || 'unknown'} builder source or version differs from the canonical builder`);
    }
    if (!SHA256.test(builder.metadataSha256 || '')) {
      throw new Error(`${builder.id || 'unknown'} builder metadata SHA-256 is invalid`);
    }
  });
  const canonicalBuilder = builders.find(builder => builder.id === gate.canonical.builderId);
  if (builders.some(builder => builder.metadataSha256 !== canonicalBuilder.metadataSha256)) {
    throw new Error('Cross-builder metadata SHA-256 values differ');
  }
  if (sourceMetadataSha256 && canonicalBuilder.metadataSha256 !== sourceMetadataSha256) {
    throw new Error('Source metadata bytes do not match the canonical cross-builder metadata SHA-256');
  }
};

const validateBrowserGate = gate => {
  const targets = Array.isArray(gate?.targets) ? gate.targets : [];
  if (gate?.schemaVersion !== 2 || !Array.isArray(gate?.failures) || gate.failures.length !== 0 ||
      gate?.reproducibility?.status !== 'passed' || targets.length !== REQUIRED_BROWSER_TARGETS.length ||
      REQUIRED_BROWSER_TARGETS.some((id, index) => targets[index]?.id !== id || targets[index]?.status !== 'passed') ||
      targets.some(target => target.artifact !== (target.id.startsWith('firefox-') ? 'firefox' : 'chromium'))) {
    throw new Error('Browser-canary gate does not contain the exact seven unquarantined target-aware passes');
  }
  validateTargetBindings(gate.artifacts, 'Browser-canary artifact');
};

export const createReleasePredicate = async ({
  artifactDirectory,
  browserGatePath,
  commitSha,
  gitTree,
  metadataPath,
  policyPath,
  ref,
  reproducibilityGatePath,
  sourceMetadataPath,
  subjectMetadataPath
}) => {
  artifactDirectory = path.resolve(artifactDirectory);
  const [metadataBytes, workingPolicyBytes, sourceMetadataBytes, subjectMetadataBytes] = await Promise.all([
    readFile(path.resolve(metadataPath)),
    readFile(path.resolve(policyPath)),
    sourceMetadataPath ? readFile(path.resolve(sourceMetadataPath)) : undefined,
    subjectMetadataPath ? readFile(path.resolve(subjectMetadataPath)) : undefined
  ]);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const policy = JSON.parse(normalizedText(workingPolicyBytes).toString('utf8'));
  validateReleasePolicy(policy);
  validateMetadataShape(metadata, 'Candidate metadata');
  if (metadata?.extensionVersion !== policy?.releaseVersion) {
    throw new Error('Candidate version does not match release policy');
  }
  let sourceMetadataSha256;
  if (sourceMetadataBytes) {
    const sourceMetadata = JSON.parse(sourceMetadataBytes.toString('utf8'));
    const subjectMetadata = subjectMetadataBytes ?
      JSON.parse(subjectMetadataBytes.toString('utf8')) : metadata;
    validateReleaseSubjectMetadata({policy, sourceMetadata, subjectMetadata});
    if (metadata.extensionVersion !== subjectMetadata.extensionVersion ||
        canonical(metadata.artifacts) !== canonical(subjectMetadata.artifacts)) {
      throw new Error('Candidate metadata artifacts do not match the attested release-subject metadata');
    }
    sourceMetadataSha256 = sha256(sourceMetadataBytes);
  }
  else if (subjectMetadataBytes) {
    throw new Error('Attested release-subject metadata requires source metadata');
  }
  if (ref !== TRUSTED_RELEASE_REF || ref !== policy.releaseRef ||
      ref !== `refs/tags/v${policy.releaseVersion}` || !TAG_REF.test(ref)) {
    throw new Error(`Attestation ref must be the trusted release tag refs/tags/v${policy.releaseVersion}`);
  }
  validateGitObject(commitSha, 'Commit SHA');
  validateGitObject(gitTree, 'Git tree');
  const pair = await exactArtifactPair({
    directory: artifactDirectory,
    metadata,
    subjectBaseName: policy.archiveBaseName
  });
  const policyEntry = pair.records.chromium.inspected.entries.find(
    entry => entry.path === 'docs/release-policy.json');
  if (!policyEntry || !normalizedText(workingPolicyBytes).equals(policyEntry.data) ||
      !normalizedText(policyEntry.data).equals(policyEntry.data)) {
    throw new Error('Release policy bytes do not match the normalized in-archive policy');
  }
  const notes = noteBindings(pair.records.chromium.inspected.entries);
  const expectedReproducibilityGate = {
    'canonical.commitSha': commitSha,
    'canonical.gitTree': gitTree
  };
  const expectedBrowserGate = {};
  for (const target of ARTIFACT_TARGETS) {
    const artifact = metadata.artifacts[target];
    expectedReproducibilityGate[`canonical.targets.${target}.archiveSha256`] = artifact.sha256;
    expectedReproducibilityGate[`canonical.targets.${target}.inventorySha256`] =
      inventorySha256(artifact.inventory);
    expectedReproducibilityGate[`canonical.targets.${target}.treeSha256`] = artifact.treeSha256;
    expectedBrowserGate[`artifacts.${target}.archiveSha256`] = artifact.sha256;
    expectedBrowserGate[`artifacts.${target}.inventorySha256`] = inventorySha256(artifact.inventory);
    expectedBrowserGate[`artifacts.${target}.treeSha256`] = artifact.treeSha256;
  }
  const [reproducibility, browsers] = await Promise.all([
    loadPassedGate(path.resolve(reproducibilityGatePath), 'Cross-builder gate',
      expectedReproducibilityGate,
      gate => validateReproducibilityGate(gate, metadata.extensionVersion, sourceMetadataSha256)),
    loadPassedGate(path.resolve(browserGatePath), 'Browser-canary gate', expectedBrowserGate,
      validateBrowserGate)
  ]);
  const orderedRecords = ARTIFACT_TARGETS.map(target => pair.records[target])
    .sort((a, b) => binaryCompare(a.name, b.name));
  const subjects = orderedRecords.map(record => Object.freeze({
    digest: Object.freeze({sha256: record.inspected.archiveSha256}),
    name: record.name
  }));
  const candidateArtifacts = Object.freeze(Object.fromEntries(ARTIFACT_TARGETS.map(target => {
    const record = pair.records[target];
    const manifest = pair.manifests[target];
    return [target, Object.freeze({
      archiveBytes: record.inspected.archiveBytes,
      archiveSha256: record.inspected.archiveSha256,
      file: record.name,
      inventoryEntries: record.inspected.inventory.length,
      inventorySha256: inventorySha256(record.inspected.inventory),
      manifest: Object.freeze({bytes: manifest.bytes, sha256: manifest.sha256}),
      treeSha256: record.inspected.treeSha256
    })];
  })));
  return Object.freeze({
    predicate: Object.freeze({
      candidate: Object.freeze({
        artifacts: candidateArtifacts,
        extensionVersion: metadata.extensionVersion,
        notes
      }),
      evidence: Object.freeze({browsers, reproducibility}),
      policy: Object.freeze({
        bytes: policyEntry.bytes,
        formatVersion: policy.formatVersion,
        sha256: policyEntry.sha256
      }),
      schemaVersion: 2,
      source: Object.freeze({commitSha, gitTree, ref})
    }),
    predicateType: PREDICATE_TYPE,
    subjects
  });
};

const sortedSubjects = subjects => [...subjects].map(subject => sortedValue(subject))
  .sort((a, b) => binaryCompare(a.name || '', b.name || ''));

const assertExact = (actual, expected, label) => {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} does not match the recomputed release binding`);
  }
};

export const ghVerifyArguments = ({
  artifactPath,
  bundlePath,
  commitSha,
  predicateType,
  ref,
  repository,
  signerWorkflow,
  trustedRootPath
}) => [
    'attestation', 'verify', artifactPath,
    '--bundle', bundlePath,
    '--custom-trusted-root', trustedRootPath,
    '--repo', repository,
    '--signer-workflow', signerWorkflow,
    '--signer-digest', commitSha,
    '--source-digest', commitSha,
    '--source-ref', ref,
    '--predicate-type', predicateType,
    '--digest-alg', 'sha256',
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners',
    '--format', 'json'
  ];

const runGhVerify = async (options, executeGh) => {
  const arguments_ = ghVerifyArguments(options);
  let result;
  try {
    result = await executeGh('gh', arguments_, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
  }
  catch (error) {
    throw new Error(`gh attestation verify failed: ${error.stderr || error.message}`, {cause: error});
  }
  let verified;
  try {
    verified = JSON.parse(result.stdout);
  }
  catch (error) {
    throw new Error('gh attestation verify did not return JSON', {cause: error});
  }
  if (!Array.isArray(verified) || verified.length !== 1) {
    throw new Error(`Expected exactly one verified attestation result; received ${Array.isArray(verified) ? verified.length : 'non-array'}`);
  }
  return {arguments_, result: verified[0]};
};

const verifyReleaseAttestationWithExecutor = async ({
  artifactDirectory,
  browserGatePath,
  bundlePath,
  commitSha,
  gitTree,
  metadataPath,
  policyPath,
  ref,
  reproducibilityGatePath,
  sourceMetadataPath,
  subjectMetadataPath,
  trustedRootPath
}, executeGh) => {
  if (bundlePath && trustedRootPath && path.resolve(bundlePath) === path.resolve(trustedRootPath)) {
    throw new Error('Attestation bundle and trusted root must be independently supplied files');
  }
  const trustFiles = {};
  for (const [label, file] of [['bundle', bundlePath], ['trusted root', trustedRootPath]]) {
    if (!file) {
      throw new Error(`Release attestation verification requires an independently supplied ${label} file`);
    }
    await access(path.resolve(file));
    const data = await readFile(path.resolve(file));
    if (label === 'trusted root') {
      const normalized = normalizedText(data);
      validateJsonOrJsonLines(normalized, 'Trusted root');
      const digest = sha256(normalized);
      if (digest !== TRUSTED_ROOT_SHA256) {
        throw new Error(`Trusted root does not match the reviewed release-policy SHA-256: ${digest}`);
      }
      trustFiles[label] = Object.freeze({
        bytes: normalized.length,
        normalization: 'UTF-8, BOM stripped, LF',
        sha256: digest
      });
    }
    else {
      validateJsonOrJsonLines(data, 'Attestation bundle');
      trustFiles[label] = Object.freeze({bytes: data.length, sha256: sha256(data)});
    }
  }
  if (!sourceMetadataPath || !subjectMetadataPath) {
    throw new Error('Release attestation verification requires source and release-subject metadata files');
  }
  const independentMetadataPaths = [sourceMetadataPath, subjectMetadataPath].map(file => path.resolve(file));
  if (independentMetadataPaths[0] === independentMetadataPaths[1] ||
      independentMetadataPaths.includes(path.resolve(bundlePath)) ||
      independentMetadataPaths.includes(path.resolve(trustedRootPath))) {
    throw new Error('Source metadata, release-subject metadata, bundle, and trusted root must be distinct files');
  }
  await Promise.all(independentMetadataPaths.map(file => access(file)));
  const expected = await createReleasePredicate({
    artifactDirectory,
    browserGatePath,
    commitSha,
    gitTree,
    metadataPath,
    policyPath,
    ref,
    reproducibilityGatePath,
    sourceMetadataPath,
    subjectMetadataPath
  });
  const repository = TRUSTED_REPOSITORY;
  const signerWorkflow = TRUSTED_SIGNER_WORKFLOW;
  const ghArguments = {};
  for (const target of ARTIFACT_TARGETS) {
    const subject = expected.subjects.find(candidate =>
      candidate.name.endsWith(TARGET_EXTENSIONS[target]));
    const {arguments_, result} = await runGhVerify({
      artifactPath: path.join(path.resolve(artifactDirectory), subject.name),
      bundlePath: path.resolve(bundlePath),
      commitSha,
      predicateType: expected.predicateType,
      ref,
      repository,
      signerWorkflow,
      trustedRootPath: path.resolve(trustedRootPath)
    }, executeGh);
    ghArguments[target] = Object.freeze(arguments_);
    const statement = result?.verificationResult?.statement;
    if (!statement || statement.predicateType !== expected.predicateType) {
      throw new Error(`Verified ${target} attestation has the wrong predicate type`);
    }
    assertExact(sortedSubjects(statement.subject || []), sortedSubjects(expected.subjects),
      `Verified ${target} attestation subject set`);
    assertExact(statement.predicate, expected.predicate, `Verified ${target} attestation predicate`);
  }
  return Object.freeze({
    ghArguments: Object.freeze(ghArguments),
    bundle: trustFiles.bundle,
    predicate: expected.predicate,
    predicateType: expected.predicateType,
    repository,
    signerWorkflow,
    status: 'passed',
    subjects: expected.subjects,
    trustedRoot: trustFiles['trusted root']
  });
};

export const verifyReleaseAttestation = options => verifyReleaseAttestationWithExecutor(options, exec);

// The production CLI and release gate call only verifyReleaseAttestation above.
// This explicit hook keeps fake-gh execution confined to offline unit tests.
export const verifyReleaseAttestationForTest = (options, executeGh) => {
  if (typeof executeGh !== 'function') {
    throw new TypeError('Test verifier requires an executor function');
  }
  return verifyReleaseAttestationWithExecutor(options, executeGh);
};

const parseArguments = arguments_ => {
  const [command, ...rest] = arguments_;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined || Object.hasOwn(options, name)) {
      throw new Error('Release-attestation arguments must use unique --name VALUE pairs');
    }
    options[name.slice(2)] = value;
  }
  return {command, options};
};

const required = (options, name) => {
  if (!options[name]) {
    throw new Error(`Release attestation requires --${name}`);
  }
  return options[name];
};

const rejectUnknownOptions = (options, allowed) => {
  const unknown = Object.keys(options).filter(name => !allowed.has(name));
  if (unknown.length) {
    throw new Error(`Unknown release-attestation option: --${unknown.sort(binaryCompare)[0]}`);
  }
};

const commonOptions = options => ({
  artifactDirectory: required(options, 'artifact-dir'),
  browserGatePath: required(options, 'browser-gate'),
  commitSha: required(options, 'commit'),
  gitTree: required(options, 'tree'),
  metadataPath: required(options, 'metadata'),
  policyPath: required(options, 'policy'),
  ref: required(options, 'ref'),
  reproducibilityGatePath: required(options, 'reproducibility-gate')
});

const main = async () => {
  const {command, options} = parseArguments(process.argv.slice(2));
  if (command === 'subject-metadata') {
    rejectUnknownOptions(options, new Set(['metadata', 'output', 'policy']));
    const result = await writeReleaseSubjectMetadata({
      metadataPath: required(options, 'metadata'),
      outputPath: required(options, 'output'),
      policyPath: required(options, 'policy')
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'predicate') {
    rejectUnknownOptions(options, new Set([
      'artifact-dir', 'browser-gate', 'commit', 'metadata', 'output', 'policy', 'ref',
      'reproducibility-gate', 'source-metadata', 'tree'
    ]));
    const output = path.resolve(required(options, 'output'));
    const result = await createReleasePredicate({
      ...commonOptions(options),
      sourceMetadataPath: required(options, 'source-metadata')
    });
    await writeFile(output, `${JSON.stringify(result.predicate, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({...result, predicatePath: output}, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    rejectUnknownOptions(options, new Set([
      'artifact-dir', 'browser-gate', 'bundle', 'commit', 'metadata', 'output', 'policy',
      'ref', 'reproducibility-gate', 'source-metadata', 'subject-metadata', 'tree', 'trusted-root'
    ]));
    const report = await verifyReleaseAttestation({
      ...commonOptions(options),
      bundlePath: required(options, 'bundle'),
      sourceMetadataPath: required(options, 'source-metadata'),
      subjectMetadataPath: required(options, 'subject-metadata'),
      trustedRootPath: required(options, 'trusted-root')
    });
    if (options.output) {
      await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: release-attestation.mjs subject-metadata|predicate|verify --metadata FILE --policy FILE ...');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
