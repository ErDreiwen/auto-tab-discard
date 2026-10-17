import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every worker action ingress is connected to the strict diagnostic adapter', async () => {
  const [core, external, menu, number, respond] = await Promise.all([
    source('v3/worker/core.mjs'),
    source('v3/worker/core/external-api.mjs'),
    source('v3/worker/menu.mjs'),
    source('v3/worker/modes/number.mjs'),
    source('v3/worker/core/respond.mjs')
  ]);

  assert.match(menu,
    /contextMenus\.onClicked[\s\S]*?actionDiagnostics\.run\(\{[\s\S]*?source: 'context-menu'/);
  assert.match(menu,
    /action\.onClicked[\s\S]*?actionDiagnostics\.run\(\{[\s\S]*?source: 'toolbar'/);
  assert.match(menu,
    /commands\.onCommand[\s\S]*?actionDiagnostics\.run\(\{[\s\S]*?source: 'keyboard'/);
  assert.match(menu,
    /request\.method === 'popup'[\s\S]*?correlation[\s\S]*?diagnosticCapabilities\.remember[\s\S]*?actionDiagnostics\.run/);
  assert.match(menu,
    /request\.method === 'popup-progress-cancel'[\s\S]*?cancelPopupProgressWithDiagnostics\(\{/);
  // A command may activate a keeper, so cancel must not pin the popup's opening tab.
  assert.match(menu,
    /request\.method === 'popup-progress-cancel'[\s\S]*?popupAuthorization\(\{\.\.\.request, tabId: undefined\}, sender\)[\s\S]*?job\.windowId !== authorized\.windowId/);
  assert.match(menu,
    /job\.jobId !== request\.jobId[\s\S]*?job\.privateContext !== \(tab\.incognito === true\)/);
  assert.match(menu,
    /request\.method === 'run-check-on-action'[\s\S]*?validatePopupTargetIds\(request\.ids, highlighted\)/);
  assert.match(menu,
    /request\.method === 'diagnostic-event'[\s\S]*?ingestDiagnosticEvent/);
  assert.match(menu,
    /const committed = await actionDiagnostics\.event\(projected\)[\s\S]*?if \(!committed\)/);
  assert.match(menu,
    /diagnosticCapabilities\.resolve\(correlation\)[\s\S]*?terminalDiagnosticResponse/);
  assert.match(menu,
    /request\.method === 'conflict-scan'[\s\S]*?runConflictScanEndpoint\(\{[\s\S]*?signalCodes: Object\.values\(CONFLICT_SIGNALS\)/);
  assert.match(menu,
    /scan: \(\{privateContext\}\) => conflictScanner\.scan\(\{privateContext\}\)/);
  assert.match(menu,
    /\['close', 'move-next', 'move-previous'\]\.includes\(request\.method\)[\s\S]*?popupNavigationAuthorization\(request, sender\)[\s\S]*?privateContext: tab\.incognito === true[\s\S]*?handleNavigation\(authorized\.method/);
  assert.match(menu,
    /const runNavigationAction[\s\S]*?result === false \? \{code: 'NO_CHANGE'\} : result/);

  assert.match(core, /type: 'worker-start'/);
  assert.match(core, /method === 'discard\.on\.load'[\s\S]*?source: 'runtime'/);
  assert.match(core, /method === 'reset'[\s\S]*?type: 'reset-start'[\s\S]*?type: 'reset-end'/);
  assert.match(core,
    /method === 'reset'[\s\S]*?authorizeOptionsPageRequest\(sender[\s\S]*?correlation[\s\S]*?privateContext/);
  assert.match(core, /method === 'storage'[\s\S]*?phase: 'storage'/);
  assert.match(core, /command: 'startup-recovery'[\s\S]*?command: 'takeover-recovery'/);

  assert.match(number, /source: 'automatic-alarm'/);
  assert.match(number, /source: resume \? 'automatic-startup' : 'settings'/);
  assert.match(number, /diagnostic\?\.retry\([\s\S]*?METADATA_CHECK_FAILED/);
  assert.match(number, /diagnostic\?\.timeout\([\s\S]*?phase: 'metadata-check'/);
  assert.match(external, /onMessageExternal[\s\S]*?command: 'external-discard'[\s\S]*?source: 'external'/);

  assert.match(respond, /sender\?\.url === expectedOptionsUrl/);
  assert.match(respond, /if \(!trustedPopup\) throw Error\('Diagnostic sender is not authorized'\)/);
  assert.match(respond, /page-supplied `diagnostic` property is deliberately never forwarded/);
});

test('diagnostic call sites never pass browsing identity or free-form error fields', async () => {
  const adapter = await source('v3/worker/core/action-diagnostics.mjs');
  assert.doesNotMatch(adapter, /projected\.(?:tabId|windowId|url|title|error|reason|preferences|rules)\s*=/);
  assert.match(adapter, /Identifiers are used only as ephemeral de-duplication keys/);
  assert.match(adapter, /privateContext: access\?\.privateContext === true/);
  assert.match(adapter, /\^ATDC-\[A-Z0-9\]\{16,40\}\$/);
});
