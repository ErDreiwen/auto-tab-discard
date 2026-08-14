import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const require = createRequire(import.meta.url);
const {
  createEarlyFailureReport,
  loadChromiumPdfFixture,
  nativeMenuDiagnosticsFromOutput,
  runMemoryProbeProcess,
  sanitizePopupReport
} = require('../e2e/popup-matrix.cjs');
const matrixUrl = new URL('../e2e/popup-matrix.cjs', import.meta.url);
const readMatrix = () => readFile(matrixUrl, 'utf8');

test('popup serves Chromium 152 own pinned PDF extension fixture', async () => {
  const pdf = loadChromiumPdfFixture();
  assert.equal(pdf.length, 7984);
  assert.equal(createHash('sha256').update(pdf).digest('hex'),
    '445c238dd59dd707838613744ad06eddec8a6faf4b538cf7f3a3df508c2bdd8a');
  assert.equal(createHash('sha1').update(`blob ${pdf.length}\0`).update(pdf).digest('hex'),
    '8f2eeaf04afccd94651f0c690e154fb12062c630');
  assert.equal(pdf.subarray(0, 9).toString('ascii'), '%PDF-1.3\n');

  const tail = pdf.subarray(-128).toString('ascii');
  const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(tail);
  assert.ok(startxref, 'the pinned fixture must retain its terminal xref declaration');
  const xrefOffset = Number(startxref[1]);
  assert.equal(pdf.subarray(xrefOffset, xrefOffset + 5).toString('ascii'), 'xref\n');

  const source = await readMatrix();
  assert.match(source, /const PDF_FIXTURE = loadChromiumPdfFixture\(\)/);
  assert.match(source,
    /url\.pathname === '\/document\.pdf'[\s\S]*'Content-Type': 'application\/pdf'[\s\S]*response\.end\(PDF_FIXTURE\)/);
  assert.match(source,
    /key: 'restricted-pdf',[\s\S]*scheme: 'pdf',[\s\S]*url: `\$\{fixture\.baseUrl\}\/document\.pdf/);
});

const memoryProbeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    child.signalCode = signal;
    return true;
  };
  child.close = code => {
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  };
  return child;
};

test('popup matrix gives every scoped Shift command a fresh protected loaded fixture', async () => {
  const source = await readMatrix();

  for (const command of [
    'discard-window',
    'discard-rights',
    'discard-lefts',
    'discard-other-windows',
    'discard-tabs'
  ]) {
    assert.match(source, new RegExp(`'${command}': '[^']+'`), `${command} needs a protected fixture key`);
  }
  assert.match(source, /buildScoped\(nextPrefix\(`\$\{command\}-fresh-shift`\)\)/);
  assert.match(source, /chrome\.tabs\.update\(id, \{autoDiscardable: false\}\)/);
  assert.match(source, /protected Shift target must begin loaded/);
  assert.match(source, /protected Shift target must begin autoDiscardable:false/);
  assert.match(source, /protected Shift target must begin unowned/);
  assert.match(source, /shiftFixtureStartedLoadedAndProtected: true/);
});

