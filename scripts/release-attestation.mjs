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

export const PREDICATE_TYPE = 'https://github.com/ErDreiwen/auto-tab-discard/attestations/release/v1';
export const TRUSTED_RELEASE_REF = 'refs/tags/v0.6.9.2';
export const TRUSTED_REPOSITORY = 'ErDreiwen/auto-tab-discard';
export const TRUSTED_SIGNER_WORKFLOW =
  'ErDreiwen/auto-tab-discard/.github/workflows/browser-canaries.yml';
export const TRUSTED_ROOT_SHA256 = '65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c';

const SHA256 = /^[a-f\d]{64}$/;
const GIT_OBJECT = /^[a-f\d]{40,64}$/;
const TAG_REF = /^refs\/tags\/v\d+(?:\.\d+){2,3}$/;
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
  'edge-beta'
]);
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const UTF8 = new TextDecoder('utf-8', {fatal: true});
const exec = promisify(execFile);
const normalizedText = data => Buffer.from(UTF8.decode(data)
  .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), 'utf8');

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

const exactArchivePair = async ({directory, metadata, subjectBaseName}) => {
  if (!Array.isArray(metadata?.archives) || metadata.archives.length !== 2) {
    throw new Error('Release metadata must describe exactly one ZIP and one XPI');
  }
  const describedExtensions = metadata.archives.map(item =>
    path.posix.extname(safeFileName(item?.file, 'Metadata archive name')).toLowerCase()).sort(binaryCompare);
  if (describedExtensions.join(',') !== '.xpi,.zip') {
    throw new Error('Release metadata must describe exactly one ZIP and one XPI');
  }
  safeFileName(`${subjectBaseName}.zip`, 'Release archive base name');
  const metadataDigests = new Set(metadata.archives.map(item => item?.sha256));
  const metadataSizes = new Set(metadata.archives.map(item => item?.bytes));
  if (metadataDigests.size !== 1 || metadataSizes.size !== 1 ||
      !SHA256.test([...metadataDigests][0] || '') || !Number.isSafeInteger([...metadataSizes][0]) ||
      [...metadataSizes][0] < 0) {
    throw new Error('Release metadata must describe byte-identical ZIP and XPI bytes');
  }
  const records = [];
  for (const extension of ['.xpi', '.zip']) {
    const name = `${subjectBaseName}${extension}`;
    const inspected = await inspectArchive(path.join(directory, name));
    if (inspected.archiveSha256 !== [...metadataDigests][0] || inspected.archiveBytes !== [...metadataSizes][0]) {
      throw new Error(`Archive bytes do not match release metadata: ${name}`);
    }
    if (inspected.treeSha256 !== metadata.sourceTreeSha256 ||
        JSON.stringify(inspected.inventory) !== JSON.stringify(metadata.inventory)) {
      throw new Error(`Archive inventory does not match release metadata: ${name}`);
    }
    records.push({inspected, name});
  }
  records.sort((a, b) => binaryCompare(a.name, b.name));
  const extensions = records.map(record => path.posix.extname(record.name).toLowerCase());
  if (extensions.join(',') !== '.xpi,.zip' ||
      records[0].inspected.archiveSha256 !== records[1].inspected.archiveSha256 ||
      records[0].inspected.archiveBytes !== records[1].inspected.archiveBytes) {
    throw new Error('Release subjects must be byte-identical XPI and ZIP aliases');
  }
  return records;
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

const validateReproducibilityGate = (gate, extensionVersion) => {
  const builders = Array.isArray(gate?.builders) ? gate.builders : [];
  if (gate?.schemaVersion !== 1 || !Array.isArray(gate?.failures) || gate.failures.length !== 0 ||
      gate?.canonical?.builderId !== 'linux' || gate.canonical.extensionVersion !== extensionVersion ||
      builders.length !== 2 ||
      !builders.some(item => item?.id === 'linux' && item?.runnerOs === 'Linux' && item?.runnerImage) ||
      !builders.some(item => item?.id === 'windows' && item?.runnerOs === 'Windows' && item?.runnerImage)) {
    throw new Error('Cross-builder gate does not contain the exact clean Linux/Windows passing evidence');
  }
};

const validateBrowserGate = gate => {
  const targets = Array.isArray(gate?.targets) ? gate.targets : [];
  if (gate?.schemaVersion !== 1 || !Array.isArray(gate?.failures) || gate.failures.length !== 0 ||
      gate?.reproducibility?.status !== 'passed' || targets.length !== REQUIRED_BROWSER_TARGETS.length ||
      REQUIRED_BROWSER_TARGETS.some((id, index) => targets[index]?.id !== id || targets[index]?.status !== 'passed')) {
    throw new Error('Browser-canary gate does not contain the exact five unquarantined passing targets');
  }
};

export const createReleasePredicate = async ({
  artifactDirectory,
  browserGatePath,
  commitSha,
  gitTree,
  metadataPath,
  policyPath,
  ref,
  reproducibilityGatePath
}) => {
  artifactDirectory = path.resolve(artifactDirectory);
  const [metadataBytes, workingPolicyBytes] = await Promise.all([
    readFile(path.resolve(metadataPath)),
    readFile(path.resolve(policyPath))
  ]);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const policy = JSON.parse(normalizedText(workingPolicyBytes).toString('utf8'));
  if (metadata?.formatVersion !== 3 || !SHA256.test(metadata?.sourceTreeSha256 || '')) {
    throw new Error('Candidate metadata must use format 3 and contain a source-tree SHA-256');
  }
  if (metadata?.extensionVersion !== policy?.releaseVersion) {
    throw new Error('Candidate version does not match release policy');
  }
  if (policy?.formatVersion !== 1 || policy?.attestation?.predicateType !== PREDICATE_TYPE ||
      policy.attestation.repository !== TRUSTED_REPOSITORY ||
      policy.attestation.signerWorkflow !== TRUSTED_SIGNER_WORKFLOW ||
      policy.attestation.trustedRootSha256 !== TRUSTED_ROOT_SHA256) {
    throw new Error('Release policy has an invalid attestation trust identity');
  }
  if (ref !== TRUSTED_RELEASE_REF || ref !== policy.releaseRef ||
      ref !== `refs/tags/v${policy.releaseVersion}` || !TAG_REF.test(ref)) {
    throw new Error(`Attestation ref must be the trusted release tag refs/tags/v${policy.releaseVersion}`);
  }
  validateGitObject(commitSha, 'Commit SHA');
  validateGitObject(gitTree, 'Git tree');
  const archives = await exactArchivePair({
    directory: artifactDirectory,
    metadata,
    subjectBaseName: policy.archiveBaseName
  });
  const policyEntry = archives[0].inspected.entries.find(entry => entry.path === 'docs/release-policy.json');
  if (!policyEntry || !normalizedText(workingPolicyBytes).equals(policyEntry.data) ||
      !normalizedText(policyEntry.data).equals(policyEntry.data)) {
    throw new Error('Release policy bytes do not match the normalized in-archive policy');
  }
  const notes = noteBindings(archives[0].inspected.entries);
  if (archives[1].inspected.entries.some((entry, index) =>
    entry.path !== archives[0].inspected.entries[index]?.path ||
    entry.sha256 !== archives[0].inspected.entries[index]?.sha256)) {
    throw new Error('ZIP and XPI normalized archive entries differ');
  }
  const archiveSha256 = archives[0].inspected.archiveSha256;
  const expectedReproducibilityGate = {
    'canonical.archiveSha256': archiveSha256,
    'canonical.inventorySha256': inventorySha256(metadata.inventory),
    'canonical.sourceTreeSha256': metadata.sourceTreeSha256,
    'canonical.commitSha': commitSha,
    'canonical.gitTree': gitTree
  };
  const [reproducibility, browsers] = await Promise.all([
    loadPassedGate(path.resolve(reproducibilityGatePath), 'Cross-builder gate',
      expectedReproducibilityGate, gate => validateReproducibilityGate(gate, metadata.extensionVersion)),
    loadPassedGate(path.resolve(browserGatePath), 'Browser-canary gate', {
      archiveSha256,
      'reproducibility.inventorySha256': inventorySha256(metadata.inventory),
      sourceTreeSha256: metadata.sourceTreeSha256
    }, validateBrowserGate)
  ]);
  const subjects = archives.map(record => Object.freeze({
    digest: Object.freeze({sha256: record.inspected.archiveSha256}),
    name: record.name
  }));
  return Object.freeze({
    predicate: Object.freeze({
      candidate: Object.freeze({
        archiveBytes: archives[0].inspected.archiveBytes,
        extensionVersion: metadata.extensionVersion,
        inventoryEntries: metadata.inventory.length,
        notes,
        sourceTreeSha256: metadata.sourceTreeSha256
      }),
      evidence: Object.freeze({browsers, reproducibility}),
      policy: Object.freeze({
        bytes: policyEntry.bytes,
        formatVersion: policy.formatVersion,
        sha256: policyEntry.sha256
      }),
      schemaVersion: 1,
      source: Object.freeze({commitSha, gitTree, ref})
    }),
    predicateType: PREDICATE_TYPE,
    subjects
  });
};

const sortedValue = value => Array.isArray(value) ? value.map(sortedValue) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort(binaryCompare).map(key => [key, sortedValue(value[key])])) : value;
const canonical = value => JSON.stringify(sortedValue(value));

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
  const expected = await createReleasePredicate({
    artifactDirectory,
    browserGatePath,
    commitSha,
    gitTree,
    metadataPath,
    policyPath,
    ref,
    reproducibilityGatePath
  });
  const repository = TRUSTED_REPOSITORY;
  const signerWorkflow = TRUSTED_SIGNER_WORKFLOW;
  const zip = expected.subjects.find(subject => subject.name.endsWith('.zip'));
  const {arguments_, result} = await runGhVerify({
    artifactPath: path.join(path.resolve(artifactDirectory), zip.name),
    bundlePath: path.resolve(bundlePath),
    commitSha,
    predicateType: expected.predicateType,
    ref,
    repository,
    signerWorkflow,
    trustedRootPath: path.resolve(trustedRootPath)
  }, executeGh);
  const statement = result?.verificationResult?.statement;
  if (!statement || statement.predicateType !== expected.predicateType) {
    throw new Error('Verified attestation has the wrong predicate type');
  }
  assertExact(sortedSubjects(statement.subject || []), sortedSubjects(expected.subjects),
    'Verified attestation subject set');
  assertExact(statement.predicate, expected.predicate, 'Verified attestation predicate');
  return Object.freeze({
    ghArguments: arguments_,
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
  if (command === 'predicate') {
    rejectUnknownOptions(options, new Set([
      'artifact-dir', 'browser-gate', 'commit', 'metadata', 'output', 'policy', 'ref',
      'reproducibility-gate', 'tree'
    ]));
    const output = path.resolve(required(options, 'output'));
    const result = await createReleasePredicate(commonOptions(options));
    await writeFile(output, `${JSON.stringify(result.predicate, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({...result, predicatePath: output}, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    rejectUnknownOptions(options, new Set([
      'artifact-dir', 'browser-gate', 'bundle', 'commit', 'metadata', 'output', 'policy',
      'ref', 'reproducibility-gate', 'tree', 'trusted-root'
    ]));
    const report = await verifyReleaseAttestation({
      ...commonOptions(options),
      bundlePath: required(options, 'bundle'),
      trustedRootPath: required(options, 'trusted-root')
    });
    if (options.output) {
      await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: release-attestation.mjs predicate|verify --artifact-dir DIR --metadata FILE --policy FILE --browser-gate FILE --reproducibility-gate FILE --commit SHA --tree SHA --ref refs/tags/vVERSION ...');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
