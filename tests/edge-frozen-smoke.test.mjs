import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {inspectDirectory} from '../scripts/archive-inventory.mjs';

const require = createRequire(import.meta.url);
const {
  assertExactChildExit,
  classifyCommandFocusState,
  classifyDwellFocusState,
  classifyFocusEvents,
  extensionTreeSha256,
  isExactVisibilityPulse,
  safeMessage,
  safeProfile,
  sanitize,
  summarizeActivity,
  summarizeGroupActivity,
  summarizeGroupSnapshot,
  summarizeSnapshot
} = require('../e2e/edge-frozen-smoke.cjs');

test('Edge smoke tree digest matches the release inventory convention', async () => {
  const extension = fileURLToPath(new URL('../v3/', import.meta.url));
  assert.equal(extensionTreeSha256(extension), (await inspectDirectory(extension)).treeSha256);
});

test('Edge focus evidence distinguishes duplicate notifications from actual transitions', () => {
  assert.deepEqual(classifyFocusEvents([
    {at: 1042, windowId: 7}
  ], 7, true, -1, 1000), {
    actualFocusTransitions: 0,
    ambientFocusLosses: 0,
    browserFocusChanges: 0,
    duplicateFocusedWindowNotifications: 1,
    finalExpectedWindowFocused: true,
    rawFocusEvents: [{
      classification: 'duplicate-expected-window',
      offsetMilliseconds: 42
    }]
  });

  assert.deepEqual(classifyFocusEvents([
    {at: 1010, windowId: -1},
    {at: 1020, windowId: 7}
  ], 7, true, -1, 1000), {
    actualFocusTransitions: 2,
    ambientFocusLosses: 1,
    browserFocusChanges: 2,
    duplicateFocusedWindowNotifications: 0,
    finalExpectedWindowFocused: true,
    rawFocusEvents: [{
      classification: 'focus-lost',
      offsetMilliseconds: 10
    }, {
      classification: 'expected-window-focused',
      offsetMilliseconds: 20
    }]
  });

  const otherWindow = classifyFocusEvents([{at: 1005, windowId: 8}], 7, true, -1, 1000);
  assert.equal(otherWindow.actualFocusTransitions, 1);
  assert.equal(otherWindow.finalExpectedWindowFocused, false);
  assert.equal(otherWindow.rawFocusEvents[0].classification, 'other-window-focused');
});

test('Edge dwell focus distinguishes exact browser focus from ambient OS focus loss', () => {
  const base = {
    currentMatched: true,
    exactNormal: true,
    exactTypeNormal: true,
    lastFocusedIdMatched: true,
    normalWindowCount: 1
  };
  assert.deepEqual(classifyDwellFocusState({
    ...base,
    currentFocused: true,
    exactFocused: true,
    focusedNormalWindowCount: 1,
    lastFocusedFocused: true
  }).focusMode, 'exact-focused');

  const ambient = classifyDwellFocusState({
    ...base,
    currentFocused: false,
    exactFocused: false,
    focusedNormalWindowCount: 0,
    lastFocusedFocused: false
  });
  assert.equal(ambient.valid, true);
  assert.equal(ambient.ambientOsFocusLoss, true);
  assert.equal(ambient.focusMode, 'ambient-os-unfocused');

  assert.equal(classifyDwellFocusState({
    ...base,
    currentFocused: false,
    exactFocused: false,
    focusedNormalWindowCount: 1,
    lastFocusedFocused: false
  }).valid, false, 'another focused Edge window is not ambient OS focus loss');
  assert.equal(classifyDwellFocusState({
    ...base,
    currentFocused: false,
    exactFocused: false,
    focusedNormalWindowCount: 0,
    lastFocusedFocused: false,
    lastFocusedIdMatched: false
  }).valid, false, 'a different last-focused Edge window remains a failure');
  assert.equal(classifyDwellFocusState({
    ...base,
    currentFocused: false,
    currentMatched: false,
    exactFocused: false,
    focusedNormalWindowCount: 0,
    lastFocusedFocused: false
  }).valid, false, 'alarm dwell still requires the exact current window identity');
});

