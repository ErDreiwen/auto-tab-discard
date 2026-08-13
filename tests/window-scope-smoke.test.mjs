import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const windowSmoke = require('../e2e/window-scope-smoke.cjs');
const source = await readFile(new URL('../e2e/window-scope-smoke.cjs', import.meta.url), 'utf8');

test('window smoke recursively sanitizes every shareable report identity and secret canary', () => {
  const canary = 'SECRET-CANARY-50-WINDOW-98e24d1a';
  const extensionId = 'ponmlkjihgfedcbaponmlkjihgfedcba';
  const localPath = String.raw`C:\Users\bob\ATD Private\window-profile`;
  windowSmoke.registerSensitivePath(localPath);
  const sanitized = windowSmoke.sanitizeReport({
    [canary]: `private property ${canary}`,
    cleanup: {
      error: `${canary} at /tmp/atd-window/cleanup.log from process id 929292`,
      parentProcessId: 929292
    },
    error: new Error(
      `${canary} ${localPath}\\failure.log ` +
      `https://secret.example/window?token=${canary}#fragment ` +
      `edge-extension://${extensionId}/worker/core.mjs tab 727272 window id 828282 PID: 929292`
    ),
    origin: 'ws://localhost:9333/devtools/browser/private',
    outcomes: {
      727272: {tabId: 727272, url: `file:///home/bob/${canary}.html?private=yes#fragment`}
    },
    processIds: [929292, 929293],
    query: `#fragment-${canary}`,
    targetId: 727272,
    windowIds: [828282, 828283]
  });
  const text = JSON.stringify(sanitized);

  for (const forbidden of [
    canary,
    extensionId,
    localPath,
    '/tmp/atd-window/cleanup.log',
    'secret.example',
    'localhost:9333'
  ]) {
    assert.equal(text.includes(forbidden), false, `shareable report leaked ${forbidden}`);
  }
  assert.doesNotMatch(text, /\b(?:727272|828282|828283|929292|929293)\b/);
  assert.doesNotMatch(text, /(?:https?|wss?|file|edge-extension):|[?#](?:token|fragment|private)/i);
  assert.doesNotMatch(text, /failure\.log|cleanup\.log|\.stack/i);
  assert.match(text, /<secret-canary>/);
  assert.match(text, /<local-path>/);
  assert.match(text, /<url>/);
  assert.match(text, /<tab-id-/);
  assert.match(text, /<window-id-/);
  assert.match(text, /<process-id-/);
  assert.equal(sanitized.error.name, 'Error');
});

test('window scope smoke exercises normal, background, minimized, incognito, and popup windows', () => {
  assert.match(source, /incognitoAccess: true/);
  assert.match(source, /fixtures\.minimized\.windowId, \{state: 'minimized'\}/);
  assert.match(source, /fixtures\.background\.windowId/);
  assert.match(source, /type: label === 'popup' \? 'popup' : 'normal'/);
  assert.match(source, /discard-window/);
  assert.match(source, /discard-other-windows/);
  assert.match(source, /regular command must never cross into the incognito context/);
  assert.match(source, /normal-window command must never touch popup-window tabs/);
  assert.match(source, /rejected popup-window command must have zero tab mutation/);
});

test('window scope smoke reports unavailable app/workspace capabilities without claiming them', () => {
  assert.match(source, /type: 'app'/);
  assert.match(source, /report\.capabilities\.app = \{\s*available: false/);
  assert.match(source, /filter\(key => \/workspace\/i\.test\(key\)\)/);
  assert.match(source, /exposedWindowType: Boolean\(chrome\.windows\.WindowType\?\.WORKSPACE\)/);
  assert.match(source, /available: false,[\s\S]*Chromium exposes no workspace window type/);
  assert.match(source, /scopeTable: \[\]/);
  assert.match(source, /treeSha256: hashDirectory\(extension\)/);
  assert.match(source, /closeIsolated\(/);
  assert.match(source, /reportFormat: 'sanitized-v1'/);
  assert.match(source, /JSON\.stringify\(sanitizeReport\(report\), null, 2\)/);
});

test('strict release gate requires Chrome window-scope evidence from the extracted artifact', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const start = gate.indexOf("id: 'chrome-window-scope-smoke'");
  assert.notEqual(start, -1, 'Chrome window-scope release invocation is missing');
  const end = gate.indexOf('}));', start);
  assert.notEqual(end, -1, 'Chrome window-scope release invocation is unterminated');
  const block = gate.slice(start, end + 4);

  assert.match(block, /script: path\.join\(repositoryRoot, 'e2e', 'window-scope-smoke\.cjs'\)/);
  assert.match(block, /'--extension', extractedRoot/);
  assert.match(block,
    /'--profile-root', path\.join\(outputDirectory, 'profiles', 'chrome-window-scope'\)/);
  assert.match(block, /'--results', path\.join\(evidenceRoot, 'chrome-window-scope'\)/);
  assert.match(block, /reportDirectory: path\.join\(evidenceRoot, 'chrome-window-scope'\)/);
  assert.match(block, /report\.outcome !== 'passed'/);
  assert.match(block, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(block, /report\.cleanup\?\.crashes !== 0/);
  assert.match(block, /report\.cleanup\?\.profileRemoved !== true/);
  assert.match(block, /report\.cleanup\?\.process\?\.exited !== true/);
  assert.match(block, /report\.fixtureStopped !== true/);
  assert.ok(gate.indexOf('const extractedRoot =') < start,
    'the window-scope gate must run only after the release artifact is extracted');
  assert.ok(start < gate.indexOf('packageRelease({', start),
    'the window-scope evidence must precede strict final packaging');
});
