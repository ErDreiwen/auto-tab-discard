import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {inspectArchive} from '../scripts/archive-inventory.mjs';
import {inventorySha256} from '../scripts/cross-builder-provenance.mjs';
import {packageRelease} from '../scripts/package-release.mjs';
import {
  finalizeBrowserReport,
  quarantineUnsafeBrowserReports,
  reportPrivacyError,
  removeBrowserReports,
  retainCanonicalBrowserReport,
  sanitizeCommandEvidenceText
} from '../scripts/release-gate.mjs';
import {
  createReleasePredicate,
  deriveReleaseSubjectMetadata,
  ghVerifyArguments,
  PREDICATE_TYPE,
  TRUSTED_ROOT_SHA256,
  validateReleaseSubjectMetadata,
  verifyReleaseAttestation,
  verifyReleaseAttestationForTest
} from '../scripts/release-attestation.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const exec = promisify(execFile);
const normalizedText = data => Buffer.from(data.toString('utf8')
  .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), 'utf8');
const commitSha = 'd'.repeat(40);
const gitTree = 'e'.repeat(40);
const ref = 'refs/tags/v0.6.9.2';

const mutateStoredEntry = async (archivePath, entryPath, transform) => {
  const archive = Buffer.from(await readFile(archivePath));
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const bytes = archive.readUInt32LE(offset + 18);
    const nameBytes = archive.readUInt16LE(offset + 26);
    const extraBytes = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameBytes).toString('utf8');
    const dataStart = offset + 30 + nameBytes + extraBytes;
    if (name === entryPath) {
      const original = Buffer.from(archive.subarray(dataStart, dataStart + bytes));
      const replacement = Buffer.from(transform(original));
      assert.equal(replacement.length, original.length, 'archive mutation must preserve the stored entry size');
      replacement.copy(archive, dataStart);
      await writeFile(archivePath, archive);
      return;
    }
    offset = dataStart + bytes;
  }
  throw new Error(`Archive entry not found: ${entryPath}`);
};

