#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const SHA256 = /^[a-f\d]{64}$/;
const GIT_OBJECT = /^[a-f\d]{40,64}$/;
const BUILDER_ID = /^[a-z][a-z\d-]{0,31}$/;
const artifactTargets = Object.freeze(['chromium', 'firefox']);
const targetExtensions = Object.freeze({chromium: '.zip', firefox: '.xpi'});
const requiredBuilders = Object.freeze(new Map([
  ['linux', 'Linux'],
  ['windows', 'Windows']
]));

const sha256 = data => createHash('sha256').update(data).digest('hex');
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const parseJson = async (file, label = file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  }
  catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, {cause: error});
  }
};

const validateInventory = inventory => {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error('artifact inventory must be a non-empty array');
  }
  let previous;
  const seen = new Set();
  for (const [index, item] of inventory.entries()) {
    const prefix = `artifact inventory[${index}]`;
    if (!item || typeof item.path !== 'string' || !item.path ||
        item.path.startsWith('/') || item.path.includes('\\') ||
        item.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`${prefix} has an unsafe path`);
    }
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new Error(`${prefix} has an invalid byte count`);
    }
    if (!SHA256.test(item.sha256 || '')) {
      throw new Error(`${prefix} has an invalid SHA-256`);
    }
    if (seen.has(item.path)) {
      throw new Error(`${prefix} duplicates ${item.path}`);
    }
    if (previous !== undefined && binaryCompare(previous, item.path) >= 0) {
      throw new Error('artifact inventory paths are not strictly byte-sorted');
    }
    seen.add(item.path);
    previous = item.path;
  }
  return inventory;
};

export const inventorySha256 = inventory => {
  const hash = createHash('sha256');
  for (const item of validateInventory(inventory)) {
    hash.update(item.path, 'utf8');
    hash.update('\0');
    hash.update(String(item.bytes), 'ascii');
    hash.update('\0');
    hash.update(item.sha256, 'ascii');
    hash.update('\0');
  }
  return hash.digest('hex');
};

const exactTargetKeys = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort(binaryCompare).join(',') !== [...artifactTargets].sort(binaryCompare).join(',')) {
    throw new Error(`${label} must describe exactly chromium and firefox`);
  }
  return value;
};

const targetSummaries = artifact => {
  const artifacts = exactTargetKeys(artifact?.artifacts, 'builder artifact metadata');
  const bases = new Set();
  const summaries = {};
  for (const target of artifactTargets) {
    const item = artifacts[target];
    const file = String(item?.file || '');
    if (!file || file.includes('\\') || path.posix.basename(file) !== file) {
      throw new Error(`builder artifact ${target} archive path is unsafe`);
    }
    const extension = path.posix.extname(file).toLowerCase();
    if (extension !== targetExtensions[target]) {
      throw new Error(`builder artifact ${target} must use ${targetExtensions[target]}`);
    }
    bases.add(file.slice(0, -extension.length));
    if (!SHA256.test(item?.sha256 || '') || !SHA256.test(item?.treeSha256 || '') ||
        !Number.isSafeInteger(item?.bytes) || item.bytes < 0 ||
        !Number.isSafeInteger(item?.entryCount) || item.entryCount < 1) {
      throw new Error(`builder artifact has invalid ${target} metadata`);
    }
    validateInventory(item.inventory);
    if (item.entryCount !== item.inventory.length) {
      throw new Error(`builder artifact ${target} entry count does not match its inventory`);
    }
    summaries[target] = Object.freeze({
      archiveBytes: item.bytes,
      archiveSha256: item.sha256,
      inventoryEntries: item.entryCount,
      inventorySha256: inventorySha256(item.inventory),
      treeSha256: item.treeSha256
    });
  }
  if (bases.size !== 1) {
    throw new Error('Chromium and Firefox archives must share one archive base name');
  }
  return Object.freeze(summaries);
};

