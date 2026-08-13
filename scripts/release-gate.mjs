#!/usr/bin/env node

import {execFile} from 'node:child_process';
import {copyFile, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {assertSameInventory, extractArchive, inspectArchive, inspectDirectory} from './archive-inventory.mjs';
import {loadAndLintManifestPolicy} from './manifest-policy.mjs';
import {packageRelease} from './package-release.mjs';
import {verifyReleaseAttestation} from './release-attestation.mjs';
import {assertReleaseContext} from './release-context.mjs';
import {materializeUpgradeBaseline} from './upgrade-baseline.mjs';

const exec = promisify(execFile);
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const parseArguments = arguments_ => {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (![
      '--attestation-bundle', '--chrome-executable', '--edge-executable', '--firefox-executable',
      '--hosted-browser-gate', '--hosted-reproducibility-gate', '--output',
      '--trusted-root'
    ].includes(name) || !value) {
      throw new Error('Usage: node scripts/release-gate.mjs [--output build/results] --chrome-executable PATH --edge-executable PATH --firefox-executable PATH [--attestation-bundle FILE --trusted-root FILE --hosted-browser-gate FILE --hosted-reproducibility-gate FILE]');
    }
    options[name] = value;
  }
  return {
    attestationBundle: options['--attestation-bundle'],
    chromeExecutable: options['--chrome-executable'],
    edgeExecutable: options['--edge-executable'],
    firefoxExecutable: options['--firefox-executable'],
    hostedBrowserGate: options['--hosted-browser-gate'],
    hostedReproducibilityGate: options['--hosted-reproducibility-gate'],
    outputDirectory: path.resolve(options['--output'] || path.join(repositoryRoot, 'build', 'results')),
    trustedRoot: options['--trusted-root']
  };
};

const relativeEvidencePath = absolute => {
  const relative = path.relative(repositoryRoot, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error(`Release evidence must remain inside the repository: ${absolute}`);
  }
  return relative;
};

const run = async (file, arguments_, cwd = repositoryRoot) => {
  try {
    const result = await exec(file, arguments_, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
    return {ok: true, stderr: result.stderr, stdout: result.stdout};
  }
  catch (error) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      stderr: error.stderr || '',
      stdout: error.stdout || ''
    };
  }
};