const refreshArtifactMetadata = async (options, target) => {
  const metadata = JSON.parse(await readFile(options.metadataPath, 'utf8'));
  const artifact = metadata.artifacts[target];
  const inspected = await inspectArchive(path.join(options.artifactDirectory, artifact.file));
  Object.assign(artifact, {
    bytes: inspected.archiveBytes,
    entryCount: inspected.inventory.length,
    inventory: inspected.inventory,
    sha256: inspected.archiveSha256,
    treeSha256: inspected.treeSha256
  });
  await writeFile(options.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
};

const fixture = async (t, {baseName} = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-attestation-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const artifactDirectory = path.join(root, 'candidate');
  const packaged = await packageRelease({
    ...(baseName ? {baseName} : {}),
    outputDirectory: artifactDirectory,
    releaseMode: false,
    repositoryRoot,
    sourceRoot: path.join(repositoryRoot, 'v3')
  });
  const metadataSha256 = sha256(await readFile(packaged.metadataPath));
  const targetEvidence = Object.fromEntries(['chromium', 'firefox'].map(target => {
    const artifact = packaged.metadata.artifacts[target];
    return [target, {
      archiveBytes: artifact.bytes,
      archiveSha256: artifact.sha256,
      inventoryEntries: artifact.entryCount,
      inventorySha256: inventorySha256(artifact.inventory),
      treeSha256: artifact.treeSha256
    }];
  }));
  const canonical = {
    builderId: 'linux',
    commitSha,
    extensionVersion: packaged.metadata.extensionVersion,
    gitTree,
    targets: targetEvidence
  };
  const reproducibility = {
    builders: [
      {
        commitSha, extensionVersion: packaged.metadata.extensionVersion, gitTree, id: 'linux',
        metadataSha256, runnerImage: 'ubuntu-clean-image', runnerOs: 'Linux', targets: targetEvidence
      },
      {
        commitSha, extensionVersion: packaged.metadata.extensionVersion, gitTree, id: 'windows',
        metadataSha256, runnerImage: 'windows-clean-image', runnerOs: 'Windows', targets: targetEvidence
      }
    ],
    canonical,
    failures: [],
    schemaVersion: 2,
    status: 'passed'
  };
  const browsers = {
    artifacts: Object.fromEntries(['chromium', 'firefox'].map(target => {
      const artifact = packaged.metadata.artifacts[target];
      return [target, {
        archiveSha256: artifact.sha256,
        inventorySha256: inventorySha256(artifact.inventory),
        treeSha256: artifact.treeSha256
      }];
    })),
    failures: [],
    reproducibility: {builderId: 'linux', status: 'passed'},
    schemaVersion: 2,
    status: 'passed',
    targets: [
      'chrome-minimum',
      'chrome-stable',
      'chrome-beta',
      'edge-stable',
      'edge-beta',
      'firefox-minimum',
      'firefox-stable'
    ].map(id => ({artifact: id.startsWith('firefox-') ? 'firefox' : 'chromium', id, status: 'passed'}))
  };
  const reproducibilityGatePath = path.join(root, 'cross-builder-gate.json');
  const browserGatePath = path.join(root, 'browser-canary-gate.json');
  const bundlePath = path.join(root, 'release.bundle.json');
  const trustedRootPath = path.join(repositoryRoot, 'docs', 'github-attestation-trusted-root.jsonl');
  await Promise.all([
    writeFile(reproducibilityGatePath, `${JSON.stringify(reproducibility, null, 2)}\n`),
    writeFile(browserGatePath, `${JSON.stringify(browsers, null, 2)}\n`),
    writeFile(bundlePath, '{"fake":"offline bundle"}\n')
  ]);
  const options = {
    artifactDirectory,
    browserGatePath,
    bundlePath,
    commitSha,
    gitTree,
    metadataPath: packaged.metadataPath,
    policyPath: path.join(repositoryRoot, 'docs', 'release-policy.json'),
    ref,
    reproducibilityGatePath,
    trustedRootPath
  };
  return {browsers, canonical, options, packaged, reproducibility, root};
};

const verificationFixture = async t => {
  const result = await fixture(t);
  const sourceMetadataPath = path.join(result.root, 'source-checksums.json');
  const subjectMetadataPath = path.join(result.root, 'checksums.json');
  await Promise.all([
    copyFile(result.options.metadataPath, sourceMetadataPath),
    copyFile(result.options.metadataPath, subjectMetadataPath)
  ]);
  return {
    ...result,
    options: {...result.options, sourceMetadataPath, subjectMetadataPath}
  };
};

test('versioned predicate binds exact subjects and normalized in-archive release notes', async t => {
  const {options, packaged} = await fixture(t);
  const result = await createReleasePredicate(options);
  assert.equal(result.predicateType, PREDICATE_TYPE);
  assert.deepEqual(result.subjects.map(subject => subject.name), [
    'auto-tab-discard-0.6.9.2.xpi',
    'auto-tab-discard-0.6.9.2.zip'
  ]);
  assert.deepEqual(Object.fromEntries(result.subjects.map(subject => [path.extname(subject.name), subject.digest.sha256])), {
    '.xpi': packaged.metadata.artifacts.firefox.sha256,
    '.zip': packaged.metadata.artifacts.chromium.sha256
  });
  assert.deepEqual(result.predicate.source, {commitSha, gitTree, ref});
  assert.equal(result.predicate.candidate.extensionVersion, '0.6.9.2');
  assert.equal(result.predicate.schemaVersion, 2);

  const inspected = await inspectArchive(path.join(options.artifactDirectory,
    result.predicate.candidate.artifacts.chromium.file));
  for (const target of ['chromium', 'firefox']) {
    const candidate = result.predicate.candidate.artifacts[target];
    const metadata = packaged.metadata.artifacts[target];
    assert.deepEqual(candidate, {
      archiveBytes: metadata.bytes,
      archiveSha256: metadata.sha256,
      file: target === 'chromium' ? 'auto-tab-discard-0.6.9.2.zip' : 'auto-tab-discard-0.6.9.2.xpi',
      inventoryEntries: metadata.entryCount,
      inventorySha256: inventorySha256(metadata.inventory),
      manifest: metadata.inventory.find(entry => entry.path === 'manifest.json') && {
        bytes: metadata.inventory.find(entry => entry.path === 'manifest.json').bytes,
        sha256: metadata.inventory.find(entry => entry.path === 'manifest.json').sha256
      },
      treeSha256: metadata.treeSha256
    });
  }
  for (const notePath of ['FORK_NOTES.md', 'docs/MIGRATIONS.md', 'docs/PERMISSION_CHANGES.md']) {
    const entry = inspected.entries.find(item => item.path === notePath);
    assert.deepEqual(result.predicate.candidate.notes[notePath], {
      bytes: entry.bytes,
      sha256: entry.sha256
    });
    assert.ok(entry.data.toString('utf8').trim().length > 0);
  }
  const policyEntry = inspected.entries.find(item => item.path === 'docs/release-policy.json');
  assert.deepEqual(result.predicate.policy, {
    bytes: policyEntry.bytes,
    formatVersion: 1,
    sha256: policyEntry.sha256
  });
  assert.equal(result.predicate.evidence.browsers.sha256,
    sha256(await readFile(options.browserGatePath)));
  assert.equal(result.predicate.evidence.reproducibility.sha256,
    sha256(await readFile(options.reproducibilityGatePath)));
});

test('workflow canary metadata derives only versioned subject filenames and remains source-bound', async t => {
  const {options, packaged, reproducibility, root} = await fixture(t, {
    baseName: 'auto-tab-discard-canary'
  });
  const sourceMetadataPath = options.metadataPath;
  const sourceBytes = await readFile(sourceMetadataPath);
  const sourceMetadata = JSON.parse(sourceBytes.toString('utf8'));
  const policy = JSON.parse(await readFile(options.policyPath, 'utf8'));
  const releaseDirectory = path.join(root, 'release-subjects');
  const releaseMetadataPath = path.join(releaseDirectory, 'checksums.json');
  await mkdir(releaseDirectory);
  for (const target of ['chromium', 'firefox']) {
    const source = packaged.metadata.artifacts[target];
    const extension = target === 'chromium' ? '.zip' : '.xpi';
    await copyFile(path.join(options.artifactDirectory, source.file),
      path.join(options.artifactDirectory, `auto-tab-discard-0.6.9.2${extension}`));
  }

  await exec(process.execPath, [
    path.join(repositoryRoot, 'scripts', 'release-attestation.mjs'),
    'subject-metadata',
    '--metadata', sourceMetadataPath,
    '--policy', options.policyPath,
    '--output', releaseMetadataPath
  ], {cwd: repositoryRoot, encoding: 'utf8'});
  const releaseBytes = await readFile(releaseMetadataPath);
  const releaseMetadata = JSON.parse(releaseBytes.toString('utf8'));
  const expected = deriveReleaseSubjectMetadata({metadata: sourceMetadata, policy});
  assert.deepEqual(releaseMetadata, expected);
  assert.deepEqual(releaseMetadata.artifacts.chromium.file, 'auto-tab-discard-0.6.9.2.zip');
  assert.deepEqual(releaseMetadata.artifacts.firefox.file, 'auto-tab-discard-0.6.9.2.xpi');
  const restored = structuredClone(releaseMetadata);
  for (const target of ['chromium', 'firefox']) {
    restored.artifacts[target].file = sourceMetadata.artifacts[target].file;
  }
  assert.deepEqual(restored, sourceMetadata);
  assert.equal(reproducibility.builders[0].metadataSha256, sha256(sourceBytes));
  assert.equal(reproducibility.builders[1].metadataSha256, sha256(sourceBytes));

  const predicateOptions = {
    ...options,
    metadataPath: releaseMetadataPath,
    sourceMetadataPath
  };
  const result = await createReleasePredicate(predicateOptions);
  assert.deepEqual(result.subjects.map(subject => subject.name), [
    'auto-tab-discard-0.6.9.2.xpi',
    'auto-tab-discard-0.6.9.2.zip'
  ]);

  await t.test('a non-filename change in the release copy is rejected', async () => {
    const drifted = structuredClone(releaseMetadata);
    drifted.localeCount += 1;
    assert.throws(() => validateReleaseSubjectMetadata({
      policy,
      sourceMetadata,
      subjectMetadata: drifted
    }), /only in target archive filenames/);
    const driftedPath = path.join(releaseDirectory, 'drifted-checksums.json');
    await writeFile(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`);
    await assert.rejects(createReleasePredicate({...predicateOptions, metadataPath: driftedPath}),
      /only in target archive filenames/);
  });

  await t.test('validly shaped source drift is rejected by the cross-builder metadata hash', async () => {
    const driftedSource = structuredClone(sourceMetadata);
    driftedSource.localeCount += 1;
    const driftedRelease = deriveReleaseSubjectMetadata({metadata: driftedSource, policy});
    const driftedSourcePath = path.join(releaseDirectory, 'drifted-source.json');
    const driftedReleasePath = path.join(releaseDirectory, 'drifted-release.json');
    await Promise.all([
      writeFile(driftedSourcePath, `${JSON.stringify(driftedSource, null, 2)}\n`),
      writeFile(driftedReleasePath, `${JSON.stringify(driftedRelease, null, 2)}\n`)
    ]);
    await assert.rejects(createReleasePredicate({
      ...predicateOptions,
      metadataPath: driftedReleasePath,
      sourceMetadataPath: driftedSourcePath
    }), /Source metadata bytes do not match the canonical cross-builder metadata SHA-256/);
  });
});

test('release-subject metadata derivation rejects malformed format-4 inputs', async t => {
  const {options} = await fixture(t);
  const sourceMetadata = JSON.parse(await readFile(options.metadataPath, 'utf8'));
  const policy = JSON.parse(await readFile(options.policyPath, 'utf8'));
  for (const [name, mutate, expected] of [
    ['top-level drift', value => { value.unexpected = true; }, /Source metadata has an invalid shape/],
    ['target-map drift', value => { value.artifacts.safari = structuredClone(value.artifacts.firefox); },
      /exactly chromium and firefox/],
    ['artifact-record drift', value => { value.artifacts.chromium.unexpected = true; },
      /chromium artifact has an invalid shape/],
    ['version drift', value => { value.extensionVersion = '0.6.9.3'; },
      /version does not match release policy/]
  ]) {
    await t.test(name, () => {
      const drifted = structuredClone(sourceMetadata);
      mutate(drifted);
      assert.throws(() => deriveReleaseSubjectMetadata({metadata: drifted, policy}), expected);
    });
  }
});

test('reviewed trusted-root snapshot exactly matches the release-policy pin', async () => {
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, 'docs', 'release-policy.json'), 'utf8'));
  const root = normalizedText(await readFile(path.join(
    repositoryRoot, 'docs', 'github-attestation-trusted-root.jsonl')));
  const records = root.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.ok(records.every(record =>
    record.mediaType === 'application/vnd.dev.sigstore.trustedroot+json;version=0.1'));
  assert.equal(sha256(root), TRUSTED_ROOT_SHA256);
  assert.equal(policy.attestation.trustedRootSha256, TRUSTED_ROOT_SHA256);
});

test('semantic verifier invokes gh with every fixed offline trust constraint', async t => {
  const {options, root} = await verificationFixture(t);
  const expected = await createReleasePredicate(options);
  const invocations = [];
  const executeGh = async (file, arguments_, executionOptions) => {
    invocations.push({arguments_, executionOptions, file});
    return {
      stderr: '',
      stdout: JSON.stringify([{
        attestation: {fake: true},
        verificationResult: {
          statement: {
            predicate: structuredClone(expected.predicate),
            predicateType: expected.predicateType,
            subject: structuredClone(expected.subjects).reverse()
          }
        }
      }])
    };
  };
  const result = await verifyReleaseAttestationForTest(options, executeGh);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.bundle, {
    bytes: (await readFile(options.bundlePath)).length,
    sha256: sha256(await readFile(options.bundlePath))
  });
  const trustedRoot = normalizedText(await readFile(options.trustedRootPath));
  assert.deepEqual(result.trustedRoot, {
    bytes: trustedRoot.length,
    normalization: 'UTF-8, BOM stripped, LF',
    sha256: TRUSTED_ROOT_SHA256
  });
  assert.deepEqual(invocations.map(invocation => path.extname(invocation.arguments_[2])), ['.zip', '.xpi']);
  for (const invocation of invocations) {
    assert.equal(invocation.file, 'gh');
    assert.deepEqual(invocation.arguments_, ghVerifyArguments({
      artifactPath: invocation.arguments_[2],
      bundlePath: path.resolve(options.bundlePath),
      commitSha,
      predicateType: PREDICATE_TYPE,
      ref,
      repository: 'ErDreiwen/auto-tab-discard',
      signerWorkflow: 'ErDreiwen/auto-tab-discard/.github/workflows/browser-canaries.yml',
      trustedRootPath: path.resolve(options.trustedRootPath)
    }));
    for (const [flag, value] of [
      ['--bundle', path.resolve(options.bundlePath)],
      ['--custom-trusted-root', path.resolve(options.trustedRootPath)],
      ['--repo', 'ErDreiwen/auto-tab-discard'],
      ['--signer-workflow', 'ErDreiwen/auto-tab-discard/.github/workflows/browser-canaries.yml'],
      ['--signer-digest', commitSha],
      ['--source-digest', commitSha],
      ['--source-ref', ref],
      ['--predicate-type', PREDICATE_TYPE],
      ['--digest-alg', 'sha256'],
      ['--cert-oidc-issuer', 'https://token.actions.githubusercontent.com']
    ]) {
      const index = invocation.arguments_.indexOf(flag);
      assert.ok(index >= 0, flag);
      assert.equal(invocation.arguments_[index + 1], value, flag);
    }
    assert.ok(invocation.arguments_.includes('--deny-self-hosted-runners'));
    assert.deepEqual(invocation.executionOptions, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
  }
  const crlfRootPath = path.join(root, 'reviewed-root-crlf.jsonl');
  await writeFile(crlfRootPath, (await readFile(options.trustedRootPath, 'utf8')).replace(/\n/g, '\r\n'));
  const crlfResult = await verifyReleaseAttestationForTest(
    {...options, trustedRootPath: crlfRootPath}, executeGh);
  assert.equal(crlfResult.trustedRoot.sha256, TRUSTED_ROOT_SHA256);
  const bomRootPath = path.join(root, 'reviewed-root-bom.jsonl');
  await writeFile(bomRootPath, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    await readFile(options.trustedRootPath)
  ]));
  const bomResult = await verifyReleaseAttestationForTest(
    {...options, trustedRootPath: bomRootPath}, executeGh);
  assert.equal(bomResult.trustedRoot.sha256, TRUSTED_ROOT_SHA256);
});

test('offline verification rejects multiple results and every semantic mismatch', async t => {
  for (const scenario of ['none', 'multiple', 'wrong-type', 'missing-subject', 'changed-predicate']) {
    await t.test(scenario, async t => {
      const {options} = await verificationFixture(t);
      const expected = await createReleasePredicate(options);
      const statement = {
        predicate: structuredClone(expected.predicate),
        predicateType: expected.predicateType,
        subject: structuredClone(expected.subjects)
      };
      if (scenario === 'wrong-type') statement.predicateType = 'https://example.invalid/wrong/v1';
      if (scenario === 'missing-subject') statement.subject.pop();
      if (scenario === 'changed-predicate') {
        statement.predicate.candidate.notes['FORK_NOTES.md'].sha256 = 'f'.repeat(64);
      }
      const result = {verificationResult: {statement}};
      const values = scenario === 'none' ? [] : scenario === 'multiple' ? [result, result] : [result];
      await assert.rejects(verifyReleaseAttestationForTest(options,
        async () => ({stderr: '', stdout: JSON.stringify(values)})),
        scenario === 'none' || scenario === 'multiple' ? /exactly one verified attestation result/ :
          scenario === 'wrong-type' ? /wrong predicate type/ :
            scenario === 'missing-subject' ? /subject set/ : /predicate does not match/);
    });
  }

  await t.test('fake gh failure and invalid JSON are fatal', async t => {
    const {options} = await verificationFixture(t);
    await assert.rejects(verifyReleaseAttestationForTest(options, async () => {
      const error = new Error('fake gh failed');
      error.stderr = 'offline signature verification failed';
      throw error;
    }), /gh attestation verify failed: offline signature verification failed/);
    await assert.rejects(verifyReleaseAttestationForTest(options,
      async () => ({stderr: '', stdout: 'not-json'})), /did not return JSON/);
    await assert.rejects(verifyReleaseAttestationForTest(options,
      async () => ({stderr: '', stdout: '{}'})), /received non-array/);
  });
});

test('predicate and verifier fail closed on missing trust, stale evidence, and altered bytes', async t => {
  await t.test('missing or conflated trust inputs', async t => {
    const {options, root} = await verificationFixture(t);
    await assert.rejects(verifyReleaseAttestation({...options, bundlePath: undefined}),
      /independently supplied bundle/);
    await assert.rejects(verifyReleaseAttestation({...options, trustedRootPath: undefined}),
      /independently supplied trusted root/);
    await assert.rejects(verifyReleaseAttestation({...options, trustedRootPath: options.bundlePath}),
      /must be independently supplied files/);
    const untrustedRootPath = path.join(root, 'untrusted-root.jsonl');
    await writeFile(untrustedRootPath, '{"fake":"attacker-selected root"}\n');
    let invoked = false;
    await assert.rejects(verifyReleaseAttestationForTest(
      {...options, trustedRootPath: untrustedRootPath}, async () => {
        invoked = true;
      }),
      /does not match the reviewed release-policy SHA-256/);
    assert.equal(invoked, false);
    await writeFile(options.bundlePath, 'not-json');
    await assert.rejects(verifyReleaseAttestation(options), /Attestation bundle file is not valid JSON or JSONL/);
  });

  await t.test('retained source and release-subject metadata are mandatory and tamper-evident', async t => {
    const {options} = await verificationFixture(t);
    let invoked = false;
    const executeGh = async () => {
      invoked = true;
      return {stderr: '', stdout: '[]'};
    };
    await assert.rejects(verifyReleaseAttestationForTest(
      {...options, sourceMetadataPath: undefined}, executeGh),
    /requires source and release-subject metadata files/);
    await assert.rejects(verifyReleaseAttestationForTest(
      {...options, subjectMetadataPath: undefined}, executeGh),
    /requires source and release-subject metadata files/);
    await assert.rejects(verifyReleaseAttestationForTest(
      {...options, subjectMetadataPath: options.sourceMetadataPath}, executeGh),
    /must be distinct files/);

    const originalSource = JSON.parse(await readFile(options.sourceMetadataPath, 'utf8'));
    const originalSubject = JSON.parse(await readFile(options.subjectMetadataPath, 'utf8'));
    const subjectDrift = structuredClone(originalSubject);
    subjectDrift.localeCount += 1;
    await writeFile(options.subjectMetadataPath, `${JSON.stringify(subjectDrift, null, 2)}\n`);
    await assert.rejects(verifyReleaseAttestationForTest(options, executeGh),
      /only in target archive filenames/);

    const sourceDrift = structuredClone(originalSource);
    sourceDrift.localeCount += 1;
    const policy = JSON.parse(await readFile(options.policyPath, 'utf8'));
    const consistentSubjectDrift = deriveReleaseSubjectMetadata({metadata: sourceDrift, policy});
    await Promise.all([
      writeFile(options.sourceMetadataPath, `${JSON.stringify(sourceDrift, null, 2)}\n`),
      writeFile(options.subjectMetadataPath, `${JSON.stringify(consistentSubjectDrift, null, 2)}\n`)
    ]);
    await assert.rejects(verifyReleaseAttestationForTest(options, executeGh),
      /Source metadata bytes do not match the canonical cross-builder metadata SHA-256/);
    assert.equal(invoked, false);
  });

  await t.test('failed hosted evidence', async t => {
    const {browsers, options} = await fixture(t);
    await writeFile(options.browserGatePath, `${JSON.stringify({...browsers, status: 'failed'}, null, 2)}\n`);
    await assert.rejects(createReleasePredicate(options), /Browser-canary gate must have status passed/);
  });

  await t.test('different commit evidence', async t => {
    const {options, reproducibility} = await fixture(t);
    reproducibility.canonical.commitSha = '1'.repeat(40);
    await writeFile(options.reproducibilityGatePath, `${JSON.stringify(reproducibility, null, 2)}\n`);
    await assert.rejects(createReleasePredicate(options), /Cross-builder gate canonical\.commitSha/);
  });

  await t.test('altered subject bytes', async t => {
    const {options} = await fixture(t);
    const zip = path.join(options.artifactDirectory, 'auto-tab-discard-0.6.9.2.zip');
    const bytes = await readFile(zip);
    await writeFile(zip, Buffer.concat([bytes, Buffer.from('tamper')]));
    await assert.rejects(createReleasePredicate(options), /Archive bytes do not match release metadata/);
  });

  await t.test('non-manifest target drift', async t => {
    const {options, packaged} = await fixture(t);
    const xpi = path.join(options.artifactDirectory, packaged.metadata.artifacts.firefox.file);
    await mutateStoredEntry(xpi, 'LICENSE', data => {
      data[0] ^= 1;
      return data;
    });
    await refreshArtifactMetadata(options, 'firefox');
    await assert.rejects(createReleasePredicate(options),
      /Chromium and Firefox non-manifest entry differs: LICENSE/);
  });

  await t.test('invalid target background manifest', async t => {
    const {options, packaged} = await fixture(t);
    const zip = path.join(options.artifactDirectory, packaged.metadata.artifacts.chromium.file);
    await mutateStoredEntry(zip, 'manifest.json', data => {
      const manifest = data.toString('utf8');
      assert.match(manifest, /worker\/core\.mjs/);
      return Buffer.from(manifest.replace('worker/core.mjs', 'worker/fake.mjs'));
    });
    await refreshArtifactMetadata(options, 'chromium');
    await assert.rejects(createReleasePredicate(options),
      /Chromium manifest background must be the local module service worker only/);
  });

  await t.test('target manifests differ outside background', async t => {
    const {options, packaged} = await fixture(t);
    const zip = path.join(options.artifactDirectory, packaged.metadata.artifacts.chromium.file);
    await mutateStoredEntry(zip, 'manifest.json', data => {
      const manifest = data.toString('utf8');
      assert.match(manifest, /Hardened/);
      return Buffer.from(manifest.replace('Hardened', 'Tampered'));
    });
    await refreshArtifactMetadata(options, 'chromium');
    await assert.rejects(createReleasePredicate(options),
      /Chromium and Firefox manifests differ outside background/);
  });

  await t.test('artifact target map has an unexpected key', async t => {
    const {options, packaged} = await fixture(t);
    const metadata = JSON.parse(await readFile(options.metadataPath, 'utf8'));
    metadata.artifacts.safari = structuredClone(packaged.metadata.artifacts.firefox);
    await writeFile(options.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await assert.rejects(createReleasePredicate(options), /exactly chromium and firefox/);
  });

  await t.test('untrusted ref', async t => {
    const {options} = await fixture(t);
    await assert.rejects(createReleasePredicate({...options, ref: 'refs/heads/main'}),
      /trusted release tag/);
  });

  await t.test('changed trust repository', async t => {
    const {options, root} = await fixture(t);
    const policy = JSON.parse(await readFile(options.policyPath, 'utf8'));
    policy.attestation.repository = 'attacker/example';
    policy.attestation.signerWorkflow = 'attacker/example/.github/workflows/browser-canaries.yml';
    const policyPath = path.join(root, 'untrusted-policy.json');
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await assert.rejects(createReleasePredicate({...options, policyPath}),
      /invalid attestation trust identity/);
  });

  await t.test('changed trusted-root policy pin', async t => {
    const {options, root} = await fixture(t);
    const policy = JSON.parse(await readFile(options.policyPath, 'utf8'));
    policy.attestation.trustedRootSha256 = '0'.repeat(64);
    const policyPath = path.join(root, 'untrusted-root-policy.json');
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await assert.rejects(createReleasePredicate({...options, policyPath}),
      /invalid attestation trust identity/);
  });

  await t.test('missing required browser target', async t => {
    const {browsers, options} = await fixture(t);
    browsers.targets.pop();
    await writeFile(options.browserGatePath, `${JSON.stringify(browsers, null, 2)}\n`);
    await assert.rejects(createReleasePredicate(options), /exact seven unquarantined target-aware passes/);
  });
});

test('release workflow signs only the protected trusted tag after both hosted gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/browser-canaries.yml', import.meta.url), 'utf8');
  const marker = '\n  attest-trusted-release-tag:';
  assert.ok(workflow.includes(marker));
  const job = workflow.slice(workflow.indexOf(marker));
  assert.match(job, /github\.event_name == 'push'/);
  assert.match(job, /github\.repository == 'ErDreiwen\/auto-tab-discard'/);
  assert.match(job, /github\.ref == 'refs\/tags\/v0\.6\.9\.2'/);
  assert.match(job, /github\.ref_protected == true/);
  assert.match(job, /needs: \[package-linux, artifact-reproducibility-gate, browser-canary-gate\]/);
  for (const gate of ['package-linux', 'artifact-reproducibility-gate', 'browser-canary-gate']) {
    assert.match(job, new RegExp(`needs\\.${gate}\\.result == 'success'`));
  }
  assert.match(job, /permissions:\s*\n\s*artifact-metadata: write\s*\n\s*attestations: write\s*\n\s*contents: read\s*\n\s*id-token: write/);
  const actions = [...workflow.matchAll(/^\s*(?:-\s+)?uses: ([^\s#]+)/gm)].map(match => match[1]);
  const allowedActions = [
    'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'browser-actions/setup-chrome@2e1d749697dd1612b833dba4a722266286fbefcd',
    'browser-actions/setup-edge@e2f31d5d9f2e6d75e72516221b4df8528e6325cf',
    'browser-actions/setup-firefox@0bc507ddf224827e3b1af68e014d5e42ab93e795'
  ];
  assert.equal(actions.length, 32);
  assert.ok(actions.every(action => /@[a-f\d]{40}$/.test(action)), actions.join('\n'));
  assert.deepEqual([...new Set(actions)].sort(), allowedActions.sort());
  assert.match(job, /release-attestation\.mjs subject-metadata\s*\\\s*\n\s*--metadata build\/canary\/checksums\.json\s*\\\s*\n\s*--policy docs\/release-policy\.json\s*\\\s*\n\s*--output build\/release-attestation\/checksums\.json/);
  assert.match(job, /release-attestation\.mjs predicate[\s\S]*--metadata build\/release-attestation\/checksums\.json\s*\\\s*\n\s*--source-metadata build\/canary\/checksums\.json/);
  assert.match(job, /subject-path:\s*\|\s*\n\s*auto-tab-discard-0\.6\.9\.2\.xpi\s*\n\s*auto-tab-discard-0\.6\.9\.2\.zip/);
  assert.match(job, new RegExp(`predicate-type: ${PREDICATE_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(job, /release-attestation\.bundle\.json/);
  assert.match(job, /cp build\/canary\/checksums\.json build\/release-attestation\/source-checksums\.json/);
  assert.doesNotMatch(job, /cp build\/canary\/checksums\.json build\/release-attestation\/\s*(?:\n|$)/);
  assert.match(job, /retention-days: 90/);
  assert.doesNotMatch(job, /pull_request_target|self-hosted|secrets\./);
});

test('release gate exposes a deterministic candidate but cannot pass without attestation', async () => {
  const source = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /candidateReady: candidateBlockers\.length === 0/);
  assert.match(source, /deterministic candidate bytes were produced but are not releasable/);
  assert.match(source, /verifyReleaseAttestation\(\{/);
  assert.match(source, /sourceMetadataPath: path\.join\(attestationDirectory, 'source-checksums\.json'\)/);
  assert.match(source, /subjectMetadataPath: path\.join\(attestationDirectory, 'checksums\.json'\)/);
  assert.match(source, /report\.status = 'passed'/);
  assert.ok(source.indexOf('verifyReleaseAttestation({') < source.indexOf("report.status = 'passed'"));
  assert.match(source, /if \(report\.blockers\.length\) \{\s*report\.status = 'blocked'/);
  assert.doesNotMatch(source, /--gh-executable|ghExecutable/);
  assert.doesNotMatch(source, /verifyReleaseAttestationForTest/);
});

test('release gate rejects browser evidence with raw local identity or endpoints', () => {
  assert.equal(reportPrivacyError({
    extensionTree: [{path: 'data/icons/tmp/16.png'}],
    identity: {
      tabId: '<tab-id-1>',
      targetIds: ['<tab-id-1>', '<tab-id-2>'],
      windowId: '<window-id-3>'
    },
    origin: '<url>',
    secret: '<secret-canary>'
  }), undefined);

  for (const report of [
    {title: '127.0.0.1:9222/private'},
    {origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/worker/core.mjs'},
    {path: String.raw`C:\Users\alice\private\report.json`},
    {path: '/home/alice/private/report.json'},
    {extensionId: 'abcdefghijklmnopabcdefghijklmnop'},
    {operationId: '123e4567-e89b-42d3-a456-426614174000'},
    {message: 'SECRET-CANARY-50-REPORT-7c2a188e'},
    {tabId: 717171},
    {tabId: '717171'},
    {targetIds: [717171, 717172]},
    {outcomes: {'717171': {status: 'succeeded'}}}
  ]) {
    assert.match(reportPrivacyError(report), /^shareable report contains /);
  }
});

test('release gate sanitizes stdout and stderr before retaining command evidence', () => {
  const canary = 'SECRET-CANARY-50-COMMAND-7c2a188e';
  const sanitized = sanitizeCommandEvidenceText([
    String.raw`C:\Users\alice\private\failure.log`,
    String.raw`\\host\share\private.log`,
    '/home/alice/private.log',
    `http://127.0.0.1:9222/private?token=${canary}`,
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/worker/core.mjs',
    `tab with id 717171 PID=919191 ${canary}`
  ].join('\n'));

  for (const forbidden of [
    'C:\\Users\\alice', '\\\\host\\share', '/home/alice', '127.0.0.1:9222',
    'abcdefghijklmnopabcdefghijklmnop', '717171', '919191', canary
  ]) {
    assert.equal(sanitized.includes(forbidden), false, `command evidence leaked ${forbidden}`);
  }
  assert.match(sanitized, /<local-path>/);
  assert.match(sanitized, /<fixture-url>|<url>/);
  assert.match(sanitized, /<redacted-id>/);
  assert.match(sanitized, /<secret-canary>/);
});

test('successful browser reports use a fixed privacy-safe name before metadata binding', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'canonical-browser-evidence-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const reportDirectory = path.join(root, 'firefox');
  await mkdir(reportDirectory, {recursive: true});
  const dynamicName = 'firefox-bidi-smoke-1786652110733-15084-becdaa2c-e5b1-456a-bf8c-6048dd694949.json';
  const dynamicPath = path.join(reportDirectory, dynamicName);
  const report = {outcome: 'passed', profile: {removed: true}};
  await writeFile(dynamicPath, `${JSON.stringify(report)}\n`);

  const canonicalPath = await retainCanonicalBrowserReport(reportDirectory, dynamicPath);
  assert.equal(canonicalPath, path.join(reportDirectory, 'report.json'));
  assert.deepEqual(await readdir(reportDirectory), ['report.json']);
  assert.deepEqual(JSON.parse(await readFile(canonicalPath, 'utf8')), report);

  assert.equal(await retainCanonicalBrowserReport(reportDirectory, canonicalPath), canonicalPath);
  assert.deepEqual(await readdir(reportDirectory), ['report.json']);

  const evidence = {
    id: 'firefox-bidi-smoke',
    path: 'build/results/evidence/firefox/report.json',
    status: 'passed'
  };
  const releaseReport = {
    archiveSha256: '0'.repeat(64),
    commitSha: 'd'.repeat(40),
    evidence: [evidence],
    sourceTreeSha256: '1'.repeat(64)
  };
  const checksums = {
    provenance: {commitSha: 'd'.repeat(40), gitTree: 'e'.repeat(40)},
    testEvidence: [{...evidence, bytes: 53, sha256: '2'.repeat(64)}]
  };
  assert.equal(reportPrivacyError(releaseReport), undefined);
  assert.equal(reportPrivacyError(checksums), undefined);
  assert.match(reportPrivacyError({evidence: [{...evidence, path: `build/results/evidence/firefox/${dynamicName}`}]}),
    /opaque or secret identity/);

  const source = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const finalization = source.slice(source.indexOf('export const finalizeBrowserReport'),
    source.indexOf('const runBrowser'));
  assert.ok(finalization.indexOf('validationError = validate(report)') <
    finalization.indexOf('await retainReport(reportDirectory, reportPath)'),
  'release gate must validate before canonical retention');
  assert.match(source, /relativeEvidencePath\(result\.reportPath\)/,
    'release gate must bind only the finalized canonical report');
  const gateInitialization = source.slice(source.indexOf('export const releaseGate'),
    source.indexOf('const blockers = []'));
  assert.ok(gateInitialization.indexOf("await rm(reportPath, {force: true})") <
    gateInitialization.indexOf("await rm(evidenceRoot, {recursive: true, force: true})"),
  'release gate must remove stale metadata before replacing fixed-name evidence');
});

test('every failed browser finalization removes all JSON and keeps command evidence only', async t => {
  const scenarios = [
    {name: 'command', commandOk: false, reports: [['safe.json', '{"outcome":"failed"}']]},
    {name: 'missing', reports: []},
    {name: 'multiple', reports: [['one.json', '{}'], ['two.JSON', '{}']]},
    {name: 'malformed', reports: [['bad.json', '{']]},
    {name: 'privacy', reports: [['unsafe.json', '{"tabId":717171}']]},
    {name: 'contract', reports: [['failed.json', '{"outcome":"failed"}']], validate: () => 'report did not pass'},
    {name: 'validator-throw', reports: [['throw.json', '{"outcome":"passed"}']], validate: () => { throw new Error('boom'); }},
    {
      name: 'retention', reports: [['pass.json', '{"outcome":"passed"}']],
      retainReport: async () => { throw new Error('collision'); }
    }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const root = await mkdtemp(path.join(tmpdir(), `failed-browser-${scenario.name}-`));
      t.after(() => rm(root, {force: true, recursive: true}));
      const commandPath = path.join(root, 'command.txt');
      await writeFile(commandPath, 'exit: failed\n');
      for (const [name, contents] of scenario.reports) await writeFile(path.join(root, name), contents);
      const result = await finalizeBrowserReport({
        commandOk: scenario.commandOk ?? true,
        commandPath,
        id: 'fixture-browser',
        reportDirectory: root,
        retainReport: scenario.retainReport,
        validate: scenario.validate || (() => undefined)
      });
      assert.match(result.blocker, /^fixture-browser/);
      assert.deepEqual(await readdir(root), ['command.txt']);
      assert.equal(result.reportPath, undefined);
    });
  }
});

test('canonical report collision fails without overwriting either file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-report-collision-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  const source = path.join(root, 'dynamic.json');
  const destination = path.join(root, 'report.json');
  await writeFile(source, '{"source":true}\n');
  await writeFile(destination, '{"destination":true}\n');
  await assert.rejects(retainCanonicalBrowserReport(root, source));
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), {source: true});
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), {destination: true});
});