test('Edge command focus accepts only exact focus or one independently proven ambient loss', () => {
  const exactState = {
    currentFocused: true,
    currentMatched: true,
    exactFocused: true,
    exactNormal: true,
    exactTypeNormal: true,
    focusedNormalWindowCount: 1,
    lastFocusedFocused: true,
    lastFocusedIdMatched: true,
    normalWindowCount: 1
  };
  assert.equal(classifyCommandFocusState({
    actualFocusTransitions: 0,
    ambientFocusLosses: 0,
    finalExpectedWindowFocused: true,
    rawFocusEvents: []
  }, exactState).focusMode, 'exact-focused');

  const ambientState = {
    ...exactState,
    currentFocused: false,
    exactFocused: false,
    focusedNormalWindowCount: 0,
    lastFocusedFocused: false
  };
  const ambientSummary = {
    actualFocusTransitions: 1,
    ambientFocusLosses: 1,
    finalExpectedWindowFocused: false,
    rawFocusEvents: [{classification: 'focus-lost'}]
  };
  assert.equal(classifyCommandFocusState(ambientSummary, ambientState).focusMode,
    'ambient-os-unfocused');
  assert.equal(classifyCommandFocusState({
    ...ambientSummary,
    actualFocusTransitions: 2,
    rawFocusEvents: [
      {classification: 'focus-lost'},
      {classification: 'expected-window-focused'}
    ]
  }, exactState).valid, false, 'away-and-return is not ambient loss');
  assert.equal(classifyCommandFocusState(ambientSummary, {
    ...ambientState,
    focusedNormalWindowCount: 1
  }).valid, false, 'another focused Edge window is not ambient loss');
  assert.equal(classifyCommandFocusState(ambientSummary, {
    ...ambientState,
    lastFocusedIdMatched: false
  }).valid, false, 'a different last-focused identity is not ambient loss');

  const coalesced = classifyCommandFocusState(ambientSummary, exactState);
  assert.equal(coalesced.valid, true);
  assert.equal(coalesced.coalescedExactReturn, true);
  assert.equal(coalesced.focusMode, 'coalesced-exact-return');
  assert.equal(classifyCommandFocusState(ambientSummary, {
    ...exactState,
    focusedNormalWindowCount: 2
  }).valid, false, 'two focused normal Edge windows invalidate a coalesced return');
  assert.equal(classifyCommandFocusState(ambientSummary, {
    ...exactState,
    lastFocusedIdMatched: false
  }).valid, false, 'a different live last-focused identity invalidates a coalesced return');
});

test('Edge pulse evidence requires an exact checkpoint-relative visible/hidden pair', () => {
  assert.equal(isExactVisibilityPulse({visibilityTransitions: ['visible', 'hidden']}), true);
  assert.equal(isExactVisibilityPulse({visibilityTransitions: ['hidden', 'visible', 'hidden']}), false);
  assert.equal(isExactVisibilityPulse({visibilityTransitions: ['visible', 'hidden', 'hidden']}), false);
  assert.equal(isExactVisibilityPulse({visibilityTransitions: ['visible']}), false);
  assert.equal(isExactVisibilityPulse(null), false);
});

test('Edge frozen smoke sanitizes paths, origins, fixture identity, and diagnostic tab identity', () => {
  const token = '123e4567-e89b-42d3-a456-426614174000';
  const source = [
    path.resolve('e2e', '.profiles', 'edge-frozen-smoke-123-456'),
    'D:\\private profiles\\edge-frozen-smoke-123-456',
    'C:\\Users\\alice\\private',
    'edge-extension://abcdefghijklmnopabcdefghijklmnop/data/options/index.html',
    `http://127.0.0.1:4567/frozen-smoke/${token}`,
    'CDP listening on ws://127.0.0.1:9222/devtools/browser/secret',
    `last state {"id":71,"tabId":72,"windowId":73,"addedId":74,"removedId":75,"token":"${token}"}`
    ,'Error: tab with id: 998877 did not settle'
  ].join(' ');
  const sanitized = safeMessage(source);

  assert.doesNotMatch(sanitized,
    /Users\\alice|private profiles|edge-extension:\/\/abcdefghijklmnop|127\.0\.0\.1:\d+|123e4567|"id":71|"windowId":73|998877/);
  assert.match(sanitized, /<workspace>|<isolated-profile>/);
  assert.match(sanitized, /extension:\/\/<redacted>/);
  assert.match(sanitized, /<fixture-url>/);
  assert.match(sanitized, /<loopback-url>/);
  assert.match(sanitized, /"id":"<redacted>"/);
  assert.doesNotMatch(JSON.stringify(sanitize({error: source})), /abcdefghijklmnop|123e4567|"id":71/);
});