const validateArtifact = artifact => {
  if (artifact?.formatVersion !== 4) {
    throw new Error('builder artifact metadata formatVersion must be 4');
  }
  if (typeof artifact?.extensionVersion !== 'string' || !artifact.extensionVersion) {
    throw new Error('builder artifact has no extension version');
  }
  targetSummaries(artifact);
  return artifact;
};

export const createBuilderProvenance = ({
  artifact,
  builderId,
  commitSha,
  gitTree,
  metadataSha256,
  runnerImage,
  runnerOs
}) => {
  validateArtifact(artifact);
  const targets = targetSummaries(artifact);
  if (!BUILDER_ID.test(builderId || '')) {
    throw new Error('builder ID is invalid');
  }
  if (typeof runnerOs !== 'string' || !runnerOs || typeof runnerImage !== 'string' || !runnerImage) {
    throw new Error('runner OS and image provenance are required');
  }
  if (!GIT_OBJECT.test(commitSha || '') || !GIT_OBJECT.test(gitTree || '')) {
    throw new Error('builder Git commit and tree provenance are invalid');
  }
  if (!SHA256.test(metadataSha256 || '')) {
    throw new Error('builder metadata SHA-256 is invalid');
  }

  return Object.freeze({
    artifact: Object.freeze({
      extensionVersion: artifact.extensionVersion,
      metadataSha256,
      targets
    }),
    builder: Object.freeze({
      id: builderId,
      runnerImage,
      runnerOs
    }),
    schemaVersion: 2,
    source: Object.freeze({
      cleanCheckout: true,
      commitSha,
      gitTree
    })
  });
};

const compareField = (failures, candidate, canonical, label) => {
  if (candidate !== canonical) {
    failures.push(`${label} mismatch`);
  }
};

const validateProvenance = ({artifact, provenance}) => {
  validateArtifact(artifact);
  const targets = targetSummaries(artifact);
  if (provenance?.schemaVersion !== 2 || provenance?.source?.cleanCheckout !== true) {
    throw new Error('builder provenance must attest schema 2 and a clean checkout');
  }
  if (!BUILDER_ID.test(provenance?.builder?.id || '') ||
      typeof provenance?.builder?.runnerOs !== 'string' || !provenance.builder.runnerOs ||
      typeof provenance?.builder?.runnerImage !== 'string' || !provenance.builder.runnerImage) {
    throw new Error('builder provenance identity is invalid');
  }
  if (!GIT_OBJECT.test(provenance?.source?.commitSha || '') ||
      !GIT_OBJECT.test(provenance?.source?.gitTree || '')) {
    throw new Error('builder provenance Git identity is invalid');
  }
  if (!SHA256.test(provenance?.artifact?.metadataSha256 || '')) {
    throw new Error('builder provenance metadataSha256 is invalid');
  }
  const provenanceTargets = exactTargetKeys(provenance?.artifact?.targets, 'builder provenance target map');
  for (const target of artifactTargets) {
    for (const field of ['archiveSha256', 'inventorySha256', 'treeSha256']) {
      if (!SHA256.test(provenanceTargets[target]?.[field] || '')) {
        throw new Error(`builder provenance ${target}.${field} is invalid`);
      }
    }
    if (!Number.isSafeInteger(provenanceTargets[target]?.archiveBytes) ||
        !Number.isSafeInteger(provenanceTargets[target]?.inventoryEntries)) {
      throw new Error(`builder provenance ${target} counts are invalid`);
    }
  }
  const failures = [];
  for (const target of artifactTargets) {
    for (const [field, label] of [
      ['archiveSha256', 'archive SHA-256'],
      ['archiveBytes', 'archive byte count'],
      ['treeSha256', 'tree SHA-256'],
      ['inventorySha256', 'inventory SHA-256'],
      ['inventoryEntries', 'inventory entry count']
    ]) {
      compareField(failures, provenanceTargets[target][field], targets[target][field],
        `${provenance.builder.id} attested/${target} ${label}`);
    }
  }
  compareField(failures, provenance.artifact.extensionVersion, artifact.extensionVersion,
    `${provenance.builder.id} attested/extension version`);
  return failures;
};

