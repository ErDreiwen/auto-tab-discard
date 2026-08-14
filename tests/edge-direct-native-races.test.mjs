import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {inspectDirectory} from '../scripts/archive-inventory.mjs';

const require = createRequire(import.meta.url);
const harness = require('../e2e/edge-direct-native-races.cjs');
const source = await readFile(new URL('../e2e/edge-direct-native-races.cjs', import.meta.url), 'utf8');

test('direct-native Edge gate binds the canonical source tree digest', async () => {
  const extension = fileURLToPath(new URL('../v3/', import.meta.url));
  assert.equal(harness.extensionTreeSha256(extension), (await inspectDirectory(extension)).treeSha256);
  assert.match(source, /`--load-extension=\$\{extension\}`/);
  assert.match(source, /`--disable-extensions-except=\$\{extension\}`/);
  assert.match(source, /EXPECTED_EXTENSION_VERSION = '0\.6\.9\.2'/);
  assert.match(source, /report\.extension\.version === EXPECTED_EXTENSION_VERSION/);
  assert.match(source, /class RawPage/);
  assert.match(source, /class RawContext/);
  assert.doesNotMatch(source, /playwright|connectOverCDP|require\('\.\/playwright-runtime/);
  assert.doesNotMatch(source, /copyTree|overlayTree|fs\.cpSync|writeFileSync\(.*worker/);
});

test('direct-native Edge gate derives exact debugger boundaries from live source anchors', () => {
  const extension = fileURLToPath(new URL('../v3/', import.meta.url));
  const lines = harness.breakpointLines(extension);
  assert.equal(lines.beforeNativeInvocation.relative, 'worker/core/native-discard-state.mjs');
  assert.equal(lines.afterNativeInvocation.relative, 'worker/core/native-discard-state.mjs');
  assert.equal(lines.replacementSettled.relative, 'worker/core/discard.mjs');
  assert.ok(lines.beforeNativeInvocation.lineNumber < lines.afterNativeInvocation.lineNumber);
  assert.match(source, /Target\.setAutoAttach/);
  assert.match(source, /waitForDebuggerOnStart:\s*true/);
  assert.match(source, /Debugger\.setBreakpointByUrl/);
  assert.match(source, /Debugger\.breakpointResolved/);
  assert.match(source, /for \(const location of result\.locations \|\| \[\]\)/);
  assert.match(source, /breakpointResolutions\.get\(`\$\{sessionId\}:\$\{stage\}`\)\?\.size > 0/);
  assert.match(source, /await this\.awaitReady\(\)/);
  assert.match(source, /ServiceWorker\.stopWorker/);
  assert.match(source, /ServiceWorker\.workerRegistrationUpdated/);
  assert.match(source, /ServiceWorker\.workerVersionUpdated/);
  assert.match(source, /version\.registrationId/);
  assert.match(source, /version\.scriptURL/);
  assert.match(source, /enableWorkerControl\(driver\.sessionId\)/);
  assert.match(source, /Runtime\.runIfWaitingForDebugger/);
});

test('direct-native Edge gate covers all five exact popup release scopes', () => {
  assert.deepEqual(harness.RELEASE_COMMANDS, [
    'release-window',
    'release-rights',
    'release-lefts',
    'release-other-windows',
    'release-tabs'
  ]);
  assert.deepEqual(harness.expectedScopeRoles('release-window'), ['left', 'right']);
  assert.deepEqual(harness.expectedScopeRoles('release-rights'), ['right']);
  assert.deepEqual(harness.expectedScopeRoles('release-lefts'), ['left']);
  assert.deepEqual(harness.expectedScopeRoles('release-other-windows'), ['other']);
  assert.deepEqual(harness.expectedScopeRoles('release-tabs'), ['left', 'right', 'other']);
  assert.match(source, /method:\s*'popup'/);
  assert.match(source, /requireReleaseProgress\(progress, releaseResults, command\)/);
  assert.match(source, /stableReleased\(\{/);
  assert.match(source, /fixture\.count\(label\) - beforeRequests === 1/);
  assert.match(source, /received a repeated release request during dwell/);
  assert.match(source, /activated a release target/);
  assert.match(source, /normalizeDriverTopology[\s\S]*chrome\.tabs\.getCurrent\(\)[\s\S]*chrome\.tabs\.remove\(extras\)[\s\S]*remaining\.length === 1[\s\S]*windows\.length === 1/);
  assert.match(source, /const driver = await openDriver[\s\S]*await normalizeDriverTopology\(driver\)[\s\S]*await installMonitor/);
});

test('direct-native Edge gate covers queued through late cancellation with public commands', () => {
  assert.deepEqual(harness.CANCELLATION_PHASES, [
    'queued',
    'pre-native',
    'native-pending',
    'late-settlement'
  ]);
  assert.match(source, /method:\s*'popup-progress-cancel'/);
  assert.match(source, /state\.cancellation\.phase === 'pre-native'/);
  assert.match(source, /marker\?\.state === 'direct-native-pending'/);
  assert.match(source, /waitForPause\('during-native-wait'\)/);
  assert.match(source, /state\.cancellation\.phase === 'late-settlement'/);
  assert.match(source, /tab\?\.discarded === true/);
  assert.match(source, /marker\?\.state === 'takeover-queued'/);
  assert.match(source, /queuedTargetNativeCallExecuted:\s*false/);
  assert.match(source, /response\.value\?\.state === 'cancelled'/);
  assert.match(source, /releaseReloads:\s*1/);
});

test('direct-native Edge gate forces all three MV3 restart boundaries fail closed', () => {
  assert.deepEqual(harness.TERMINATION_BOUNDARIES, [
    'before-native-invocation',
    'during-native-wait',
    'after-replacement-settlement'
  ]);
  assert.match(source, /debuggerGate\.terminate\(beforePause, driver\.sessionId\)/);
  assert.match(source, /debuggerGate\.terminate\(afterCall, driver\.sessionId\)/);
  assert.match(source, /debuggerGate\.terminate\(settled, driver\.sessionId\)/);
  assert.match(source, /debuggerGate\.ensureReadyWorker\(10_000, \{excludeTargetId: terminatedTargetId\}\)/);
  assert.match(source, /chrome\.runtime\.sendMessage\(\{method: 'takeover-snapshot'\}/);
  assert.match(source, /while \(poking\)/);
  assert.match(source, /restarted extension worker message response/);
  assert.match(source, /popupCommand\(driver, 'discard-rights', selected, true\)/);
  assert.match(source, /restart did not preserve its fail-closed pending fence/);
  assert.match(source, /discardFromIsolatedController/);
  assert.match(source, /externalAuthority:.*'isolated-controller-native-discard'/s);
  assert.match(source, /source === 'physical-only'/);
  assert.match(source, /expectNoNativeCall/);
  assert.match(source, /executedNativeCalls - nativeBefore\.executedNativeCalls === expectedNative/);
  assert.match(source, /did not fail release closed/);
  assert.match(source, /did not receive exactly one explicit release request/);

  const restart = source.indexOf('const lastWakeResponse =');
  const orphanStart = source.indexOf("if (boundary === 'during-native-wait') {", restart);
  const orphanEnd = source.indexOf('let failedClosedBeforeAuthority = false;', orphanStart);
  assert.notEqual(orphanStart, -1, 'the post-restart during-native orphan branch is missing');
  assert.notEqual(orphanEnd, -1, 'the unattributed-orphan branch is unterminated');
  const orphan = source.slice(orphanStart, orphanEnd);
  assert.match(orphan, /ownershipFenceCounts\(driver\)/);
  assert.match(orphan, /counts\.directNativeOrphans === 1/);
  assert.match(orphan, /successorMarker === undefined/);
  assert.match(orphan, /popupCommand\(driver, 'discard-rights'/);
  assert.match(orphan, /popupCommand\(driver, 'release-rights'/);
  assert.match(orphan, /releaseOutcomes\[0\]\?\.code === ORPHAN_RELEASE_OUTCOME_CODE/);
  assert.match(orphan, /restartOwnership: 'unattributed-orphan'/);
  assert.match(orphan, /orphanFence: true/);
  assert.match(orphan, /releaseBlocked: true/);
  assert.match(orphan, /finalReleasePromised: false/);
  assert.match(orphan, /successorOwnershipAbsent: true/);
  assert.match(orphan, /rendererScripts: releaseApi\.executeScript/);
  assert.match(orphan, /rendererScripts: repeatApi\.executeScript/);
  assert.doesNotMatch(orphan, /stableReleased\(/,
    'an unattributed orphan must not be handed to the release-success verifier');
  assert.match(source, /ORPHAN_RELEASE_OUTCOME_CODE = 'TAB_FAILED'/);
  assert.match(source, /marker\.state === 'direct-native-orphan'/);
  assert.match(source, /Runtime\.evaluate/);
  assert.match(source, /installApiTelemetry\(sessionId\)/);
  assert.match(source, /workerApiDelta\(repeatBeforeMonitor, repeatAfterMonitor\)/);
  assert.match(source, /workerApiDelta\(releaseBeforeMonitor, releaseAfterMonitor\)/);
  assert.match(source, /orphanTermination\?\.restartOwnership === 'unattributed-orphan'/);
  assert.match(source, /orphanTermination\.zeroMutation\?\.release\?\.rendererScripts === 0/);
  assert.match(source, /orphanTermination\.zeroMutation\?\.repeatDiscard\?\.rendererScripts === 0/);
  assert.match(source, /report\.releaseCapability\.blockedNativeOrphan === 1/);
  assert.match(source, /counts\.directNativePending === 1 && counts\.directNativeOrphans === 0/,
    'native-pending cancellation uses a replacement-safe count-only durable-intent fence');
});

test('direct-native Edge gate reports retained-frozen release as a bounded capability limitation', () => {
  assert.match(source, /RETAINED_FROZEN_CODE = 'TAB_RELEASE_REMAINS_FROZEN'/);
  assert.match(source, /\['false', 'absent'\]\.includes\(tab\.frozenCapability\)/);
  assert.match(source, /tab\.frozenCapability === 'true'/);
  assert.match(source, /outcome\.status === 'failed' && outcome\.code === RETAINED_FROZEN_CODE/);
  assert.match(source, /outcome\.status === 'success' && outcome\.code === 'TAB_RELEASED'/);
  assert.match(source, /const markers = await markerSnapshot\(driver\)/);
  assert.match(source, /\[\.\.\.lineage\]\.every\(id => markers\[id\] === undefined\)/);
  assert.match(source, /targetActivationCount\(beforeMonitor, afterMonitor, initialIds\)/);
  assert.match(source, /state: failed > 0 \? \(success > 0 \? 'partial' : 'failed'\) : 'complete'/);
  assert.match(source, /retainedFrozen:\s*settled\.disposition === 'retained-frozen' \? 1 : 0/);
  assert.match(source, /scope\.retainedFrozen === scope\.expectedRoles\.filter/);
  assert.match(source, /scope\.releaseProgress\?\.state === \(scope\.retainedFrozen > 0/);
  assert.match(source,
    /phase\.releaseProgress\?\.summary\?\.failed === phase\.retainedFrozen/);
  assert.match(source,
    /phase\.releaseProgress\?\.state === \(phase\.retainedFrozen > 0 \? 'failed' : 'complete'\)/);
  assert.match(source, /report\.releaseCapability = \{/);
  assert.match(source, /capabilityLimitation: retainedFrozen > 0 \? RETAINED_FROZEN_LIMITATION : null/);
  assert.match(source, /report\.releaseCapability\.total === 15/);
  assert.doesNotMatch(source, /stableLoaded/);
});

test('direct-native Edge report and cleanup omit browser identities and local paths', () => {
  const unsafe = [
    path.resolve('e2e', '.profiles', 'edge-direct-native-races-123-456'),
    'C:\\Users\\alice\\private',
    'edge-extension://abcdefghijklmnopabcdefghijklmnop/data/options/index.html',
    'http://127.0.0.1:4567/fixture?case=secret',
    '{"tabId":42,"windowId":7,"targetId":"secret"}',
    'tab with id 998877 window: 776655'
  ].join(' ');
  const safe = harness.safeMessage(unsafe);
  assert.doesNotMatch(safe,
    /Users\\alice|abcdefghijklmnop|127\.0\.0\.1:4567|"tabId":42|secret"|998877|776655/);
  assert.match(safe, /<isolated-profile>|<workspace>/);
  assert.match(safe, /extension:\/\/<redacted>/);
  assert.match(source, /findCrashCount\(profile\)/);
  assert.match(source, /terminateBrowser\(launched\.child, launched\.raw\)/);
  assert.match(source, /safeProfile\(profileRoot, profile\)/);
  assert.match(source, /profileRemoved/);
  assert.match(source, /fixtureStopped/);
  assert.ok(source.indexOf('terminateBrowser(launched.child, launched.raw)') <
    source.indexOf('await fixture.stop()'), 'browser exits before the fixture server closes');
  assert.match(source, /JSON\.stringify\(sanitize\(report\)/);
  assert.match(source, /child\.exitCode === 0 && child\.signalCode === null/);
});

test('strict release gate digest-binds the exact direct-native matrices and cleanup', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const start = gate.indexOf("id: 'edge-direct-native-races'");
  assert.notEqual(start, -1, 'Edge direct-native release invocation is missing');
  const end = gate.indexOf('}));', start);
  assert.notEqual(end, -1, 'Edge direct-native release invocation is unterminated');
  const block = gate.slice(start, end + 4);

  assert.match(block,
    /script: path\.join\(repositoryRoot, 'e2e', 'edge-direct-native-races\.cjs'\)/);
  assert.match(block, /'--allow-edge', '--extension', extractedRoot/);
  assert.match(block,
    /'--profile-root', path\.join\(outputDirectory, 'p', 'ed'\)/);
  assert.match(block,
    /'--results', path\.join\(evidenceRoot, 'edge-direct-native-races'\)/);
  assert.match(block,
    /reportDirectory: path\.join\(evidenceRoot, 'edge-direct-native-races'\)/);
  assert.match(block, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(block, /report\.releaseScopes\?\.length !== 5/);
  assert.match(block, /report\.cancellations\?\.length !== 4/);
  assert.match(block, /report\.workerTermination\?\.length !== 3/);
  assert.match(block, /report\.cleanup\?\.browser\?\.exited !== true/);
  assert.match(block, /report\.cleanup\?\.crashArtifacts !== 0/);
  assert.match(block, /report\.cleanup\?\.crashFree !== true/);
  assert.match(block, /report\.cleanup\?\.profileRemoved !== true/);
  assert.match(block, /report\.cleanup\?\.fixtureStopped !== true/);
  for (const value of [
    'release-window', 'release-rights', 'release-lefts', 'release-other-windows', 'release-tabs',
    'queued', 'pre-native', 'native-pending', 'late-settlement',
    'before-native-invocation', 'during-native-wait', 'after-replacement-settlement'
  ]) {
    assert.match(block, new RegExp(`'${value}'`));
  }
  assert.match(gate, /const exactOrderedReportValues =/);
  assert.ok(gate.indexOf('const extractedRoot =') < start,
    'the direct-native gate must run only after the release artifact is extracted');
  assert.ok(start < gate.indexOf('packageRelease({', start),
    'the direct-native evidence must precede strict final packaging');
});