test('Edge result summaries retain ownership, title, activation, and loading evidence without IDs', () => {
  assert.deepEqual(summarizeSnapshot({
    active: false,
    autoDiscardable: true,
    discarded: true,
    found: true,
    frozen: false,
    id: 91,
    markerState: 'owned',
    ownershipOnlyCurrent: true,
    source: 'self',
    status: 'unloaded',
    titleMarked: true,
    visualComplete: true,
    visualFavicon: true,
    visualPhysicalOnly: false,
    visualRepair: false,
    visualTitle: true,
    visualTitleConfigured: true,
    windowId: 92
  }), {
    active: false,
    autoDiscardable: true,
    discarded: true,
    found: true,
    frozen: false,
    markerState: 'owned',
    ownershipOnlyCurrent: true,
    source: 'self',
    status: 'unloaded',
    titleMarked: true,
    visualComplete: true,
    visualFavicon: true,
    visualPhysicalOnly: false,
    visualRepair: false,
    visualTitle: true,
    visualTitleConfigured: true
  });
  assert.deepEqual(summarizeActivity({
    actualFocusTransitions: 0,
    ambientFocusLosses: 1,
    awakeEpisodes: 1,
    browserFocusChanges: 0,
    duplicateFocusedWindowNotifications: 1,
    driverReactivations: 1,
    eventCount: 4,
    finalExpectedWindowFocused: true,
    focusChanges: 0,
    loadingSignals: 0,
    rawFocusEvents: [{
      classification: 'duplicate-expected-window',
      offsetMilliseconds: 42
    }],
    targetActivations: 1
  }), {
    actualFocusTransitions: 0,
    ambientFocusLosses: 1,
    awakeEpisodes: 1,
    browserFocusChanges: 0,
    duplicateFocusedWindowNotifications: 1,
    driverReactivations: 1,
    eventCount: 4,
    finalExpectedWindowFocused: true,
    focusChanges: 0,
    loadingSignals: 0,
    rawFocusEvents: [{
      classification: 'duplicate-expected-window',
      offsetMilliseconds: 42
    }],
    targetActivations: 1
  });
});

test('Edge cleanup accepts only named profile children and asserts exact graceful and forced exits', () => {
  const root = path.resolve('e2e', '.profiles');
  assert.equal(safeProfile(root, path.join(root, 'edge-frozen-smoke-123-456')), true);
  assert.equal(safeProfile(root, root), false);
  assert.equal(safeProfile(root, path.resolve(root, '..', 'edge-frozen-smoke-123-456')), false);
  assert.equal(safeProfile(root, path.join(root, 'edge-frozen-smoke-123-456-extra')), false);
  assert.equal(safeProfile(root, path.join(root, 'unrelated-profile')), false);

  assert.doesNotThrow(() => assertExactChildExit({code: 0, signal: null}, false, 'win32'));
  assert.doesNotThrow(() => assertExactChildExit({code: 1, signal: null}, true, 'win32'));
  assert.doesNotThrow(() => assertExactChildExit({code: null, signal: 'SIGKILL'}, true, 'linux'));
  assert.throws(() => assertExactChildExit({code: 0, signal: null}, true, 'win32'), /forced/i);
  assert.throws(() => assertExactChildExit({code: 1, signal: null}, false, 'win32'), /graceful/i);
  assert.throws(() => assertExactChildExit(null, false, 'win32'), /did not exit/i);
});

