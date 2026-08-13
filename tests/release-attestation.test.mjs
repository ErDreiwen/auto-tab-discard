import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {inspectArchive} from '../scripts/archive-inventory.mjs';
import {inventorySha256} from '../scripts/cross-builder-provenance.mjs';
import {packageRelease} from '../scripts/package-release.mjs';
import {
  createReleasePredicate,
  ghVerifyArguments,
  PREDICATE_TYPE,
  TRUSTED_ROOT_SHA256,
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

const fixture = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-attestation-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const artifactDirectory = path.join(root, 'candidate');
  const packaged = await packageRelease({
    outputDirectory: artifactDirectory,
    releaseMode: false,
    repositoryRoot,
    sourceRoot: path.join(repositoryRoot, 'v3')
  });
  const canonical = {
    archiveSha256: packaged.archives[0].sha256,
    builderId: 'linux',
    commitSha,
    extensionVersion: packaged.metadata.extensionVersion,
    gitTree,
    inventorySha256: inventorySha256(packaged.metadata.inventory),
    sourceTreeSha256: packaged.metadata.sourceTreeSha256
  };
  const reproducibility = {
    builders: [
      {id: 'linux', runnerImage: 'ubuntu-clean-image', runnerOs: 'Linux'},
      {id: 'windows', runnerImage: 'windows-clean-image', runnerOs: 'Windows'}
    ],
    canonical,
    failures: [],
    schemaVersion: 1,
    status: 'passed'
  };
  const browsers = {
    archiveSha256: canonical.archiveSha256,
    failures: [],
    reproducibility: {inventorySha256: canonical.inventorySha256, status: 'passed'},
    schemaVersion: 1,
    sourceTreeSha256: canonical.sourceTreeSha256,
    status: 'passed',
    targets: [
      'chrome-minimum',
      'chrome-stable',
      'chrome-beta',
      'edge-stable',
      'edge-beta'
    ].map(id => ({id, status: 'passed'}))
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

test('versioned predicate binds exact subjects and normalized in-archive release notes', async t => {
  const {options, packaged} = await fixture(t);
  const result = await createReleasePredicate(options);
  assert.equal(result.predicateType, PREDICATE_TYPE);
  assert.deepEqual(result.subjects.map(subject => subject.name), [
    'auto-tab-discard-0.6.9.2.xpi',
    'auto-tab-discard-0.6.9.2.zip'
  ]);
  assert.ok(result.subjects.every(subject => subject.digest.sha256 === packaged.archives[0].sha256));
  assert.deepEqual(result.predicate.source, {commitSha, gitTree, ref});
  assert.equal(result.predicate.candidate.sourceTreeSha256, packaged.metadata.sourceTreeSha256);
  assert.equal(result.predicate.candidate.extensionVersion, '0.6.9.2');

  const inspected = await inspectArchive(path.join(options.artifactDirectory, result.subjects[0].name));
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
  const {options, root} = await fixture(t);
  const expected = await createReleasePredicate(options);
  let invocation;
  const executeGh = async (file, arguments_, executionOptions) => {
    invocation = {arguments_, executionOptions, file};
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
  assert.equal(invocation.file, 'gh');
  assert.deepEqual(invocation.arguments_, ghVerifyArguments({
    artifactPath: path.join(path.resolve(options.artifactDirectory), 'auto-tab-discard-0.6.9.2.zip'),
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
      const {options} = await fixture(t);
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
    const {options} = await fixture(t);
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
    const {options, root} = await fixture(t);
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
    await assert.rejects(createReleasePredicate(options), /exact five unquarantined passing targets/);
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
    'browser-actions/setup-edge@e2f31d5d9f2e6d75e72516221b4df8528e6325cf'
  ];
  assert.equal(actions.length, 30);
  assert.ok(actions.every(action => /@[a-f\d]{40}$/.test(action)), actions.join('\n'));
  assert.deepEqual([...new Set(actions)].sort(), allowedActions.sort());
  assert.match(job, /subject-path:\s*\|\s*\n\s*auto-tab-discard-0\.6\.9\.2\.xpi\s*\n\s*auto-tab-discard-0\.6\.9\.2\.zip/);
  assert.match(job, new RegExp(`predicate-type: ${PREDICATE_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(job, /release-attestation\.bundle\.json/);
  assert.match(job, /retention-days: 90/);
  assert.doesNotMatch(job, /pull_request_target|self-hosted|secrets\./);
});

test('release gate exposes a deterministic candidate but cannot pass without attestation', async () => {
  const source = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /candidateReady: candidateBlockers\.length === 0/);
  assert.match(source, /deterministic candidate bytes were produced but are not releasable/);
  assert.match(source, /verifyReleaseAttestation\(\{/);
  assert.match(source, /report\.status = 'passed'/);
  assert.ok(source.indexOf('verifyReleaseAttestation({') < source.indexOf("report.status = 'passed'"));
  assert.match(source, /if \(report\.blockers\.length\) \{\s*report\.status = 'blocked'/);
  assert.doesNotMatch(source, /--gh-executable|ghExecutable/);
  assert.doesNotMatch(source, /verifyReleaseAttestationForTest/);
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