export const verifyCrossBuilderProvenance = ({builders, canonicalBuilder = 'linux'}) => {
  if (!Array.isArray(builders)) {
    throw new Error('cross-builder verification requires builder records');
  }
  const failures = [];
  const byId = new Map();
  for (const record of builders) {
    failures.push(...validateProvenance(record));
    const id = record.provenance.builder.id;
    if (byId.has(id)) {
      failures.push(`duplicate builder provenance for ${id}`);
    }
    else {
      byId.set(id, record);
    }
  }
  for (const [id, expectedOs] of requiredBuilders) {
    const record = byId.get(id);
    if (!record) {
      failures.push(`missing required clean builder: ${id}`);
    }
    else if (record.provenance.builder.runnerOs !== expectedOs) {
      failures.push(`${id} builder must run on ${expectedOs}`);
    }
  }
  for (const id of byId.keys()) {
    if (!requiredBuilders.has(id)) {
      failures.push(`unexpected builder provenance: ${id}`);
    }
  }
  if (byId.size === requiredBuilders.size) {
    const runnerImages = new Set([...byId.values()].map(record =>
      `${record.provenance.builder.runnerOs}:${record.provenance.builder.runnerImage}`));
    if (runnerImages.size !== requiredBuilders.size) {
      failures.push('required builders did not use independent runner identities');
    }
  }

  const canonical = byId.get(canonicalBuilder);
  if (!canonical || !requiredBuilders.has(canonicalBuilder)) {
    failures.push(`canonical builder is unavailable: ${canonicalBuilder}`);
  }
  else {
    const reference = canonical.provenance;
    for (const [id, record] of byId) {
      if (id === canonicalBuilder) {
        continue;
      }
      const candidate = record.provenance;
      for (const [field, label] of [
        ['metadataSha256', 'metadata SHA-256'],
        ['extensionVersion', 'extension version']
      ]) {
        compareField(failures, candidate.artifact[field], reference.artifact[field], `${id}/${label}`);
      }
      for (const target of artifactTargets) {
        for (const [field, label] of [
          ['archiveSha256', 'archive SHA-256'],
          ['archiveBytes', 'archive byte count'],
          ['treeSha256', 'tree SHA-256'],
          ['inventorySha256', 'inventory SHA-256'],
          ['inventoryEntries', 'inventory entry count']
        ]) {
          compareField(failures, candidate.artifact.targets[target][field],
            reference.artifact.targets[target][field], `${id}/${target} ${label}`);
        }
      }
      compareField(failures, candidate.source.commitSha, reference.source.commitSha,
        `${id}/Git commit`);
      compareField(failures, candidate.source.gitTree, reference.source.gitTree,
        `${id}/Git tree`);
    }
  }

  const canonicalEvidence = canonical ? Object.freeze({
    builderId: canonicalBuilder,
    commitSha: canonical.provenance.source.commitSha,
    extensionVersion: canonical.provenance.artifact.extensionVersion,
    gitTree: canonical.provenance.source.gitTree,
    targets: canonical.provenance.artifact.targets
  }) : null;
  const uniqueFailures = [...new Set(failures)].sort();
  return Object.freeze({
    builders: [...byId.values()].sort((a, b) => a.provenance.builder.id.localeCompare(b.provenance.builder.id))
      .map(record => Object.freeze({
        commitSha: record.provenance.source.commitSha,
        extensionVersion: record.provenance.artifact.extensionVersion,
        gitTree: record.provenance.source.gitTree,
        id: record.provenance.builder.id,
        metadataSha256: record.provenance.artifact.metadataSha256,
        runnerImage: record.provenance.builder.runnerImage,
        runnerOs: record.provenance.builder.runnerOs,
        targets: record.provenance.artifact.targets
      })),
    canonical: canonicalEvidence,
    failures: uniqueFailures,
    schemaVersion: 2,
    status: uniqueFailures.length ? 'failed' : 'passed'
  });
};