test('popup matrix asserts repeat visual stability and release visual cleanup', async () => {
  const source = await readMatrix();

  assert.match(source, /sleep title prefix must appear exactly once/);
  assert.match(source, /ownership marker must confirm favicon preparation/);
  assert.match(source, /ownership marker must retain the configured title indicator/);
  assert.match(source, /ownership marker must confirm complete visual preparation/);
  assert.doesNotMatch(source, /assert\.match\(visual\.favicon, \/\^data:image/);
  assert.match(source, /repeat normal must not mutate/);
  assert.match(source, /repeat Shift must not mutate/);
  assert.match(source, /stale sleep title survived release/);
  assert.match(source, /stale generated sleep favicon survived release/);
  assert.match(source, /fixture favicon was not restored after release/);
  assert.match(source, /disabled repeat must not recreate ownership/);
  assert.match(source, /assertOwnershipKeys\(repeatAfter/);
});

test('popup matrix settles original fixture favicons before external discard', async () => {
  const source = await readMatrix();
  const createWindow = source.slice(
    source.indexOf('const createWindow = async'),
    source.indexOf('const mergeWindow =', source.indexOf('const createWindow = async'))
  );
  const buildGroup = source.slice(
    source.indexOf('const buildGroup = async'),
    source.indexOf('const buildScoped = async', source.indexOf('const buildGroup = async'))
  );

  const faviconReady = createWindow.indexOf("/\\/favicon\\.svg(?:\\?|$)/i.test(tab.favIconUrl || '')");
  const createReturns = createWindow.indexOf('return created;');
  assert.ok(faviconReady > 0 && faviconReady < createReturns,
    'fixture creation must await each original favicon before it can return');
  assert.match(createWindow, /to load with original favicons`, 20000/);

  const createCompletes = buildGroup.indexOf('const primary = await createWindow(entries, \'g-selected\')');
  const externalDiscard = buildGroup.indexOf(
    "await externalDiscard(layout, ['g-external', 'g-out-external'])"
  );
  assert.ok(createCompletes > 0 && createCompletes < externalDiscard,
    'favicon-ready fixture creation must complete before group tabs are externally discarded');
});

test('popup matrix reports replacement evidence without pretending Edge always replaces a tab', async () => {
  const source = await readMatrix();
  const readme = await readFile(new URL('../e2e/README.md', import.meta.url), 'utf8');

  assert.match(source, /replacementEvents\.length \? 'observed-and-asserted' : 'not-observed-by-this-edge-run'/);
  assert.match(source, /must resolve to one current identity/);
  assert.match(source, /must retain both lineage IDs/);
  assert.match(readme, /Edge does not reliably\s+replace a tab in every run/);
  assert.match(readme, /cannot truthfully\s+be fed to a second `discard-tab` popup click/);
  assert.match(readme, /keep `Tab\.favIconUrl` set to the document's original favicon URL/);
  assert.match(readme, /ownership\.visual\.favicon === true/);
});

test('popup matrix drives a real context-menu event and reconciles every restricted scheme capability', async () => {
  const source = await readMatrix();
  const nativeHelper = source.slice(
    source.indexOf('const NATIVE_MENU_TIMEOUT_MS'),
    source.indexOf('const killProcessTreeSync')
  );
  const registrationStart = source.indexOf('const registerNativeContextMenu = async');
  const invokeStart = source.indexOf('const invokeNativeContextMenu = async');
  const invokeEnd = source.indexOf('const assertTakeoverApiOrder', invokeStart);
  const nativeInvocation = source.slice(invokeStart, invokeEnd);

  assert.match(source, /const exactDocumentName = await targetPage\.title\(\)/);
  assert.doesNotMatch(source, /targetPage\.mouse\.click/);
  assert.match(source, /const NATIVE_CONTEXT_MENU_TITLE = 'ZATD E2E Discard Tab'/);
  assert.match(source, /chrome\.contextMenus\.create\(\{\s*contexts: \['page'\],\s*id: 'discard-tab',\s*title/);
  assert.match(source, /\}, NATIVE_CONTEXT_MENU_TITLE\)/);
  assert.ok(registrationStart !== -1 && registrationStart < invokeStart);
  const removeAt = source.indexOf('chrome.contextMenus.removeAll', registrationStart);
  const createAt = source.indexOf('chrome.contextMenus.create', registrationStart);
  const registrationCall = source.indexOf('await registerNativeContextMenu();', invokeEnd);
  const firstScenario = source.indexOf("const name = 'discard-tab';", registrationCall);
  const nativeScenario = source.indexOf("const name = 'discard-tab-native-context-menu';", firstScenario);
  assert.ok(removeAt > registrationStart && removeAt < createAt && createAt < invokeStart,
    'the unique item must be removed/created only by the early registration helper');
  assert.ok(registrationCall > invokeEnd && registrationCall < firstScenario && firstScenario < nativeScenario,
    'registration must complete before scenario 1, well before the native scenario');
  assert.equal((source.match(/await registerNativeContextMenu\(\);/g) || []).length, 1,
    'the unique native item must be registered exactly once');
  assert.match(nativeInvocation,
    /chrome\.contextMenus\.update\('discard-tab', \{\s*contexts: \['page'\],\s*title\s*\}, \(\) =>/);
  assert.doesNotMatch(nativeInvocation, /contextMenus\.(?:removeAll|create)/);
  const updateAt = nativeInvocation.indexOf("chrome.contextMenus.update('discard-tab'");
  const updateSettleAt = nativeInvocation.indexOf('await sleep(NATIVE_MENU_UPDATE_SETTLE_MS)');
  const selectorAt = nativeInvocation.indexOf('nativeSelector = startNativeContextMenuSelector(');
  assert.ok(updateAt > 0 && updateAt < updateSettleAt && updateSettleAt < selectorAt,
    'the exact-ID update callback and bounded native-model settle must precede native input');
  assert.match(source,
    /event: 'native-context-menu-registered',\s*status: 'created'/);
  assert.match(nativeInvocation,
    /event: 'native-context-menu-updated',\s*status: 'verified'/);
  assert.match(nativeInvocation,
    /await sleep\(NATIVE_MENU_UPDATE_SETTLE_MS\);[\s\S]*event: 'native-context-menu-update-settled',\s*status: 'bounded'/);
  assert.match(source,
    /startNativeContextMenuSelector\(\s*NATIVE_CONTEXT_MENU_TITLE,\s*nativeMenuBrowserProcessId,\s*manifest\.name,\s*exactDocumentName\s*\)/);
  assert.doesNotMatch(source,
    /startNativeContextMenuSelector\(\s*NATIVE_CONTEXT_MENU_TITLE, browserProcess\.pid/);
  const selectorStart = source.indexOf('nativeSelector = startNativeContextMenuSelector(');
  const selectorReady = source.indexOf('await nativeSelector.ready', selectorStart);
  const selectorAwait = source.indexOf('await nativeSelector.completion', selectorStart);
  assert.ok(selectorStart !== -1 && selectorStart < selectorReady && selectorReady < selectorAwait,
    'the helper startup handshake must finish before its bounded interaction result is awaited');
  assert.match(source,
    /await nativeSelector\.ready;[\s\S]*event: 'native-context-menu-helper-ready',[\s\S]*await nativeSelector\.completion/);
  assert.match(source, /finally \{\s*try \{\s*await nativeSelector\?\.cancel\(\)/);
  assert.match(source, /const NATIVE_HELPER_STARTUP_TIMEOUT_MS = 30000/);
  assert.match(source, /const NATIVE_HELPER_ACTION_TIMEOUT_MS = 30000/);
  assert.match(source, /const NATIVE_MENU_TIMEOUT_MS = 5000/);
  assert.match(source, /const NATIVE_MENU_SURFACE_PROBE_MS = 1000/);
  assert.match(source, /const NATIVE_MENU_UPDATE_SETTLE_MS = 500/);
  assert.match(source, /const NATIVE_POINTER_TIMEOUT_MS = 2000/);
  assert.match(source, /const NATIVE_FOREGROUND_TIMEOUT_MS = 750/);
  assert.doesNotMatch(source, /NATIVE_FOREGROUND_DWELL_MS/);
  assert.match(source, /const resolveNativeMenuBrowserProcessId = async cdp/);
  assert.match(source, /cdp\.send\('SystemInfo\.getProcessInfo'\)/);
  assert.match(source, /filter\(info => info\?\.type === 'browser'\)/);
  assert.match(source, /filter\(id => Number\.isInteger\(id\) && id > 0\)/);
  assert.match(source, /browserProcessIds\.length !== 1/);
  assert.match(source, /nativeMenuBrowserProcessId = await resolveNativeMenuBrowserProcessId\(cdp\)/);
  assert.match(nativeHelper, /UIAutomationClient/);
  assert.match(nativeHelper, /ControlType\]::MenuItem/);
  assert.match(nativeHelper, /ControlType\]::Menu/);
  assert.match(nativeHelper, /NameProperty/);
  assert.match(nativeHelper, /\$current\.ProcessId/);
  assert.match(nativeHelper, /ParentProcessId/);
  assert.match(nativeHelper, /HashSet\[int\]/);
  assert.match(nativeHelper, /allowed\.Contains/);
  assert.match(nativeHelper, /TreeScope\]::Children/);
  assert.match(nativeHelper, /if \(!\$allowed\.Contains\(\[int\] \$root\.Current\.ProcessId\)\)/);
  assert.match(nativeHelper, /TreeScope\]::Subtree/);
  assert.match(nativeHelper, /TreeScope\]::Subtree,\s*\$nameCondition/);
  assert.match(nativeHelper, /-ceq \$exactName/);
  assert.match(nativeHelper, /\$current\.IsEnabled/);
  assert.match(nativeHelper, /Edge can report an actionable native menu item as offscreen/);
  assert.doesNotMatch(nativeHelper, /!\$current\.IsOffscreen/);
  assert.match(nativeHelper, /\$legacy\.Current\.DefaultAction/);
  assert.match(nativeHelper, /Eliminate non-actionable duplicates\s*# before runtime-ID uniqueness is evaluated/);
  assert.match(nativeHelper, /\$null -eq \$method[\s\S]*continue[\s\S]*\$runtimeId/);
  assert.match(nativeHelper, /\$preferred\[\$runtimeId\] = \$candidate/);
  assert.match(nativeHelper, /\$fallbacks\[\$runtimeId\] = \$candidate/);
  assert.match(nativeHelper, /\$scoped = \$fallbacks\s*if \(\$preferred\.Count -gt 0\) \{\s*\$scoped = \$preferred/);
  assert.match(nativeHelper, /ATD_UIA_EXACT_PARENT_NAME/);
  assert.match(nativeHelper, /ATD_UIA_EXACT_DOCUMENT_NAME/);
  assert.match(nativeHelper, /ATD_UIA_EXACT_DOCUMENT_NAME: exactDocumentName/);
  assert.match(nativeHelper, /\$documentNameCondition/);
  assert.match(nativeHelper, /\$current\.Name -cne \$exactDocumentName/);
  assert.match(nativeHelper, /ControlType\]::Document/);
  assert.match(nativeHelper, /ROLE_SYSTEM_DOCUMENT is the RootWebArea fallback/);
  assert.match(nativeHelper, /\$legacyDocument\.Current\.Role -eq 15/);
  assert.match(nativeHelper, /\$current\.BoundingRectangle/);
  assert.match(nativeHelper, /\$rect\.Width -lt 48 -or \$rect\.Height -lt 48/);
  assert.match(nativeHelper, /\$lastDocumentMatchCount -eq 1/);
  assert.match(nativeHelper, /ambiguous-document-match/);
  assert.match(nativeHelper, /exact-document-not-found/);
  assert.match(nativeHelper, /Top-level window names are never read or emitted/);
  assert.doesNotMatch(nativeHelper, /\$rootCurrent\.Name/);
  assert.match(nativeHelper, /SetForegroundWindow\(IntPtr hWnd\)/);
  assert.match(nativeHelper, /BringWindowToTop\(IntPtr hWnd\)/);
  assert.match(nativeHelper, /AttachThreadInput\(uint idAttach, uint idAttachTo, bool attach\)/);
  assert.match(nativeHelper, /GetForegroundWindow\(\)/);
  assert.match(nativeHelper, /GetWindowThreadProcessId/);
  assert.match(nativeHelper, /IsWindow\(IntPtr hWnd\)/);
  assert.match(nativeHelper, /GetCurrentThreadId\(\)/);
  assert.match(nativeHelper, /SetCursorPos\(int x, int y\)/);
  assert.match(nativeHelper, /GetCursorPos\(out Point point\)/);
  assert.match(nativeHelper, /WindowFromPoint\(Point point\)/);
  assert.match(nativeHelper, /GetAncestor\(IntPtr hWnd, uint flags\)/);
  assert.match(nativeHelper, /private static extern uint SendInput\(uint inputCount, Input\[\] inputs, int inputSize\)/);
  assert.match(nativeHelper, /Input\[\] inputs = new Input\[1\]/);
  assert.match(nativeHelper, /MouseInput \{flags = flags\}/);
  assert.match(nativeHelper, /SendRightButtonDown\(\)[\s\S]*SendMouseInput\(0x0008\)/);
  assert.match(nativeHelper, /SendRightButtonUp\(\)[\s\S]*SendMouseInput\(0x0010\)/);
  assert.match(nativeHelper, /SendInput\(\(uint\) inputs\.Length, inputs, Marshal\.SizeOf\(typeof\(Input\)\)\)/);
  assert.match(nativeHelper, /\$targetWindow = \[IntPtr\]::new\(\[long\] \$documentTarget\.TopLevelHandle\)/);
  assert.match(nativeHelper, /TopLevelProcessId = \[int\] \$rootCurrent\.ProcessId/);
  assert.match(nativeHelper, /!\[AtdNativePointer\]::IsWindow\(\$targetWindow\)/);
  assert.match(nativeHelper, /\$targetThreadId = \[AtdNativePointer\]::GetWindowThreadProcessId\([\s\S]*\$targetWindow, \[ref\] \$targetProcessId\)/);
  assert.match(nativeHelper, /\[int\] \$targetProcessId -ne \[int\] \$documentTarget\.TopLevelProcessId/);
  assert.match(nativeHelper, /!\$allowed\.Contains\(\[int\] \$targetProcessId\)/);
  assert.match(nativeHelper, /document-window-outside-process-scope/);
  assert.match(nativeHelper, /\$foregroundDeadline = \[DateTime\]::UtcNow\.AddMilliseconds\(\$\{NATIVE_FOREGROUND_TIMEOUT_MS\}\)/);
  assert.match(nativeHelper, /\$currentThreadId = \[AtdNativePointer\]::GetCurrentThreadId\(\)/);
  assert.match(nativeHelper, /\$attachedToForeground = \[AtdNativePointer\]::AttachThreadInput\([\s\S]*\$currentThreadId, \$foregroundThreadId, \$true\)/);
  assert.match(nativeHelper, /\$attachedToTarget = \[AtdNativePointer\]::AttachThreadInput\([\s\S]*\$currentThreadId, \$targetThreadId, \$true\)/);
  assert.match(nativeHelper, /\[AtdNativePointer\]::BringWindowToTop\(\$targetWindow\)[\s\S]*\[AtdNativePointer\]::SetForegroundWindow\(\$targetWindow\)/);
  assert.match(nativeHelper, /finally \{[\s\S]*if \(\$attachedToTarget\)[\s\S]*\$currentThreadId, \$targetThreadId, \$false[\s\S]*if \(\$attachedToForeground\)[\s\S]*\$currentThreadId, \$foregroundThreadId, \$false/);
  assert.match(nativeHelper, /while \(\[DateTime\]::UtcNow -lt \$foregroundDeadline\)/);
  assert.match(nativeHelper, /\$foregroundIsExactTarget = \$foregroundWindow -eq \$targetWindow/);
  assert.match(nativeHelper, /if \(!\$foregroundIsExactTarget -or[\s\S]*\[int\] \$foregroundProcessId -ne \[int\] \$targetProcessId -or[\s\S]*!\$allowed\.Contains\(\[int\] \$foregroundProcessId\)\)/);
  assert.doesNotMatch(nativeHelper, /foregroundIsIsolatedBrowser/);
  assert.match(nativeHelper, /exact-document-window-not-foreground/);
  assert.match(nativeHelper, /\$verifiedTargetThreadId = \[AtdNativePointer\]::GetWindowThreadProcessId\([\s\S]*\$targetWindow, \[ref\] \$verifiedTargetProcessId\)/);
  assert.match(nativeHelper, /\[int\] \$verifiedTargetProcessId -ne \[int\] \$targetProcessId/);
  assert.match(nativeHelper, /document-window-became-stale/);
  const foregroundGate = nativeHelper.indexOf("exact-document-window-not-foreground");
  const pointerPosition = nativeHelper.indexOf('[AtdNativePointer]::SetCursorPos');
  const hitTest = nativeHelper.indexOf('$hitWindow = [AtdNativePointer]::WindowFromPoint($pointerPoint)');
  const pointerAttempt = nativeHelper.indexOf("ATD_UIA_POINTER_ATTEMPT:CheckedSendInputHeldRightClick");
  const pointerDown = nativeHelper.indexOf('$sentDownCount = [AtdNativePointer]::SendRightButtonDown()');
  assert.ok(foregroundGate > 0 && foregroundGate < pointerPosition && pointerPosition < hitTest &&
      hitTest < pointerAttempt && pointerAttempt < pointerDown,
    'verified foreground/process scope must precede every pointer input');
  assert.match(nativeHelper, /\$hitRootWindow = \[AtdNativePointer\]::GetAncestor\(\$hitWindow, 2\)/);
  assert.match(nativeHelper, /\$hitRootOwnerWindow = \[AtdNativePointer\]::GetAncestor\(\$hitWindow, 3\)/);
  assert.match(nativeHelper, /GetCursorPos\(\[ref\] \$pointerPoint\)[\s\S]*\$pointerPoint\.x -ne \$clickX[\s\S]*\$pointerPoint\.y -ne \$clickY/);
  assert.match(nativeHelper, /pointer-moved-before-input/);
  assert.match(nativeHelper, /\$hitRootWindow -ne \$targetWindow/);
  assert.match(nativeHelper, /\$hitRootOwnerWindow -ne \$targetWindow/);
  assert.match(nativeHelper, /pointer-hit-test-missed-target/);
  assert.match(nativeHelper, /\$sentDownCount -ne 1/);
  assert.match(nativeHelper, /checked-send-input-down-incomplete/);
  assert.match(nativeHelper, /Start-Sleep -Milliseconds 30[\s\S]*finally \{[\s\S]*\$sentUpCount = \[AtdNativePointer\]::SendRightButtonUp\(\)/);
  assert.match(nativeHelper, /\$sentUpCount -ne 1/);
  assert.match(nativeHelper, /checked-send-input-up-incomplete/);
  assert.match(nativeHelper, /ATD_UIA_POINTER_RESULT:CheckedSendInputHeldRightClick/);
  assert.doesNotMatch(nativeHelper, /mouse_event/);
  for (const status of ['Present', 'Absent', 'Indeterminate']) {
    assert.match(nativeHelper, new RegExp(`ATD_UIA_FIRST_SURFACE_RESULT:${status}`));
    assert.match(nativeHelper, new RegExp(`ATD_UIA_FINAL_SURFACE_RESULT:${status}`));
  }
  assert.match(nativeHelper, /\$surfaceCurrent\.ControlType -eq \$surfaceControlType/);
  assert.match(nativeHelper, /\$allowed\.Contains\(\[int\] \$surfaceCurrent\.ProcessId\)/);
  assert.match(nativeHelper, /\$allowedSurfaceObserved = \$true/);
  assert.match(nativeHelper, /\$firstSurfaceProofIntact -and \$firstSurfaceScanCount -gt 0 -and[\s\S]*!\$allowedSurfaceObserved/);
  assert.match(nativeHelper, /diagnostic evidence only[\s\S]*helper remains single-click/);
  assert.doesNotMatch(nativeHelper, /ATD_UIA_RETRY_RESULT|retryForeground|retryTarget/);
  assert.equal((nativeHelper.match(/\$sentDownCount = \[AtdNativePointer\]::SendRightButtonDown\(\)/g) || []).length, 1,
    'the native helper must emit exactly one checked right-button-down');
  assert.equal((nativeHelper.match(/\$sentUpCount = \[AtdNativePointer\]::SendRightButtonUp\(\)/g) || []).length, 1,
    'the native helper must emit exactly one checked right-button-up');
  assert.match(nativeHelper, /nativeMenuDiagnosticsFromOutput/);
  assert.match(nativeHelper, /error\.nativeMenuDiagnostics = nativeMenuDiagnosticsFromOutput\(output\)/);
  assert.match(source, /rightClickAttempts: selection\.rightClickAttempts/);
  assert.match(source, /lastNativeMenuDiagnostics = error\.nativeMenuDiagnostics/);
  assert.match(source, /event: 'native-context-menu-failed'[\s\S]*\.\.\.lastNativeMenuDiagnostics[\s\S]*reasonCode: publicFailureReason\(error\)/);
  assert.match(source, /catch \(error\) \{\s*runError = error;\s*writeReport\(false, error\)/);
  assert.match(nativeHelper, /pointerMethod/);
  assert.match(nativeHelper, /\$parentNameCondition/);
  assert.match(nativeHelper, /\$current\.Name -cne \$exactParentName/);
  assert.match(nativeHelper, /ExpandCollapsePattern\]::Pattern/);
  assert.match(nativeHelper, /ExpandCollapseState\]::LeafNode/);
  assert.match(nativeHelper, /\$defaultAction -match '\(\?i\)\\b\(expand\|open\|show\)\\b'/);
  assert.match(nativeHelper, /Same-name non-actionable Text descendants are excluded before/);
  assert.match(nativeHelper, /\$lastMatchCount -eq 0 -and !\$exactChildObserved -and !\$parentExpansionAttempted/);
  assert.match(nativeHelper, /\$lastParentMatchCount -eq 1/);
  assert.match(nativeHelper, /ATD_UIA_PARENT_RESULT:/);
  assert.match(nativeHelper, /ambiguous-parent-match/);
  assert.match(nativeHelper, /expanded-parent-child-not-found/);
  assert.match(nativeHelper, /ATD_UIA_EXACT_PARENT_NAME: exactParentName/);
  assert.match(nativeHelper, /parentExpansionMethod/);
  assert.match(nativeHelper, /const startNativeContextMenuSelector/);
  assert.equal((nativeHelper.match(/ATD_UIA_READY:1/g) || []).length, 2,
    'the fixed READY marker must appear once in the helper and once in its controller');
  const nativeTypeLoadedAt = nativeHelper.indexOf("'@", nativeHelper.indexOf('Add-Type -TypeDefinition'));
  const helperReadyAt = nativeHelper.indexOf("[Console]::Out.WriteLine('ATD_UIA_READY:1')");
  const automationWorkAt = nativeHelper.indexOf('$nameCondition =');
  assert.ok(nativeTypeLoadedAt > 0 && nativeTypeLoadedAt < helperReadyAt && helperReadyAt < automationWorkAt,
    'READY must follow all Add-Type work and precede UI Automation polling');
  assert.match(nativeHelper, /const child = spawn\(powershellPath/);
  assert.match(nativeHelper,
    /'-Command',\s*'& \(\[scriptblock\]::Create\(\[Console\]::In\.ReadToEnd\(\)\)\)'/);
  assert.doesNotMatch(nativeHelper, /-EncodedCommand/);
  assert.match(nativeHelper, /shell: false/);
  assert.match(nativeHelper, /stdio: \['pipe', 'pipe', 'ignore'\]/);
  assert.match(nativeHelper, /windowsHide: true/);
  assert.match(nativeHelper, /child\.stdin\.once\('error'/);
  assert.match(nativeHelper, /finishError\('helper-input-failure'\)/);
  assert.match(nativeHelper, /child\.stdin\.end\(NATIVE_MENU_UIA_SCRIPT, 'utf8'\)/);
  assert.match(nativeHelper, /avoids Windows command-line length and quoting limits/);
  assert.match(nativeHelper, /completion\.catch\(\(\) => \{\}\)/);
  assert.match(nativeHelper, /ready\.catch\(\(\) => \{\}\)/);
  assert.match(nativeHelper, /const startActionTimer = \(\) => \{/);
  assert.match(nativeHelper,
    /output\.includes\('ATD_UIA_READY:1'\)[\s\S]*startActionTimer\(\)/);
  assert.match(nativeHelper,
    /startupTimer = setTimeout\(\(\) => \{[\s\S]*finishError\('helper-startup-timeout'\)[\s\S]*\}, NATIVE_HELPER_STARTUP_TIMEOUT_MS\)/);
  assert.match(nativeHelper, /setTimeout\(\(\) => \{[\s\S]*finishError\('bounded-timeout'\)/);
  assert.match(nativeHelper,
    /actionTimer = setTimeout\(\(\) => \{[\s\S]*finishError\('bounded-timeout'\)[\s\S]*\}, NATIVE_HELPER_ACTION_TIMEOUT_MS\)/);
  assert.match(nativeHelper,
    /readyObserved = true;[\s\S]*clearTimeout\(startupTimer\);[\s\S]*actionTimer = setTimeout/);
  assert.match(nativeHelper, /if \(!readyObserved\) \{[\s\S]*helper-startup-failure/);
  assert.match(nativeHelper, /return \{cancel, completion, ready\}/);
  assert.match(nativeHelper, /child\.kill\('SIGKILL'\)/);
  assert.match(nativeHelper, /const cancel = async/);
  assert.match(nativeHelper, /native context-menu selector cleanup timed out/);
  assert.doesNotMatch(nativeHelper, /spawnSync\(powershellPath/);
  assert.match(nativeHelper, /lastMatchCount -eq 1/);
  assert.match(nativeHelper, /ambiguous-exact-match/);
  assert.match(nativeHelper, /InvokePattern/);
  assert.match(nativeHelper, /LegacyIAccessiblePattern/);
  assert.doesNotMatch(nativeHelper,
    /actionTimer = setTimeout\([\s\S]*NATIVE_POINTER_TIMEOUT_MS \+ NATIVE_FOREGROUND_TIMEOUT_MS/);
  assert.match(nativeHelper, /ATD_UIA_ERROR:/);
  assert.match(nativeHelper, /cdp-browser-process-tree/);
  assert.doesNotMatch(nativeHelper, /AppActivate|SendKeys|SendWait|System\.Windows\.Forms/);
  assert.doesNotMatch(nativeHelper, /outcome\.stderr|outcome\.error\?\.message/);
  assert.match(source, /chrome\.contextMenus\.onClicked\.addListener/);
  assert.match(source, /browser-generated chrome\.contextMenus\.onClicked event/);
  assert.match(source, /entryEvent: 'chrome\.contextMenus\.onClicked'/);
  assert.match(source, /name = 'restricted-scheme-bulk-scope'/);
  for (const scheme of ['file', 'data', 'pdf', 'internal', 'extension']) {
    assert.match(source, new RegExp(`scheme: '${scheme}'`), `${scheme} needs a real-browser capability case`);
  }
  assert.match(source, /availability: 'unavailable'/);
  assert.match(source, /requested-scheme-not-preserved/);
  assert.match(source, /target silently disappeared/);
  assert.match(source, /disposition: 'handled'/);
  assert.match(source, /disposition: 'unsupported'/);
  assert.match(source, /\['TAB_DISCARDED', 'TAB_FAILED', 'TAB_UNSUPPORTED'\]/);
  assert.match(source, /every requested scheme must be capability-reported and reconciled/);
});

test('native-menu surface diagnostics expose only fixed sanitized categories', () => {
  const hostile = 'SECRET-CANARY-C:/Users/alice/private.txt';
  assert.deepEqual(nativeMenuDiagnosticsFromOutput([
    hostile,
    'ATD_UIA_POINTER_ATTEMPT:CheckedSendInputHeldRightClick',
    'ATD_UIA_POINTER_RESULT:CheckedSendInputHeldRightClick',
    'ATD_UIA_FIRST_SURFACE_RESULT:Absent',
    'ATD_UIA_FINAL_SURFACE_RESULT:Present'
  ].join('\n')), {
    finalSurface: 'present',
    firstClickSurface: 'absent',
    rightClickAttempts: 1
  });
  assert.deepEqual(nativeMenuDiagnosticsFromOutput(hostile), {
    finalSurface: 'not-observed',
    firstClickSurface: 'not-observed',
    rightClickAttempts: 0
  });
  assert.doesNotMatch(JSON.stringify(nativeMenuDiagnosticsFromOutput(hostile)), /SECRET|Users|private/);
});

test('memory sampler is asynchronous, bounded, stream-capped, and remains strict', async () => {
  const source = await readMatrix();
  const sampler = source.slice(
    source.indexOf('const MEMORY_SAMPLE_TIMEOUT_MS'),
    source.indexOf('const resolveNativeMenuBrowserProcessId')
  );

  assert.match(sampler, /const MEMORY_SAMPLE_TIMEOUT_MS = 30000/);
  assert.match(sampler, /const MEMORY_SAMPLE_OUTPUT_LIMIT_BYTES = 256 \* 1024/);
  assert.match(sampler, /const MEMORY_SAMPLE_TERMINATION_TIMEOUT_MS = 2000/);
  assert.doesNotMatch(sampler, /spawnSync\(/);
  assert.match(sampler, /spawnProcess\(executable, args, \{/);
  assert.match(sampler, /shell: false/);
  assert.match(sampler, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(sampler, /windowsHide: true/);
  assert.match(sampler, /child\.stdout\.on\('data'/);
  assert.match(sampler, /child\.stderr\.on\('data'/);
  assert.match(sampler, /stdoutBytes > outputLimitBytes \|\| stderrBytes > outputLimitBytes/);
  assert.match(sampler, /await terminateProcessTree\(child\.pid\)/);
  assert.match(sampler, /closeConfirmed = await waitForClose\(\)/);
  assert.match(sampler, /memory-probe-cleanup-timeout/);
  assert.match(sampler, /timer = setTimeout\(\(\) => void terminate\('memory-probe-timeout'\), timeoutMs\)/);
  assert.match(sampler, /'-NoProfile',\s*'-NonInteractive',\s*'-Command'/);
  assert.match(sampler, /const outcome = await runMemoryProbeProcess/);
  assert.match(source,
    /assert\.equal\(sample\.available, true, `\$\{label\}: \$\{sample\.error \|\| 'memory sample unavailable'\}`\)/);
  for (const reason of [
    'memory-probe-timeout',
    'memory-probe-output-limit',
    'memory-probe-process-error',
    'memory-probe-process-failed',
    'memory-probe-cleanup-timeout'
  ]) {
    assert.match(source, new RegExp(`'${reason}'`), `${reason} must remain a fixed public category`);
  }
});

test('memory probe process drains split output without blocking the event loop', async () => {
  let child;
  let spawnOptions;
  const probe = runMemoryProbeProcess('unused-memory-probe', ['unused-argument'], {
    spawnProcess(executable, args, options) {
      assert.equal(executable, 'unused-memory-probe');
      assert.deepEqual(args, ['unused-argument']);
      spawnOptions = options;
      child = memoryProbeChild();
      child.pid = 7001;
      return child;
    },
    terminationTimeoutMs: 20,
    timeoutMs: 1000
  });
  let settled = false;
  probe.then(() => settled = true);
  child.stdout.write('{"Id":7,"Working');
  child.stderr.write('bounded diagnostic');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false, 'the pending child must not block or synchronously settle the event loop');
  child.stdout.write('Set64":11}');
  child.close(0);

  assert.deepEqual(await probe, {
    ok: true,
    stdout: '{"Id":7,"WorkingSet64":11}'
  });
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawnOptions.windowsHide, true);
});

test('memory probe timeout and output cap kill the exact tree and await close', async () => {
  for (const scenario of [
    {expected: 'memory-probe-timeout', trigger() {}},
    {expected: 'memory-probe-output-limit', trigger(child) { child.stderr.write('12345'); }}
  ]) {
    let child;
    const terminatedPids = [];
    const probe = runMemoryProbeProcess('unused-memory-probe', [], {
      outputLimitBytes: 4,
      spawnProcess() {
        child = memoryProbeChild();
        child.pid = 7002;
        return child;
      },
      async terminateProcessTree(pid) {
        terminatedPids.push(pid);
        setTimeout(() => child.close(null), 0);
        return true;
      },
      terminationTimeoutMs: 20,
      timeoutMs: 10
    });
    scenario.trigger(child);
    assert.deepEqual(await probe, {ok: false, error: scenario.expected});
    assert.deepEqual(terminatedPids, [7002]);
  }
});

test('memory probe errors and unconfirmed termination settle with fixed reasons', async () => {
  let failedStartChild;
  const failedStart = runMemoryProbeProcess('unused-memory-probe', [], {
    spawnProcess() {
      failedStartChild = memoryProbeChild();
      return failedStartChild;
    },
    terminationTimeoutMs: 10,
    timeoutMs: 1000
  });
  failedStartChild.emit('error', Error('hostile local path and process details'));
  assert.deepEqual(await failedStart, {ok: false, error: 'memory-probe-process-error'});

  let stuckChild;
  let treeAttempts = 0;
  const stuck = runMemoryProbeProcess('unused-memory-probe', [], {
    spawnProcess() {
      stuckChild = memoryProbeChild();
      stuckChild.pid = 7003;
      return stuckChild;
    },
    async terminateProcessTree() {
      treeAttempts += 1;
      return false;
    },
    terminationTimeoutMs: 10,
    timeoutMs: 5
  });
  assert.deepEqual(await stuck, {ok: false, error: 'memory-probe-cleanup-timeout'});
  assert.equal(treeAttempts, 2, 'an unconfirmed direct kill must get one exact-tree fallback');
  assert.deepEqual(stuckChild.killCalls, ['SIGKILL']);

  let nonzeroChild;
  const nonzero = runMemoryProbeProcess('unused-memory-probe', [], {
    spawnProcess() {
      nonzeroChild = memoryProbeChild();
      nonzeroChild.pid = 7004;
      return nonzeroChild;
    },
    timeoutMs: 1000
  });
  nonzeroChild.close(9);
  assert.deepEqual(await nonzero, {ok: false, error: 'memory-probe-process-failed'});
});

test('embedded native-menu UIA helper parses as PowerShell without controlling a browser', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell parser is available only on Windows');
    return;
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) {
    t.skip('Windows PowerShell is unavailable');
    return;
  }

  const source = await readMatrix();
  const embedded = source.match(/const NATIVE_MENU_UIA_SCRIPT = String\.raw`([\s\S]*?)`;\nconst nativeMenuDiagnosticsFromOutput/);
  assert.ok(embedded, 'embedded UIA helper must remain extractable for syntax validation');
  const script = embedded[1]
    .replace('${NATIVE_POINTER_TIMEOUT_MS}', '2000')
    .replace('${NATIVE_FOREGROUND_TIMEOUT_MS}', '750')
    .replace('${NATIVE_MENU_SURFACE_PROBE_MS}', '1000')
    .replace('${NATIVE_MENU_TIMEOUT_MS}', '5000');
  const parser = [
    '$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:ATD_UIA_SCRIPT));',
    '$tokens=$null; $errors=$null;',
    '[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors) | Out-Null;',
    "if ($errors.Count -ne 0) { [Console]::Out.WriteLine('ATD_UIA_PARSE_ERROR'); exit 1 }"
  ].join(' ');
  const outcome = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', parser], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATD_UIA_SCRIPT: Buffer.from(script, 'utf16le').toString('base64')
    },
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(outcome.error, undefined, 'PowerShell parser must finish within its bound');
  assert.equal(outcome.status, 0, 'embedded UIA helper contains invalid PowerShell syntax');
  assert.doesNotMatch(outcome.stdout || '', /ATD_UIA_PARSE_ERROR/);

  const nativePointer = script.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/);
  assert.ok(nativePointer, 'native pointer P/Invoke declaration must remain statically extractable');
  const compiler = [
    '$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:ATD_UIA_CSHARP));',
    'Add-Type -TypeDefinition $source -ErrorAction Stop;',
    "if (-not ('AtdNativePointer' -as [type])) { exit 1 }"
  ].join(' ');
  const compilation = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', compiler], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATD_UIA_CSHARP: Buffer.from(nativePointer[1], 'utf16le').toString('base64')
    },
    timeout: 10000,
    windowsHide: true
  });
  assert.equal(compilation.error, undefined, 'native pointer type compilation must finish within its bound');
  assert.equal(compilation.status, 0,
    'native pointer P/Invoke declarations must compile without invoking user input');

  // Exercise the production stdin transport with the full helper, but
  // fail closed at its first validation before UIA or user32 can be reached.
  const streamed = spawnSync(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATD_UIA_EXACT_DOCUMENT_NAME: 'unused-test-document',
      ATD_UIA_EXACT_MENU_NAME: 'unused-test-item',
      ATD_UIA_EXACT_PARENT_NAME: 'unused-test-parent',
      ATD_UIA_ROOT_PROCESS_ID: '0'
    },
    input: script,
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(streamed.error, undefined, 'streamed helper launch must finish within its bound');
  assert.equal(streamed.status, 20,
    'streamed helper must preserve its fail-closed exit code without touching UIA');
  assert.match(streamed.stdout || '', /ATD_UIA_ERROR:invalid-process-scope/);
  assert.doesNotMatch(streamed.stdout || '', /ATD_UIA_POINTER_RESULT:/);
});

test('popup matrix covers external takeover with favicon-only and combined visual settings', async () => {
  const source = await readMatrix();

  assert.match(source, /name = 'discard-tree-normal-takeover-favicon-only'/);
  assert.match(source, /chrome\.storage\.local\.set\(\{favicon: true, prepends: ''\}\)/);
  assert.match(source, /favicon-only ownership must confirm favicon preparation/);
  assert.match(source, /favicon-only ownership must confirm complete visual preparation/);
  assert.match(source, /favicon-only ownership must not persist a title marker/);
  assert.match(source, /external sleeper must wake exactly once/);
  assert.match(source, /name = 'discard-tree-normal-takeover'/);
  assert.match(source, /assertSleepVisual\(after\.tabs\[key\]/);
});

test('popup matrix cancels a genuinely loading takeover and proves a stable awake dwell', async () => {
  const source = await readMatrix();

  assert.match(source, /name = 'discard-tree-cancel-during-slow-wake'/);
  assert.match(source, /delayNextStopScript\(target\.id\)/);
  assert.match(source, /fixture\.entries\(target\.label\)\[1\]/);
  assert.match(source, /snapshot\.tabs\['g-external'\]\.status === 'loading'/);
  assert.match(source, /locator\('#activity-cancel'\)\.click\(\)/);
  assert.match(source, /snapshot\?\.state === 'cancelled'/);
  assert.match(source, /cancelled target to become stably awake and unowned/);
  assert.match(source, /no delayed document request may start during dwell/);
  assert.match(source, /no delayed loading or rediscard transition may occur during dwell/);
  assert.match(source, /private memory must not keep climbing after cancellation/);
  assert.match(source, /requestDelta: 1/);
});

test('Edge frozen-keeper group-helper evidence is delegated out of the Playwright matrix', async () => {
  const source = await readMatrix();
  const readme = await readFile(new URL('../e2e/README.md', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /discard-tree-default-helper-with-only-frozen-outside-candidates/);
  assert.doesNotMatch(source, /freezeEdgeTabs/);
  assert.doesNotMatch(source, /edge:\/\/discards\//);
  assert.doesNotMatch(source, /Page\.setWebLifecycleState/);
  assert.match(readme, /Edge's frozen-keeper group-helper case is delegated to this raw-CDP smoke/);
  assert.match(readme, /`playwright-debugger-prevents-native-freeze`/);
  assert.match(readme, /Playwright attaches to\s+the matrix fixture renderers/);
  assert.match(readme, /only that harness may report\s+the frozen-keeper helper capability/);
});

test('popup matrix reports sanitize local and process identity at the write boundary', async () => {
  const source = await readMatrix();
  const killHelper = source.slice(
    source.indexOf('const killProcessTreeSync'),
    source.indexOf('const waitForProcessExit')
  );
  const writer = source.slice(
    source.indexOf('const writeReport'),
    source.indexOf('    const worker = await waitFor')
  );

  assert.match(source, /const runId = `matrix-\$\{Date\.now\(\)\}-\$\{crypto\.randomBytes\(4\)/);
  assert.doesNotMatch(source, /process\.pid/);
  assert.match(source, /const reportOmittedKeys = new Set\(\[/);
  for (const key of [
    'executablePath', 'parentProcessId', 'path', 'pid', 'processId', 'processIds',
    'processInfo', 'processes', 'stack', 'stderr', 'stdout'
  ]) {
    assert.match(source, new RegExp(`'${key}'`), `report sanitizer must omit ${key}`);
  }
  assert.match(source, /JSON\.stringify\(sanitizePopupReport\(report\)/);
  assert.match(source, /browser: \{family: allowEdge \? 'edge' : 'chromium', version: browser\.version\(\)\}/);
  assert.match(writer, /error: error \? \{\s*nativeMenu: error\.nativeMenuDiagnostics \|\| lastNativeMenuDiagnostics,\s*reasonCode: publicFailureReason\(error\)\s*\} : undefined/);
  assert.match(writer, /reportFormat: 'sanitized-v1'/);
  assert.doesNotMatch(writer,
    /browser: \{executablePath|\bid: extensionId|\bpath: extensionPath|error\.message|error\.stack|launched\.stderr|\n\s*profile,|\n\s*runId,/);
  assert.doesNotMatch(killHelper, /outcome\.(?:stdout|stderr)|stdout:|stderr:/);
  assert.doesNotMatch(source, /cleanup\.profile = \{path: profile|path: profile|report\.stderr|stderrSuppressed/);
  assert.doesNotMatch(source, /Full failure report|console\.error\(error\.stack/);
  assert.match(source, /cleanup\.profile = \{removed: true, retained: false\}/);
  assert.match(source, /resultFile: path\.basename\(resultPath\)/);
  assert.match(source, /console\.error\(JSON\.stringify\(\{ok: false, reasonCode: publicFailureReason\(error\)\}\)\)/);
});

test('popup matrix shareable reports redact hostile identity, endpoint, path, and secret canaries', () => {
  const canary = 'SECRET-CANARY-50-POPUP-7c2a188e';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const firstTab = 717171;
  const secondTab = 717172;
  const windowId = 818181;
  const groupId = 828282;
  const sanitized = sanitizePopupReport({
    [canary]: `private property ${canary}`,
    id: 'fixture-label-is-not-browser-identity',
    local: String.raw`C:\Users\alice\ATD Private\popup-profile\failure.log`,
    timeline: [{
      addedId: secondTab,
      attemptId: `attempt-${canary}`,
      groupId,
      id: firstTab,
      jobId: 'job-private-identity',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      removedId: firstTab,
      targetIds: [firstTab, secondTab],
      title: `127.0.0.1:9222/tab?token=${canary}#fragment`,
      url: `https://secret.example/private?token=${canary}#fragment`,
      windowId
    }],
    outcomes: {
      [firstTab]: {
        error: new Error(`${canary} /home/alice/private.log PID=919191`),
        tabId: firstTab,
        windowId
      }
    },
    origin: `chrome-extension://${extensionId}/worker/core.mjs`
  });
  const text = JSON.stringify(sanitized);
  const first = sanitized.timeline[0];
  const outcomeKey = Object.keys(sanitized.outcomes)[0];

  assert.equal(sanitized.id, 'fixture-label-is-not-browser-identity');
  assert.equal(first.id, first.removedId);
  assert.equal(first.addedId, first.targetIds[1]);
  assert.equal(first.id, first.targetIds[0]);
  assert.equal(outcomeKey, first.id);
  assert.equal(sanitized.outcomes[outcomeKey].tabId, first.id);
  assert.equal(sanitized.outcomes[outcomeKey].windowId, first.windowId);
  assert.notEqual(first.targetIds[0], first.targetIds[1]);
  for (const forbidden of [
    canary,
    extensionId,
    '127.0.0.1:9222',
    'secret.example',
    String.raw`C:\Users\alice`,
    '/home/alice/private.log',
    '717171',
    '717172',
    '818181',
    '828282',
    '919191',
    '123e4567-e89b-42d3-a456-426614174000'
  ]) {
    assert.equal(text.includes(forbidden), false, `shareable popup report leaked ${forbidden}`);
  }
  assert.match(text, /<tab-id-/);
  assert.match(text, /<window-id-/);
  assert.match(text, /<group-id-/);
  assert.match(text, /<opaque-id-/);
  assert.match(text, /<fixture-url>|<url>/);
  assert.match(text, /<local-path>/);
  assert.match(text, /<secret-canary>/);
});

test('early popup failures have bounded phases and reasons and recursively sanitized diagnostics', () => {
  const secret = 'SECRET-CANARY-50-EARLY-7c2a188e';
  const report = createEarlyFailureReport({
    browserFamily: 'hostile-browser-family',
    cleanup: {
      nested: {
        local: String.raw`C:\Users\alice\ATD Private\popup-profile\failure.log`,
        secret
      }
    },
    crashes: [],
    error: Error(`native context-menu UI Automation failed (attacker-controlled) ${secret}`),
    extension: {
      treeSha256: 'a'.repeat(64),
      version: secret
    },
    fixtureRequests: [{url: `http://127.0.0.1:49152/private?token=${secret}`}],
    phase: String.raw`C:\Users\alice\unbounded-phase`
  });

  assert.deepEqual(report.browser, {family: 'chromium', version: null});
  assert.deepEqual(report.error, {phase: 'startup', reasonCode: 'matrix-invariant-failed'});
  assert.deepEqual(report.timeline, [{
    event: 'early-failure',
    phase: 'startup',
    reasonCode: 'matrix-invariant-failed'
  }]);
  assert.deepEqual(report.scenarios, []);
  assert.equal(report.ok, false);
  assert.equal(report.reportFormat, 'sanitized-v1');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /alice|ATD Private|49152|7c2a188e|attacker-controlled/i);
  assert.match(serialized, /<local-path>|<fixture-url>|<secret-canary>/);
});

test('popup matrix persists exactly one sanitized report at each pre-matrix browser boundary', async () => {
  const source = await readMatrix();
  assert.equal((source.match(/persistEarlyFailureReport\(\{/g) || []).length, 3);
  const startupBoundary = source.slice(
    source.indexOf('fixture = await startFixtureServer()'),
    source.indexOf('let launched;')
  );
  const launchBoundary = source.slice(
    source.indexOf('launched = await launchOverCDP'),
    source.indexOf('const {browser, context} = launched')
  );
  const cdpBoundary = source.slice(
    source.indexOf('cdp = await browser.newBrowserCDPSession()'),
    source.indexOf('const timeline = []')
  );
  assert.match(startupBoundary, /persistEarlyFailureReport\(\{[\s\S]*phase: 'startup'/);
  assert.match(launchBoundary, /persistEarlyFailureReport\(\{[\s\S]*phase: 'browser-launch'/);
  assert.match(cdpBoundary, /persistEarlyFailureReport\(\{[\s\S]*phase: 'cdp-attach'/);
  const earlyReportFactory = source.slice(
    source.indexOf('const createEarlyFailureReport ='),
    source.indexOf('const waitFor =')
  );
  assert.match(earlyReportFactory, /return sanitizePopupReport\(\{/);
  assert.match(earlyReportFactory, /version: null/);
  assert.doesNotMatch(earlyReportFactory, /browser\.version\(/);
});

test('popup matrix reconciles command outcomes across Edge tab replacement lineage', async () => {
  const source = await readMatrix();

  assert.match(source, /const outcomeForTabLineage = \(outcomes, tab\) =>/);
  assert.match(source, /\.\.\.\(tab\.idHistory \|\| \[\]\), tab\.id/);
  assert.match(source, /const outcome = outcomeForTabLineage\(normalOutcomes, tab\)/);
  assert.match(source, /const outcome = outcomeForTabLineage\(forcedOutcomes, tab\)/);
});