export const sanitizeCommandEvidenceText = value => String(value || '')
    .replace(/file:\/{2,3}[^\s"'<>]+/gi, '<local-path>')
    .replace(/\\\\[^\\/\s]+[\\/][^\r\n"'<>|]*/g, '<local-path>')
    .replace(/(?<![A-Za-z])\b[A-Za-z]:[\\/](?![\\/])[^\r\n"'<>|]*/g, '<local-path>')
    .replace(/(?:^|[\s"'(:=])\/(?:Users|home|tmp|private|var\/folders)\/[^\s"'<>]*/gi,
      match => `${match[0]}<local-path>`)
    .replace(/(?:(?:https?|wss?):\/\/)?(?:127\.0\.0\.1|localhost):\d+[^\s"'<>)}\]]*/gi,
      '<fixture-url>')
    .replace(/\b(?:https?|wss?|ftp|file|blob|data|about|chrome|edge|moz-extension|chrome-extension|edge-extension):[^\s"'<>)}\]]+/gi,
      '<url>')
    .replace(/\b[a-p]{32}\b/gi, '<extension-id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      '<opaque-id>')
    .replace(/\b(?:secret|private|sensitive)[-_ ]?canary(?:[-_:][A-Za-z0-9%._~+/=]+)*/gi,
      '<secret-canary>')
    .replace(/("(?:id|tabId|windowId|groupId|keeperId|targetId|processId|pid)"\s*:\s*)-?\d+/gi,
      '$1"<redacted-id>"')
    .replace(/\b((?:tab|window|group|target|keeper|process)(?:\s+(?:with\s+)?)?(?:id)?\s*[:=#]?\s*)-?\d+\b/gi,
      '$1<redacted-id>')
    .replace(/\b(PID\s*[:=#]?\s*)-?\d+\b/gi, '$1<redacted-id>');

const writeCommandEvidence = async (target, result) => {
  await writeFile(target, [
    `exit: ${result.ok ? 'passed' : `failed (${result.code ?? 'unknown'})`}`,
    '',
    'stdout:',
    sanitizeCommandEvidenceText(result.stdout),
    '',
    'stderr:',
    sanitizeCommandEvidenceText(result.stderr)
  ].join('\n').replace(/\r\n?/g, '\n'), 'utf8');
};

const newestJson = async directory => {
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort(binaryCompare);
  if (files.length !== 1) {
    throw new Error(`Expected exactly one browser report in ${directory}; found ${files.length}`);
  }
  return path.join(directory, files[0]);
};

const exactOrderedReportValues = (records, key, expected) =>
  Array.isArray(records) && records.length === expected.length &&
  records.every((record, index) => record?.[key] === expected[index]);

export const reportPrivacyError = report => {
  const text = JSON.stringify(report);
  if (/(?:(?:https?|wss?):\/\/)?(?:127\.0\.0\.1|localhost):\d+/i.test(text)) {
    return 'shareable report contains a loopback endpoint';
  }
  if (/(?:chrome|edge|moz)-extension:\/\/(?!<(?:redacted|isolated)>)[^/\s"']+/i.test(text)) {
    return 'shareable report contains an extension origin';
  }
  if (/(?<![A-Za-z])\b[A-Za-z]:[\\/]|(?:^|[\s"'(:=])\/(?:Users|home|tmp|private|var\/folders)\//i.test(text)) {
    return 'shareable report contains a local filesystem path';
  }
  if (/\b[a-p]{32}\b|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:secret|private|sensitive)[-_ ]?canary(?:[-_:][A-Za-z0-9%._~+/=]+)+/i.test(text)) {
    return 'shareable report contains an opaque or secret identity';
  }
  const sensitiveIdKey = key => key === 'id' || key === 'pid' || /(?:Id|Ids|ID|IDs)$/.test(key);
  const inspect = value => {
    if (Array.isArray(value)) {
      return value.some(inspect);
    }
    if (!value || typeof value !== 'object') {
      return false;
    }
    return Object.entries(value).some(([key, entry]) => /^-?\d+$/.test(key) ||
      (sensitiveIdKey(key) && (typeof entry === 'number' ||
        (typeof entry === 'string' && /^-?\d+$/.test(entry)) ||
        (Array.isArray(entry) && entry.some(item => typeof item === 'number' ||
          (typeof item === 'string' && /^-?\d+$/.test(item)))))) || inspect(entry));
  };
  return inspect(report) ? 'shareable report contains a raw browser identifier' : undefined;
};

export const quarantineUnsafeBrowserReports = async directory => {
  const files = (await readdir(directory, {withFileTypes: true}))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort(binaryCompare);
  const reasons = [];
  let removed = 0;
  let retained = 0;
  for (const file of files) {
    const reportPath = path.join(directory, file);
    let reason;
    try {
      reason = reportPrivacyError(JSON.parse(await readFile(reportPath, 'utf8')));
    }
    catch (error) {
      reason = 'shareable report is malformed';
    }
    if (reason) {
      await rm(reportPath, {force: true});
      removed += 1;
      reasons.push(reason);
    }
    else {
      retained += 1;
    }
  }
  return {reasons: [...new Set(reasons)].sort(binaryCompare), removed, retained};
};

const runBrowser = async ({id, executable, script, arguments_, reportDirectory, validate}) => {
  await rm(reportDirectory, {recursive: true, force: true});
  await mkdir(reportDirectory, {recursive: true});
  const command = await run(process.execPath, [script, '--executable', executable, ...arguments_]);
  const commandPath = path.join(reportDirectory, 'command.txt');
  await writeCommandEvidence(commandPath, command);
  if (!command.ok) {
    const quarantine = await quarantineUnsafeBrowserReports(reportDirectory);
    const suffix = quarantine.removed > 0 ? '; unsafe failed report removed' : '';
    return {id, blocker: `${id} failed against the extracted artifact${suffix}`, commandPath};
  }
  const reportPath = await newestJson(reportDirectory);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const error = reportPrivacyError(report) || validate(report);
  return error ? {id, blocker: `${id}: ${error}`, commandPath, reportPath} : {
    id,
    evidence: {id, path: relativeEvidencePath(reportPath), status: 'passed'},
    reportPath
  };
};

export const releaseGate = async ({
  attestationBundle,
  chromeExecutable,
  edgeExecutable,
  firefoxExecutable,
  hostedBrowserGate,
  hostedReproducibilityGate,
  trustedRoot,
  outputDirectory = path.join(repositoryRoot, 'build', 'results')
} = {}) => {
  outputDirectory = path.resolve(outputDirectory);
  const releaseContext = await assertReleaseContext({repositoryRoot});
  await mkdir(outputDirectory, {recursive: true});
  const evidenceRoot = path.join(outputDirectory, 'evidence');
  await rm(evidenceRoot, {recursive: true, force: true});
  await mkdir(evidenceRoot, {recursive: true});

  const blockers = [];
  const evidence = [];
  const testFiles = (await readdir(path.join(repositoryRoot, 'tests')))
    .filter(name => name.endsWith('.test.mjs'))
    .sort(binaryCompare)
    .map(name => path.join('tests', name));
  const tests = await run(process.execPath, ['--test', ...testFiles]);
  const testsPath = path.join(evidenceRoot, 'node-tests.txt');
  await writeCommandEvidence(testsPath, tests);
  if (tests.ok) {
    evidence.push({id: 'node-tests', path: relativeEvidencePath(testsPath), status: 'passed'});
  }
  else {
    blockers.push('full Node test suite failed');
  }

  const policy = await loadAndLintManifestPolicy(repositoryRoot);
  const policyPath = path.join(evidenceRoot, 'manifest-policy.json');
  await writeFile(policyPath, `${JSON.stringify(policy.report, null, 2)}\n`, 'utf8');
  if (policy.report.errors.length === 0) {
    evidence.push({id: 'manifest-store-policy', path: relativeEvidencePath(policyPath), status: 'passed'});
  }
  else {
    blockers.push(...policy.report.errors.map(error => `manifest/store policy: ${error}`));
  }
  blockers.push(...policy.report.blockers.map(blocker => `independent submission: ${blocker}`));

  const preliminary = await packageRelease({
    baseName: policy.policy.archiveBaseName,
    outputDirectory,
    releaseMode: false
  });
  const archivePath = path.join(outputDirectory,
    preliminary.archives.find(item => item.file.endsWith('.zip')).file);
  const extractedRoot = path.join(outputDirectory, 'extracted', preliminary.metadata.sourceTreeSha256);
  await rm(path.join(outputDirectory, 'extracted'), {recursive: true, force: true});
  const archiveInventory = await extractArchive(archivePath, extractedRoot);
  const extractedInventory = await inspectDirectory(extractedRoot);
  assertSameInventory(archiveInventory, extractedInventory);
  if (JSON.stringify(preliminary.metadata.inventory) !== JSON.stringify(archiveInventory.inventory)) {
    throw new Error('Packager inclusion manifest does not match the ZIP inventory');
  }
  if (archiveInventory.treeSha256 !== preliminary.metadata.sourceTreeSha256) {
    throw new Error('Packager source digest does not match extracted artifact tree');
  }
  const inventoryPath = path.join(evidenceRoot, 'artifact-inventory.json');
  await writeFile(inventoryPath, `${JSON.stringify({
    archiveSha256: archiveInventory.archiveSha256,
    entries: archiveInventory.inventory,
    treeSha256: archiveInventory.treeSha256
  }, null, 2)}\n`, 'utf8');
  evidence.push({id: 'artifact-inventory', path: relativeEvidencePath(inventoryPath), status: 'passed'});

  const baselineRoot = path.join(outputDirectory, 'upgrade-baseline', 'v0.6.9.1');
  const baseline = await materializeUpgradeBaseline({
    outputDirectory: baselineRoot,
    ref: 'v0.6.9.1',
    repositoryRoot
  });
  const baselineInventory = await inspectDirectory(baselineRoot);
  const baselinePath = path.join(evidenceRoot, 'upgrade-baseline.json');
  await writeFile(baselinePath, `${JSON.stringify({
    ...baseline,
    treeSha256: baselineInventory.treeSha256
  }, null, 2)}\n`, 'utf8');
  evidence.push({id: 'upgrade-baseline', path: relativeEvidencePath(baselinePath), status: 'passed'});

  const browserRuns = [];
  if (!chromeExecutable) {
    blockers.push('Chrome artifact-tree popup, external API, form protection, window scope, and upgrade gates were not run: --chrome-executable is required');
  }
  else {
    browserRuns.push(await runBrowser({
      id: 'chrome-popup-matrix',
      executable: chromeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'popup-matrix.cjs'),
      arguments_: [
        '--extension', extractedRoot, '--baseline', baselineRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'chrome'),
        '--results', path.join(evidenceRoot, 'chrome-popup')
      ],
      reportDirectory: path.join(evidenceRoot, 'chrome-popup'),
      validate: report => report.ok !== true ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ? 'tested tree digest does not match the release artifact' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'chrome-external-api-smoke',
      executable: chromeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'external-api-smoke.cjs'),
      arguments_: [
        '--extension', extractedRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'chrome-external-api'),
        '--results', path.join(evidenceRoot, 'chrome-external-api')
      ],
      reportDirectory: path.join(evidenceRoot, 'chrome-external-api'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'chrome-form-protection-smoke',
      executable: chromeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'form-protection-smoke.cjs'),
      arguments_: [
        '--extension', extractedRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'chrome-form-protection'),
        '--results', path.join(evidenceRoot, 'chrome-form-protection')
      ],
      reportDirectory: path.join(evidenceRoot, 'chrome-form-protection'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' :
          report.cleanup?.crashes !== 0 ? 'browser crash evidence is not clean' :
            report.cleanup?.profileRemoved !== true ? 'isolated profile cleanup did not pass' :
              report.cleanup?.process?.exited !== true ? 'isolated browser process did not exit' :
                report.fixtureStopped !== true ? 'fixture cleanup did not pass' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'chrome-window-scope-smoke',
      executable: chromeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'window-scope-smoke.cjs'),
      arguments_: [
        '--extension', extractedRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'chrome-window-scope'),
        '--results', path.join(evidenceRoot, 'chrome-window-scope')
      ],
      reportDirectory: path.join(evidenceRoot, 'chrome-window-scope'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' :
          report.cleanup?.crashes !== 0 ? 'browser crash evidence is not clean' :
            report.cleanup?.profileRemoved !== true ? 'isolated profile cleanup did not pass' :
              report.cleanup?.process?.exited !== true ? 'isolated browser process did not exit' :
                report.fixtureStopped !== true ? 'fixture cleanup did not pass' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'chrome-upgrade-rollback',
      executable: chromeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'upgrade-rollback-smoke.cjs'),
      arguments_: [
        '--extension', extractedRoot, '--baseline', baselineRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'chrome-upgrade'),
        '--results', path.join(evidenceRoot, 'chrome-upgrade')
      ],
      reportDirectory: path.join(evidenceRoot, 'chrome-upgrade'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.currentTreeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' :
          report.baselineTreeSha256 !== baselineInventory.treeSha256 ?
            'tested baseline digest does not match the tagged baseline' : undefined
    }));
  }
  if (!edgeExecutable) {
    blockers.push('Edge artifact-tree popup, direct-native race, frozen, and upgrade matrices were not run: --edge-executable is required');
  }
  else {
    browserRuns.push(await runBrowser({
      id: 'edge-popup-matrix',
      executable: edgeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'popup-matrix.cjs'),
      arguments_: [
        '--allow-edge', '--extension', extractedRoot, '--baseline', baselineRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'edge-popup'),
        '--results', path.join(evidenceRoot, 'edge-popup')
      ],
      reportDirectory: path.join(evidenceRoot, 'edge-popup'),
      validate: report => report.ok !== true ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ? 'tested tree digest does not match the release artifact' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'edge-direct-native-races',
      executable: edgeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'edge-direct-native-races.cjs'),
      arguments_: [
        '--allow-edge', '--extension', extractedRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'edge-direct-native-races'),
        '--results', path.join(evidenceRoot, 'edge-direct-native-races')
      ],
      reportDirectory: path.join(evidenceRoot, 'edge-direct-native-races'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' :
          report.releaseScopes?.length !== 5 || !exactOrderedReportValues(
            report.releaseScopes, 'command', [
              'release-window',
              'release-rights',
              'release-lefts',
              'release-other-windows',
              'release-tabs'
            ]) ? 'report does not contain the exact five release scopes' :
            report.cancellations?.length !== 4 || !exactOrderedReportValues(
              report.cancellations, 'phase', [
                'queued',
                'pre-native',
                'native-pending',
                'late-settlement'
              ]) ? 'report does not contain the exact four cancellation phases' :
              report.workerTermination?.length !== 3 || !exactOrderedReportValues(
                report.workerTermination, 'boundary', [
                  'before-native-invocation',
                  'during-native-wait',
                  'after-replacement-settlement'
                ]) ? 'report does not contain the exact three worker-termination boundaries' :
                report.cleanup?.browser?.exited !== true ?
                  'the exact isolated Edge process did not exit' :
                  report.cleanup?.crashArtifacts !== 0 || report.cleanup?.crashFree !== true ?
                    'browser crash evidence is not clean' :
                    report.cleanup?.profileRemoved !== true ?
                      'isolated profile cleanup did not pass' :
                      report.cleanup?.fixtureStopped !== true ?
                        'fixture cleanup did not pass' : undefined
    }));
    browserRuns.push(await runBrowser({
      id: 'edge-upgrade-rollback',
      executable: edgeExecutable,
      script: path.join(repositoryRoot, 'e2e', 'upgrade-rollback-smoke.cjs'),
      arguments_: [
        '--allow-edge', '--extension', extractedRoot, '--baseline', baselineRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'edge-upgrade'),
        '--results', path.join(evidenceRoot, 'edge-upgrade')
      ],
      reportDirectory: path.join(evidenceRoot, 'edge-upgrade'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.currentTreeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' :
          report.baselineTreeSha256 !== baselineInventory.treeSha256 ?
            'tested baseline digest does not match the tagged baseline' : undefined
    }));
    const frozenDirectory = path.join(evidenceRoot, 'edge-frozen');
    await rm(frozenDirectory, {recursive: true, force: true});
    await mkdir(frozenDirectory, {recursive: true});
    const generated = path.join(repositoryRoot, 'e2e', 'results', 'edge-frozen-smoke.json');
    await rm(generated, {force: true});
    const frozen = await run(process.execPath, [
      path.join(repositoryRoot, 'e2e', 'edge-frozen-smoke.cjs'),
      '--allow-edge', '--executable', edgeExecutable, '--extension', extractedRoot,
      '--profile-root', path.join(outputDirectory, 'profiles', 'edge-frozen')
    ]);
    await writeCommandEvidence(path.join(frozenDirectory, 'command.txt'), frozen);
    const copied = path.join(frozenDirectory, 'edge-frozen-smoke.json');
    if (frozen.ok) {
      await copyFile(generated, copied);
      const report = JSON.parse(await readFile(copied, 'utf8'));
      const privacyError = reportPrivacyError(report);
      browserRuns.push(privacyError ?
        {id: 'edge-frozen-smoke', blocker: `edge-frozen-smoke: ${privacyError}`} :
        report.outcome !== 'passed' ?
        {id: 'edge-frozen-smoke', blocker: 'edge-frozen-smoke report did not pass'} :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          {id: 'edge-frozen-smoke', blocker: 'edge-frozen-smoke tested tree digest does not match the release artifact'} : {
            id: 'edge-frozen-smoke',
            evidence: {id: 'edge-frozen-smoke', path: relativeEvidencePath(copied), status: 'passed'}
          });
    }
    else {
      browserRuns.push({id: 'edge-frozen-smoke', blocker: 'edge-frozen-smoke failed against the extracted artifact'});
    }
  }
  if (!firefoxExecutable) {
    blockers.push('Firefox artifact-tree BiDi smoke was not run: --firefox-executable is required');
  }
  else {
    browserRuns.push(await runBrowser({
      id: 'firefox-bidi-smoke',
      executable: firefoxExecutable,
      script: path.join(repositoryRoot, 'e2e', 'firefox-bidi-smoke.cjs'),
      arguments_: [
        '--extension', extractedRoot,
        '--profile-root', path.join(outputDirectory, 'profiles', 'firefox'),
        '--results-root', path.join(evidenceRoot, 'firefox')
      ],
      reportDirectory: path.join(evidenceRoot, 'firefox'),
      validate: report => report.outcome !== 'passed' ? 'report did not pass' :
        report.extension?.treeSha256 !== archiveInventory.treeSha256 ?
          'tested tree digest does not match the release artifact' : undefined
    }));
  }
  for (const result of browserRuns) {
    if (result.evidence) {
      evidence.push(result.evidence);
    }
    if (result.blocker) {
      blockers.push(result.blocker);
    }
  }

  const candidateBlockers = [...new Set(blockers)].sort(binaryCompare);
  const report = {
    archiveSha256: archiveInventory.archiveSha256,
    attestation: null,
    blockers: candidateBlockers,
    candidateReady: candidateBlockers.length === 0,
    commitSha: releaseContext.commitSha,
    evidence: evidence.sort((a, b) => binaryCompare(a.id, b.id)),
    sourceTreeSha256: archiveInventory.treeSha256,
    status: 'blocked'
  };
  const reportPath = path.join(outputDirectory, 'release-gate-report.json');

  if (candidateBlockers.length === 0) {
    const final = await packageRelease({
      baseName: policy.policy.archiveBaseName,
      outputDirectory,
      releaseMode: true,
      testEvidence: report.evidence
    });
    const finalArchive = await inspectArchive(path.join(outputDirectory,
      final.archives.find(item => item.file.endsWith('.zip')).file));
    if (finalArchive.archiveSha256 !== archiveInventory.archiveSha256 ||
        finalArchive.treeSha256 !== archiveInventory.treeSha256) {
      throw new Error('Final provenance packaging changed the browser-tested archive bytes');
    }

    const attestationInputs = [attestationBundle, trustedRoot, hostedBrowserGate, hostedReproducibilityGate];
    if (attestationInputs.some(Boolean) && !attestationInputs.every(Boolean)) {
      report.blockers.push('release attestation verification requires bundle, trusted root, hosted browser gate, and hosted reproducibility gate together');
    }
    else if (!attestationInputs.every(Boolean)) {
      report.blockers.push('trusted hosted release attestation is required; deterministic candidate bytes were produced but are not releasable');
    }
    else {
      try {
        const verification = await verifyReleaseAttestation({
          artifactDirectory: outputDirectory,
          browserGatePath: hostedBrowserGate,
          bundlePath: attestationBundle,
          commitSha: releaseContext.commitSha,
          gitTree: releaseContext.gitTree,
          metadataPath: final.metadataPath,
          policyPath: path.join(repositoryRoot, 'docs', 'release-policy.json'),
          ref: policy.policy.releaseRef,
          reproducibilityGatePath: hostedReproducibilityGate,
          trustedRootPath: trustedRoot
        });
        const verificationPath = path.join(evidenceRoot, 'release-attestation-verification.json');
        await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
        report.attestation = {
          predicateType: verification.predicateType,
          repository: verification.repository,
          signerWorkflow: verification.signerWorkflow,
          status: verification.status,
          verificationPath: relativeEvidencePath(verificationPath)
        };
        report.status = 'passed';
      }
      catch (error) {
        report.blockers.push(`release attestation verification failed: ${error.message}`);
      }
    }
  }
  report.blockers = [...new Set(report.blockers)].sort(binaryCompare);
  if (report.blockers.length) {
    report.status = 'blocked';
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return {report, reportPath};
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseGate(parseArguments(process.argv.slice(2))).then(({report, reportPath}) => {
    process.stdout.write(`${JSON.stringify({...report, reportPath}, null, 2)}\n`);
    if (report.status !== 'passed') {
      process.exitCode = 1;
    }
  }).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