const observeArchives = async (directory, metadata) => {
  const failures = [];
  for (const [target, archive] of Object.entries(metadata.artifacts || {})) {
    let data;
    try {
      data = await readFile(path.join(directory, archive.file));
    }
    catch (error) {
      failures.push(`${path.basename(directory)}/${target}/${archive.file} is unavailable`);
      continue;
    }
    if (sha256(data) !== archive.sha256) {
      failures.push(`${path.basename(directory)}/${target}/${archive.file} bytes do not match metadata SHA-256`);
    }
    if (data.length !== archive.bytes) {
      failures.push(`${path.basename(directory)}/${target}/${archive.file} bytes do not match metadata size`);
    }
  }
  return failures;
};

export const loadBuilderBundle = async directory => {
  directory = path.resolve(directory);
  const metadataPath = path.join(directory, 'checksums.json');
  const provenancePath = path.join(directory, 'builder-provenance.json');
  const [metadataBytes, artifact, provenance] = await Promise.all([
    readFile(metadataPath),
    parseJson(metadataPath, `${directory} artifact metadata`),
    parseJson(provenancePath, `${directory} builder provenance`)
  ]);
  validateArtifact(artifact);
  const failures = await observeArchives(directory, artifact);
  if (failures.length) {
    throw new Error(`Invalid builder bundle:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  }
  if (provenance?.artifact?.metadataSha256 !== sha256(metadataBytes)) {
    throw new Error(`${provenance?.builder?.id || path.basename(directory)} metadata bytes do not match provenance`);
  }
  return {artifact, provenance};
};

export const writeBuilderProvenance = async ({
  artifactPath,
  builderId,
  commitSha,
  gitTree,
  output,
  runnerImage,
  runnerOs
}) => {
  const metadataBytes = await readFile(artifactPath);
  const artifact = JSON.parse(metadataBytes.toString('utf8'));
  const provenance = createBuilderProvenance({
    artifact,
    builderId,
    commitSha,
    gitTree,
    metadataSha256: sha256(metadataBytes),
    runnerImage,
    runnerOs
  });
  await writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return provenance;
};

const parseArguments = arguments_ => {
  const [command, ...rest] = arguments_;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Cross-builder arguments must use --name VALUE pairs');
    }
    const key = name.slice(2);
    const values = options.get(key) || [];
    values.push(value);
    options.set(key, values);
  }
  const one = (name, required = true) => {
    const values = options.get(name) || [];
    if ((required && values.length !== 1) || (!required && values.length > 1)) {
      throw new Error(`Expected ${required ? 'exactly' : 'at most'} one --${name}`);
    }
    return values[0];
  };
  return {command, one, values: name => options.get(name) || []};
};

const main = async () => {
  const {command, one, values} = parseArguments(process.argv.slice(2));
  if (command !== 'verify') {
    throw new Error('Usage: cross-builder-provenance.mjs verify --builder-dir DIR --builder-dir DIR --output FILE');
  }
  const argumentNames = new Set(process.argv.slice(3).filter((value, index) => index % 2 === 0)
    .map(value => value.replace(/^--/, '')));
  for (const name of argumentNames) {
    if (!['builder-dir', 'canonical-builder', 'output'].includes(name)) {
      throw new Error(`Unknown cross-builder option: --${name}`);
    }
  }
  const directories = values('builder-dir');
  if (directories.length !== 2) {
    throw new Error('Cross-builder verification requires exactly two --builder-dir values');
  }
  const builders = await Promise.all(directories.map(loadBuilderBundle));
  const report = verifyCrossBuilderProvenance({
    builders,
    canonicalBuilder: one('canonical-builder', false) || 'linux'
  });
  await writeFile(path.resolve(one('output')), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
