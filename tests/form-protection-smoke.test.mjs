import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const formSmoke = require('../e2e/form-protection-smoke.cjs');
const source = await readFile(new URL('../e2e/form-protection-smoke.cjs', import.meta.url), 'utf8');
const helper = await readFile(new URL('../e2e/isolated-chromium.cjs', import.meta.url), 'utf8');

test('form smoke recursively sanitizes every shareable report identity and secret canary', () => {
  const canary = 'SECRET-CANARY-50-FORM-7c2a188e';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const localPath = String.raw`C:\Users\alice\ATD Private\form-profile`;
  formSmoke.registerSensitivePath(localPath);
  const sanitized = formSmoke.sanitizeReport({
    [canary]: `private property ${canary}`,
    cleanup: {
      error: `${canary} at /home/alice/atd/cleanup.log from process id 919191`,
      processId: 919191
    },
    error: new Error(
      `${canary} ${localPath}\\failure.log ` +
      `https://secret.example/form?token=${canary}#fragment ` +
      `chrome-extension://${extensionId}/worker/core.mjs tab id 717171 window ID: 818181 PID=919191`
    ),
    origin: 'http://127.0.0.1:9222',
    outcomes: {
      717171: {tabId: 717171, url: `data:text/html,${canary}?private=yes#fragment`}
    },
    processId: 919191,
    query: `?token=${canary}`,
    targetIds: [717171, 717172],
    windowId: 818181
  });
  const text = JSON.stringify(sanitized);

  for (const forbidden of [
    canary,
    extensionId,
    localPath,
    '/home/alice/atd/cleanup.log',
    'secret.example',
    '127.0.0.1:9222'
  ]) {
    assert.equal(text.includes(forbidden), false, `shareable report leaked ${forbidden}`);
  }
  assert.doesNotMatch(text, /\b(?:717171|717172|818181|919191)\b/);
  assert.doesNotMatch(text, /(?:https?|data|chrome-extension):|[?#](?:token|fragment|private)/i);
  assert.doesNotMatch(text, /failure\.log|cleanup\.log|\.stack/i);
  assert.match(text, /<secret-canary>/);
  assert.match(text, /<local-path>/);
  assert.match(text, /<url>/);
  assert.match(text, /<tab-id-/);
  assert.match(text, /<window-id-/);
  assert.match(text, /<process-id-/);
  assert.equal(sanitized.error.name, 'Error');
});

test('form browser smoke covers every required edit class and clear transition', () => {
  for (const name of [
    'beforeinput-text',
    'paste',
    'cut',
    'select',
    'checkbox',
    'radio',
    'speech',
    'drag-drop',
    'date',
    'color',
    'contenteditable',
    'dynamic-control',
    'shadow-dom'
  ]) {
    assert.match(source, new RegExp(`['"]${name}['"]`), name);
  }
  assert.match(source, /new InputEvent\('input',[\s\S]*?insertFromPaste/);
  assert.match(source, /new InputEvent\('input',[\s\S]*?insertFromDictation/);
  assert.match(source, /new DragEvent\('drop'/);
  assert.match(source, /attachShadow\(\{mode: 'open'\}\)/);
  assert.match(source, /event\.submitter\?\.id === 'prevent-submit'/);
  for (const transition of ['reverted-edit', 'native-reset', 'genuine-submit']) {
    assert.match(source, new RegExp(`label: '${transition}'`), transition);
  }
  assert.match(source, /SUBFRAME_TRANSITION = 'subframe-reverted-edit'/);
  assert.match(formSmoke.fixtureDocument('subframe-reverted-edit'),
    /id="frame-editor"[^>]+src="\/frame\?case=subframe-reverted-edit"/);
  assert.match(formSmoke.subframeDocument('subframe-reverted-edit'),
    /id="frame-text"[^>]+value="saved frame text"/);
  assert.match(source, /input\.fill\('unsaved frame text'\)/);
  assert.match(source, /input\.fill\('saved frame text'\)/);
  assert.match(source, /discarded-after-subframe-revert/);
  assert.match(source, /fixture\.frameCount\(label\), 1/);
});

test('form browser smoke uses the real targeted check and requires precise protected/discarded outcomes', () => {
  assert.match(source, /method: 'run-check-on-action'/);
  assert.match(source, /result\?\.protected\?\.find/);
  assert.match(source, /unsaved form input/i);
  assert.match(source, /result\?\.succeeded\?\.some/);
  assert.match(source, /state\?\.discarded === true && state\.status === 'unloaded'/);
  assert.match(source, /fixture\.submissionCount\(label\), 0/);
  assert.match(source, /fixture\.count\(transition\.label\), 1/);
  assert.match(source, /treeSha256: hashDirectory\(extension\)/);
  assert.match(source, /closeIsolated\(/);
  assert.match(source, /reportFormat: 'sanitized-v1'/);
  assert.match(source, /JSON\.stringify\(sanitizeReport\(report\), null, 2\)/);
});

test('exact-artifact form fallback is proven with optional frame access absent', () => {
  assert.match(source, /manifest\.optional_permissions, \['webNavigation'\]/);
  assert.match(source, /manifest\.permissions\?\.includes\('webNavigation'\), false/);
  assert.match(source,
    /chrome\.permissions\.contains\(\{permissions: \['webNavigation'\]\}, granted =>/);
  assert.match(source, /assert\.equal\(framePermissionGranted, false/);
  assert.match(source, /declaredOptional: true/);
  assert.match(source, /initiallyGranted: framePermissionGranted/);
  assert.match(source, /required: false/);
  assert.doesNotMatch(source, /permissions\.request|permissions\.remove/,
    'the fallback smoke must neither prompt for nor mutate optional permission state');
});

test('isolated Chromium reports use the release artifact tree digest contract', () => {
  const start = helper.indexOf('const hashDirectory = root =>');
  const end = helper.indexOf('\n};', start);
  assert.notEqual(start, -1, 'isolated artifact tree hash is missing');
  assert.notEqual(end, -1, 'isolated artifact tree hash is unterminated');
  const block = helper.slice(start, end + 3);

  assert.match(block, /walkFiles\(root\)\.sort\(\(a, b\) =>/);
  assert.match(block, /Buffer\.compare\(Buffer\.from\(a\.relative\), Buffer\.from\(b\.relative\)\)/);
  assert.match(block,
    /hash\.update\(Buffer\.from\(file\.relative, 'utf8'\)\);[\s\S]*?hash\.update\(Buffer\.from\(\[0\]\)\);[\s\S]*?hash\.update\(bytes\);[\s\S]*?hash\.update\(Buffer\.from\(\[0\]\)\)/);
  assert.doesNotMatch(block, /String\(bytes\.length\)/);
});

test('strict release gate requires Chrome form-protection evidence from the extracted artifact', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const start = gate.indexOf("id: 'chrome-form-protection-smoke'");
  assert.notEqual(start, -1, 'Chrome form-protection release invocation is missing');
  const end = gate.indexOf('}));', start);
  assert.notEqual(end, -1, 'Chrome form-protection release invocation is unterminated');
  const block = gate.slice(start, end + 4);

  assert.match(block, /script: path\.join\(repositoryRoot, 'e2e', 'form-protection-smoke\.cjs'\)/);
  assert.match(block, /'--extension', extractedRoot/);
  assert.match(block,
    /'--profile-root', path\.join\(outputDirectory, 'p', 'cf'\)/);
  assert.match(block, /'--results', path\.join\(evidenceRoot, 'chrome-form-protection'\)/);
  assert.match(block, /reportDirectory: path\.join\(evidenceRoot, 'chrome-form-protection'\)/);
  assert.match(block, /report\.outcome !== 'passed'/);
  assert.match(block, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(block, /report\.cleanup\?\.crashes !== 0/);
  assert.match(block, /report\.cleanup\?\.profileRemoved !== true/);
  assert.match(block, /report\.cleanup\?\.process\?\.exited !== true/);
  assert.match(block, /report\.fixtureStopped !== true/);
  assert.ok(gate.indexOf('const extractedRoot =') < start,
    'the form-protection gate must run only after the release artifact is extracted');
  assert.ok(start < gate.indexOf('packageRelease({', start),
    'the form-protection evidence must precede strict final packaging');
});