test('Edge smoke uses a real automatic alarm for combined and favicon-only frozen takeovers', async () => {
  const source = await readFile(new URL('../e2e/edge-frozen-smoke.cjs', import.meta.url), 'utf8');
  const driverBoundary = source.indexOf('const driverSession =');
  const groupBoundary = source.indexOf(
    "const name = 'discard-tree-active-group-helper-with-direct-native-frozen-child'"
  );
  const alarmSource = source.slice(0, groupBoundary);

  assert.ok(driverBoundary > 0, 'stable extension-page driver session is declared');
  assert.match(source, /const workerSession = await attachPage\(cdp, extensionTarget\.targetId\)/);
  assert.match(source, /message\.sessionId !== workerSession[\s\S]*auto-tab-discard\/pulse-evidence/);
  assert.doesNotMatch(source.slice(driverBoundary, groupBoundary),
    /evaluate\(cdp, workerSession/);
  assert.match(source.slice(driverBoundary), /evaluate\(cdp, driverSession, monitorInstallExpression\)/);
  assert.match(source.slice(driverBoundary), /evaluate\(cdp, driverSession, `\(\(\) => \{[\s\S]*chrome\.alarms\.onAlarm\.addListener/);
  assert.match(source.slice(driverBoundary), /scenario\.controlWindowClosed = true;[\s\S]*evaluate\(cdp, driverSession, monitorCheckpointExpression\)/);
  assert.match(source, /chrome\.alarms\.onAlarm\.addListener\(alarm => monitor\.events\.push/);
  assert.match(source, /chrome\.alarms\.create\('number\.check', \{when: Date\.now\(\) \+ 500\}\)/);
  assert.match(source, /trigger: 'chrome\.alarms\.onAlarm'/);
  assert.match(source, /numberAlarmEvents\.length === 1/);
  assert.match(source, /alarmEventsAfterDwell[\s\S]*length === 1/);
  assert.ok(groupBoundary > driverBoundary, 'group helper phase follows both alarm scenarios');
  assert.match(alarmSource, /cmd: 'discard-tabs',[\s\S]*tabId: \$\{Number\(driverId\)\}[\s\S]*TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE/);
  assert.match(alarmSource, /scenario\.repeat = \{[\s\S]*response: \{[\s\S]*apiError:[\s\S]*completed:[\s\S]*outcomes: repeatOutcomes/);
  assert.match(source, /audio: false,[\s\S]*favicon: true,[\s\S]*form: false,[\s\S]*'max\.single\.discard': 1,[\s\S]*number: 0,[\s\S]*period: 0/);
  assert.match(source, /key: 'combined',[\s\S]*titleExpected: true/);
  assert.match(source, /key: 'favicon-only',[\s\S]*titleExpected: false/);
  assert.match(source, /snapshot\.visualComplete === false[\s\S]*snapshot\.visualFavicon === false[\s\S]*snapshot\.visualPhysicalOnly === true[\s\S]*snapshot\.visualRepair === false[\s\S]*snapshot\.visualTitle === false[\s\S]*snapshot\.visualTitleConfigured === mode\.titleExpected/);
  assert.match(source, /frozen\.active === false && frozen\.autoDiscardable !== false && frozen\.status === 'complete'/);
  assert.match(source, /dataset\.autoTabDiscardPulseEvidence/);
  assert.match(source, /chrome\.windows\.getCurrent\(\)/);
  assert.match(source, /chrome\.windows\.getLastFocused\(\)/);
  assert.match(source, /waitForFocusedWindowSettlement[\s\S]*stableMilliseconds >= FOCUS_SETTLE_MS/);
  assert.match(source, /Target\.activateTarget', \{[\s\S]*targetId: driverTarget\.targetId[\s\S]*activation focus verification[\s\S]*setupFocusCheckpoint[\s\S]*waitForFocusedWindowSettlement[\s\S]*settledFocusCheckpoint/);
  assert.match(source, /scenario\.fixture\.setupFocus = \{[\s\S]*browserTargetActivated: true,[\s\S]*confirmed: true,[\s\S]*requested: false/);
  assert.match(source, /setupFocusSummary\.otherWindowFocusEvents === 0/);
  assert.match(source, /settledFocusCheckpoint\.focusChanges === settledFocus\.focusChanges/);
  assert.match(source, /pulseCheckpointExpression\(initial\.id\)[\s\S]*freezeClickExpression\(url\)/);
  assert.match(source, /chrome\.windows\.create\(\{[\s\S]*focused: true,[\s\S]*state: 'normal',[\s\S]*type: 'normal',[\s\S]*url:/);
  assert.match(source, /chrome\.windows\.get\(created\.id\)/);
  assert.match(source, /chrome\.tabs\.query\(\{windowId: created\.id\}\)/);
  assert.match(source, /windowId: \$\{Number\(fixtureWindow\.windowId\)\}/);
  assert.match(source, /initial\.id === fixtureWindow\.tabId && initial\.windowId === fixtureWindow\.windowId/);
  assert.match(source, /fixtureWindow\.state === 'normal'[\s\S]*fixtureWindow\.type === 'normal'/);
  assert.doesNotMatch(source, /targetId: fixtureTargetId/);
  assert.match(source, /for \(let index = 0; index < modes\.length; index \+= 1\)[\s\S]*Target\.createTarget', \{[\s\S]*newWindow: true,[\s\S]*url: 'edge:\/\/discards\/'/);
  assert.match(source, /Browser\.getWindowForTarget', \{[\s\S]*targetId: scenarioControlTargetId/);
  assert.match(source, /scenarioControlWindow\?\.windowId[\s\S]*scenarioControlWindow\.windowId > 0/);
  assert.match(source, /Target\.detachFromTarget', \{[\s\S]*sessionId: scenarioDiscardsSession/);
  assert.match(source, /Target\.closeTarget', \{[\s\S]*targetId: scenarioControlTargetId/);
  assert.match(source, /closedControl\?\.success === true/);
  assert.match(source, /targetInfos\.every\(info => info\.targetId !== scenarioControlTargetId\)/);
  assert.match(source, /scenario\.controlWindowClosed = true/);
  assert.match(source, /pulseCheckpointExpression\(initial\.id\)[\s\S]*freezeClickExpression\(url\)[\s\S]*Target\.detachFromTarget[\s\S]*Target\.closeTarget[\s\S]*Target\.activateTarget[\s\S]*const alarmCreated/);
  assert.doesNotMatch(source, /controlTabExpression/);
  assert.doesNotMatch(source, /tab\.url \|\| tab\.pendingUrl[\s\S]*edge:\/\/discards/);
  assert.doesNotMatch(source, /minimizeControlWindowExpression|Browser\.setWindowBounds|controlWindowMinimized/);
  assert.doesNotMatch(source, /const discardsSession|const discardsTargetId|controlCdpWindowId/);
  assert.doesNotMatch(source, /focusWindowExpression|chrome\.windows\.update\([^\n]*focused: true/);
  assert.match(source, /const evaluate = async \(cdp, sessionId, expression, timeout = 15000, stage = 'CDP evaluation'\)/);
  assert.match(source, /`\$\{stage\} timed out`/);
  assert.match(source, /post-control driver target activation timed out/);
  assert.match(source, /activation focus verification/);
  assert.match(source, /API deadline exceeded/);
  assert.match(source, /post-control setup did not preserve the eligible frozen target/);
  assert.match(source, /chrome\.tabs\.update\(driverId, \{active: true\}\)/);
  assert.match(source, /chrome\.tabs\.get\(\$\{Number\(driverId\)\}\)[\s\S]*chrome\.tabs\.get\(\$\{Number\(targetId\)\}\)/);
  assert.match(source, /driverActive: driver\?\.active === true/);
  assert.match(source, /targetActive: target\?\.active === true/);
  assert.match(source, /visibility: document\.visibilityState/);
  assert.match(source, /fixture remained visible before native Freeze/);
  assert.match(source, /nextSignature = `\$\{state\.activations\}:\$\{state\.focusChanges\}`/);
  assert.match(source, /setupBaseline\.activations === settledSetupMonitor\.activations/);
  assert.match(source, /scenario\.fixture\.setupKeeper = \{/);
  assert.match(source, /pulseCheckpointExpression\(initial\.id\)[\s\S]*scenario\.fixture\.setupKeeper = \{/);
  assert.match(source, /__autoTabDiscardPulseCheckpoint/);
  assert.match(source, /pulseCheckpointExpression\(initial\.id\)/);
  assert.match(source, /world: 'MAIN'/);
  assert.match(source, /pulseCheckpoint\.after\.visibilityTransitions\.length === 0/);
  assert.doesNotMatch(alarmSource, /isExactVisibilityPulse\(pulseEvidence\)/);
  assert.match(source, /commandSummary\.focusChanges === 0/);
  assert.match(source, /let focusedWindowId = baselineExpectedWindowFocused/);
  assert.match(source, /event\.windowId === focusedWindowId/);
  assert.match(source, /classification = 'duplicate-expected-window'/);
  assert.match(source, /actualFocusTransitions \+= 1/);
  assert.match(source, /classification = 'focus-lost'/);
  assert.match(source, /classification = 'other-window-focused'/);
  assert.match(source, /offsetMilliseconds: Math\.max\(0, Math\.round\(Number\(event\.at/);
  assert.match(source, /dwellSummary\.actualFocusTransitions === 0/);
  assert.match(source, /dwellSummary\.finalExpectedWindowFocused === true/);
  assert.match(source, /classifiedDwellFocus\.valid === true/);
  assert.match(source, /focusedNormalWindowCount:[\s\S]*lastFocusedIdMatched:[\s\S]*normalWindowCount:/);
  assert.match(source, /commandSummary\.awakeEpisodes === 0 && commandSummary\.loadingSignals === 0/);
  assert.match(source, /commandSummary\.targetActivations === 0 && commandSummary\.driverReactivations === 0/);
  assert.match(source, /repeatSummary\.eventCount === 0[\s\S]*repeatSummary\.targetActivations === 0/);
  assert.match(source, /last state \$\{JSON\.stringify\(observedFinal\)\}/);
  assert.match(source, /RESULT_FILE = 'edge-frozen-smoke\.json'/);
  assert.match(source, /JSON\.stringify\(sanitize\(report\), null, 2\)/);
  assert.match(source, /tree: extensionTree\(extension\)/);
  assert.match(source, /treeSha256: extensionTreeSha256\(extension\)/);
  assert.match(source, /Buffer\.compare\(Buffer\.from\(left\.path\), Buffer\.from\(right\.path\)\)/);
  assert.match(source, /hash\.update\(entry\.path, 'utf8'\)[\s\S]*hash\.update\('\\0'\)[\s\S]*hash\.update\(entry\.data\)[\s\S]*hash\.update\('\\0'\)/);
  assert.match(source, /scenario\.final\.summary = summarizeActivity\(commandSummary\)/);
  assert.match(source, /scenario\.dwell\.summary = summarizeActivity\(dwellSummary\)/);
  assert.match(source, /report\.fixture\.requestCountTotal = fixture\.count\(\)/);
  assert.match(source, /report\.cleanup\.crashFree = crashes === 0/);
  assert.match(source, /ensure\(!fs\.existsSync\(profile\), 'The isolated Edge profile was not removed'\)/);
  assert.match(source, /assertExactChildExit\(result\.exit, result\.forced\)/);
  assert.match(source, /\['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.doesNotMatch(source, /fixture\?\.stop\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(source, /terminateBrowser\([^\n]+\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(source, /taskkill[^\n]+\/IM/i);
});

test('Edge raw-CDP smoke uses the real active group anchor and one default blank helper', async () => {
  const source = await readFile(new URL('../e2e/edge-frozen-smoke.cjs', import.meta.url), 'utf8');
  const groupBoundary = source.indexOf(
    "const name = 'discard-tree-active-group-helper-with-direct-native-frozen-child'"
  );
  const noHelperBoundary = source.indexOf(
    "const name = 'discard-tree-active-group-no-helper-partial-with-direct-native-frozen-child'"
  );
  assert.ok(groupBoundary > 0, 'native-frozen direct group scenario exists');
  assert.ok(noHelperBoundary > groupBoundary,
    'distinct no-helper partial phase follows the default-helper phase');
  const group = source.slice(groupBoundary, noHelperBoundary);

  assert.match(source, /GROUP_FIXTURE_KEYS = \[[\s\S]*'group-out-loaded'[\s\S]*'group-out-external'[\s\S]*'group-keeper'[\s\S]*'group-selected'/);
  assert.match(group, /chrome\.tabs\.group\([\s\S]*targetKeys[\s\S]*chrome\.tabs\.group\([\s\S]*outsideKeys/);
  assert.match(group, /chrome\.tabs\.highlight\(\{windowId: created\.id, tabs: \[selected\.index, outside\.index\]\}\)/);
  assert.match(group, /selectedAfter\?\.active !== true[\s\S]*selectedAfter\?\.highlighted !== true[\s\S]*outsideAfter\?\.active === true[\s\S]*outsideAfter\?\.highlighted !== true/);
  assert.match(group, /preFreezeTopology: \{[\s\S]*outsideActive:[\s\S]*outsideHighlighted:[\s\S]*selectedActive:[\s\S]*selectedHighlighted:/);
  assert.match(group, /chrome\.tabs\.highlight\(\{windowId, tabs: \[selected\.index, outside\.index\]\}\)/);
  assert.doesNotMatch(group, /chrome\.tabs\.update\(outsideId, \{active: true\}\)/);
  assert.match(group, /chrome\.tabs\.discard\(id\)/);
  assert.match(group, /freezeClickExpression\(keeperUrl\)[\s\S]*freezeClickExpression\(frozenTargetUrl\)/);
  assert.match(group, /Target\.detachFromTarget[\s\S]*Target\.closeTarget[\s\S]*groupScenario\.controlWindowClosed = true/);
  assert.match(group, /Target\.activateTarget'[\s\S]*targetId: groupSelectedTarget\.targetId/);
  assert.match(group, /targetId: groupSelectedTarget\.targetId[\s\S]*pre-final-topology monitor checkpoint[\s\S]*final command-root restoration[\s\S]*const noKeeper/);
  assert.match(group, /settledFinalGroupMonitor\.activations === preFinalGroupMonitor\.activations[\s\S]*settledFinalGroupMonitor\.focusChanges === preFinalGroupMonitor\.focusChanges/);
  assert.match(group, /final highlighted command focus baseline/);
  assert.match(group, /method: 'popup',[\s\S]*cmd: 'discard-tree',[\s\S]*tabId:[\s\S]*windowId:/);
  assert.match(group, /groupResponse\.value\?\.state === 'complete'[\s\S]*groupResponse\.value\.completed === 3[\s\S]*groupResponse\.value\.total === 3/);
  assert.match(group, /summary\?\.success === 3[\s\S]*summary\?\.skipped === 0[\s\S]*summary\?\.failed === 0/);
  assert.match(group, /TAB_DISCARDED_VISUAL_UNAVAILABLE/);
  assert.match(group, /candidateCount === 0[\s\S]*helperCount === 0/);
  assert.match(group, /candidateEvidence: \{[\s\S]*knownRoles: noKeeper\.candidateRoles[\s\S]*unknownCount: noKeeper\.unknownCandidateCount/);
  assert.match(source, /roleFor = tab => Object\.keys\(layout\.tabs\)[\s\S]*\|\| 'unknown'/);
  assert.match(group, /snapshot\.helperCount === 1[\s\S]*helper\?\.active === true[\s\S]*helper\.registered === true/);
  assert.match(group, /helperLifecycle\?\.created === 1[\s\S]*helperLifecycle\.current === 1[\s\S]*helperLifecycle\.maxConcurrent === 1/);
  assert.match(group, /finalGroup\.ownershipExact === true[\s\S]*helperRegistryEntryCount === 1[\s\S]*helperTransactionCount === 0[\s\S]*targetGroupCount === 3/);
  assert.match(group, /tab\.titleMarked === !direct[\s\S]*tab\.visualComplete === !direct[\s\S]*tab\.visualPhysicalOnly === direct[\s\S]*tab\.visualRepair === !direct/);
  assert.match(group, /tabs\['group-keeper'\]\.frozen === true[\s\S]*tabs\['group-out-external'\]\.discarded === true/);
  assert.match(group, /group-out-loaded'[\s\S]*indexMatched === true[\s\S]*pinned === false/);
  assert.match(group, /fixture\.count\(key\) === groupBaselineRequests\[key\] \+ \(key === 'group-external' \? 1 : 0\)/);
  assert.match(group, /externalAwakeEpisodes === 1[\s\S]*loadingSignals >= 1[\s\S]*wakeSignals >= 1/);
  assert.match(group, /commandGroupSummary\.helperActivations === 1[\s\S]*selectedActivations === 0[\s\S]*targetActivations === 0/);
  assert.match(group, /afterGroupDwell\.helperCount === 1[\s\S]*dwellHelperLifecycle\.created === 1/);
  assert.match(group, /dwellGroupSummary\.loadingSignals === 0[\s\S]*dwellGroupSummary\.wakeSignals === 0[\s\S]*helperActivations === 0[\s\S]*protectedEventCount === 0/);
  assert.match(group, /actualFocusTransitions === 0[\s\S]*classifiedGroupDwellFocus\.valid === true/);
  assert.match(group, /classifyDwellFocusState\(postDwellGroupFocus, \{[\s\S]*requireCurrentMatched: false/);
  assert.match(group, /classifyCommandFocusState\([\s\S]*postCommandGroupFocus[\s\S]*requireCurrentMatched: false/);
  assert.match(group, /baselineExpectedWindowFocused: groupDwellBaselineFocused/);
  assert.match(group, /finalExpectedWindowFocused === groupDwellBaselineFocused/);
  assert.doesNotMatch(group, /attachPage\(cdp, groupSelectedTarget\.targetId\)/);
  assert.doesNotMatch(group, /fixtureDocumentStateExpression\(groupCreation/);
  assert.doesNotMatch(group, /pulseCheckpointExpression\(groupCreation/);
  assert.match(group, /chrome\.windows\.remove[\s\S]*Object\.keys\(stored\)\.every\(key => !key\.startsWith\('__discardOwnership:tab:'\)\)[\s\S]*group ownership\/helper cleanup did not settle/);
  assert.match(group, /chrome\.windows\.get\([\s\S]*fixture window did not close before helper recovery[\s\S]*import\([\s\S]*worker\/core\/helper-registry\.mjs[\s\S]*helperRegistry\.cleanup\(\)/);
  assert.match(group, /helperRecovery\?\.registryAbsent === true[\s\S]*helperRecovery\.removedCount === 1/);
  assert.match(group, /path: 'production-helper-registry-cleanup'/);
  assert.match(group, /'\.\/plugins\/blank\/core\.js': true/);
  assert.doesNotMatch(group, /'\.\/plugins\/blank\/core\.js': false/);
  assert.doesNotMatch(group, /storage\.session\.remove\('__blankHelperRegistry'\)/);
});

test('Edge raw-CDP smoke proves the no-helper active-root partial contract', async () => {
  const source = await readFile(new URL('../e2e/edge-frozen-smoke.cjs', import.meta.url), 'utf8');
  const phaseBoundary = source.indexOf(
    "const name = 'discard-tree-active-group-no-helper-partial-with-direct-native-frozen-child'"
  );
  assert.ok(phaseBoundary > 0, 'distinct no-helper partial phase exists');
  const phase = source.slice(phaseBoundary);

  assert.match(source, /NO_HELPER_FIXTURE_KEYS = \[[\s\S]*'no-helper-root'[\s\S]*'no-helper-loaded'[\s\S]*'no-helper-frozen'[\s\S]*'no-helper-external'/);
  assert.match(source, /GROUP_FIXTURE_KEYS, \.\.\.NO_HELPER_FIXTURE_KEYS/);
  assert.match(phase, /blankHelper: 'disabled-local-preference'/);
  assert.match(phase, /chrome\.storage\.local\.set\(\{\[key\]: false\}\)/);
  assert.match(phase, /disable blank helper through extension preference/);
  assert.match(phase, /blank\.disable\(\)[\s\S]*release\(\)/);
  assert.match(phase, /live worker did not release the blank-helper interrupt/);
  assert.match(phase, /Target\.getTargets[\s\S]*matches\.length !== 1[\s\S]*sessionId: await attachPage/);
  assert.match(phase, /Runtime\.consoleAPICalled[\s\S]*values\.includes\('blank\.disable is called'\)[\s\S]*blankDisableObserved = true/);
  assert.match(phase, /currentWorker\[0\]\.targetId === noHelperLiveWorkerTargetId[\s\S]*final live blank-helper interrupt fence/);
  assert.match(phase, /finally \{[\s\S]*Target\.detachFromTarget[\s\S]*noHelperLiveWorkerSession/);
  assert.match(phase, /finally \{[\s\S]*previous\.present[\s\S]*chrome\.storage\.local\.set\(\{\[key\]: previous\.value === true\}\)[\s\S]*chrome\.storage\.local\.remove\(key\)/);
  assert.match(phase, /blankHelperPreferenceRestored = true/);

  assert.match(phase, /chrome\.windows\.create\(\{[\s\S]*focused: true[\s\S]*type: 'normal'[\s\S]*url: urls\[orderedKeys\[0\]\]/);
  assert.match(phase, /chrome\.tabs\.group\(\{[\s\S]*tabIds: orderedKeys\.map\(key => tabs\[key\]\.id\)/);
  assert.match(phase, /expectedOwnership: \[[\s\S]*'no-helper-loaded'[\s\S]*'no-helper-frozen'[\s\S]*'no-helper-external'/);
  assert.match(phase, /targets: \[\.\.\.NO_HELPER_FIXTURE_KEYS\]/);
  assert.match(phase, /chrome\.tabs\.discard\(\$\{Number\(noHelperCreation\.tabs\['no-helper-external'\]\.id\)\}\)/);
  assert.match(phase, /freezeClickExpression\(frozenUrl\)/);
  assert.match(phase, /Target\.detachFromTarget[\s\S]*Target\.closeTarget[\s\S]*noHelperScenario\.controlWindowClosed = true/);
  assert.match(phase, /Target\.activateTarget'[\s\S]*targetId: noHelperRootTarget\.targetId/);
  assert.match(phase, /candidateCount === 0[\s\S]*helperCount === 0[\s\S]*targetGroupCount === 4/);

  assert.match(phase, /method: 'popup',[\s\S]*cmd: 'discard-tree',[\s\S]*tabId: \$\{Number\(noHelperLayout\.tabs\['no-helper-root'\]\.id\)\}/);
  assert.match(phase, /state === 'partial'[\s\S]*completed === 4[\s\S]*total === 4/);
  assert.match(phase, /summary\?\.success === 3[\s\S]*summary\?\.skipped === 1[\s\S]*summary\?\.failed === 0/);
  assert.match(phase, /TAB_NO_SAFE_KEEPER'[\s\S]*TAB_DISCARDED'[\s\S]*TAB_DISCARDED_VISUAL_UNAVAILABLE/);
  assert.match(phase, /outcomeByRole\['no-helper-root'\]\?\.code === 'TAB_NO_SAFE_KEEPER'[\s\S]*outcomeByRole\['no-helper-frozen'\]\?\.code ===[\s\S]*'TAB_DISCARDED_VISUAL_UNAVAILABLE'/);
  assert.match(phase, /outcomeByRole,[\s\S]*snapshot: summarizeGroupSnapshot\(responseBoundaryNoHelper\)[\s\S]*takeoverFailureCodes:/);

  assert.match(phase, /root\?\.active === true[\s\S]*root\.discarded === false[\s\S]*root\.markerState === null[\s\S]*root\.source === null/);
  assert.match(phase, /childrenSettled[\s\S]*snapshot\.helperCount === 0/);
  assert.match(phase, /finalNoHelper\.ownershipExact === true[\s\S]*helperRegistryEntryCount === 0[\s\S]*helperTransactionCount === 0/);
  assert.match(phase, /fixture\.count\(key\) === noHelperBaselineRequests\[key\] \+[\s\S]*key === 'no-helper-external' \? 1 : 0/);
  assert.match(phase, /noHelperLifecycle\?\.created === 0[\s\S]*current === 0[\s\S]*maxConcurrent === 0[\s\S]*removed === 0/);
  assert.match(phase, /externalAwakeEpisodes === 1[\s\S]*externalActivations === 0[\s\S]*frozenActivations === 0[\s\S]*loadedActivations === 0[\s\S]*rootActivations === 0[\s\S]*rootEventCount === 0[\s\S]*targetActivations === 0/);

  assert.match(phase, /noHelperDwellSummary\.loadingSignals === 0[\s\S]*wakeSignals === 0[\s\S]*externalAwakeEpisodes === 0[\s\S]*frozenActivations === 0[\s\S]*rootActivations === 0[\s\S]*targetEventCount === 0/);
  assert.match(phase, /classifyDwellFocusState\([\s\S]*postDwellNoHelperFocus[\s\S]*requireCurrentMatched: false/);
  assert.match(phase, /extensionTreeSha256\(extension\) === report\.extension\.treeSha256/);
  assert.match(phase, /treeSha256Verified = true/);
  assert.match(phase, /helperRegistry\.cleanup\(\)[\s\S]*helperRecovery\.removedCount === 0/);
  assert.match(phase, /Object\.keys\(stored\)\.every\(key =>[\s\S]*!key\.startsWith\('__discardOwnership:tab:'\)/);
  assert.doesNotMatch(phase, /storage\.session\.remove\('__blankHelperRegistry'\)/);
});