test('release gate removes unsafe or malformed JSON left by a failed browser harness', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'failed-browser-evidence-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  await mkdir(root, {recursive: true});
  await writeFile(path.join(root, 'safe.json'), JSON.stringify({
    outcome: 'failed',
    tabId: '<tab-id-1>',
    title: '<url>'
  }));
  await writeFile(path.join(root, 'unsafe.json'), JSON.stringify({
    outcome: 'failed',
    tabId: 717171,
    title: '127.0.0.1:9222/private'
  }));
  await writeFile(path.join(root, 'malformed.json'), '{');

  const result = await quarantineUnsafeBrowserReports(root);
  assert.deepEqual(result, {
    reasons: [
      'shareable report contains a loopback endpoint',
      'shareable report is malformed'
    ],
    removed: 2,
    retained: 1
  });
  assert.deepEqual((await readdir(root)).sort(), ['safe.json']);
});

test('production CLIs reject verifier-executable substitution', async () => {
  for (const [script, arguments_, expected] of [
    ['release-attestation.mjs', ['verify', '--gh', 'fake-gh'], /Unknown release-attestation option: --gh/],
    ['release-gate.mjs', ['--gh-executable', 'fake-gh'], /Usage: node scripts\/release-gate\.mjs/]
  ]) {
    await assert.rejects(exec(process.execPath, [path.join(repositoryRoot, 'scripts', script), ...arguments_], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    }), error => {
      assert.match(error.stderr, expected);
      return true;
    });
  }
});
