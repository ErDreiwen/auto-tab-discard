import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  assertExactChildExit,
  exactResponseSummary,
  safeMessage,
  safeRunRoot,
  sanitize
} = require('../e2e/external-api-smoke.cjs');

test('external API smoke sanitizes local paths, extension identity, fixture identity, and tab IDs', () => {
  const token = '123e4567-e89b-42d3-a456-426614174000';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const source = [
    path.resolve('e2e', '.profiles', 'external-api-smoke-123-456-abcdef12'),
    'D:\\private profiles\\external-api-smoke-123-456-abcdef12',
    'C:\\Users\\alice\\private',
    `chrome-extension://${extensionId}/data/options/index.html`,
    `http://127.0.0.1:4567/external-api-smoke/${token}/eligible`,
    'CDP listening on ws://127.0.0.1:9222/devtools/browser/secret',
    `last state {"id":71,"tabId":72,"windowId":73,"browserContextId":74,"token":"${token}"}`
  ].join(' ');
  const sanitized = safeMessage(source);

  assert.doesNotMatch(sanitized,
    /Users\\alice|private profiles|chrome-extension:\/\/abcdefghijklmnop|127\.0\.0\.1:\d+|123e4567|"id":71|"tabId":72/);
  assert.match(sanitized, /<workspace>|<isolated-run>/);
  assert.match(sanitized, /extension:\/\/<redacted>/);
  assert.match(sanitized, /<fixture-url>/);
  assert.match(sanitized, /<loopback-url>/);
  assert.match(sanitized, /"id":"<redacted>"/);

  const object = sanitize({
    diagnostic: source,
    id: 91,
    nested: {browserContextId: 92, tabId: 93, windowId: 94}
  });
  assert.deepEqual({
    id: object.id,
    nested: object.nested
  }, {
    id: '<redacted>',
    nested: {
      browserContextId: '<redacted>',
      tabId: '<redacted>',
      windowId: '<redacted>'
    }
  });
  assert.doesNotMatch(JSON.stringify(object), /abcdefghijklmnop|123e4567|"tabId":93/);
});

test('external API result summaries keep exact dispositions but omit caller tab identity', () => {
  const summarized = exactResponseSummary({
    ok: true,
    outcomes: [
      {code: 'DISCARDED', status: 'succeeded', tabId: 101},
      {code: 'PROTECTED', status: 'skipped', tabId: 102},
      {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: 103}
    ],
    summary: {failed: 0, skipped: 2, succeeded: 1, total: 3}
  }, ['eligible', 'protected', 'active']);

  assert.deepEqual(summarized, {
    errorCode: null,
    ok: true,
    outcomes: [
      {code: 'DISCARDED', label: 'eligible', status: 'succeeded'},
      {code: 'PROTECTED', label: 'protected', status: 'skipped'},
      {code: 'NOT_ELIGIBLE', label: 'active', status: 'skipped'}
    ],
    summary: {failed: 0, skipped: 2, succeeded: 1, total: 3}
  });
  assert.doesNotMatch(JSON.stringify(summarized), /101|102|103|tabId/);
});

test('external API smoke cleanup accepts only its unique child and exact browser exits', () => {
  const root = path.resolve('e2e', '.profiles');
  const child = path.join(root, 'external-api-smoke-123-456-abcdef12');
  assert.equal(safeRunRoot(root, child), true);
  assert.equal(safeRunRoot(root, root), false);
  assert.equal(safeRunRoot(root, path.resolve(root, '..', path.basename(child))), false);
  assert.equal(safeRunRoot(root, `${child}-extra`), false);
  assert.equal(safeRunRoot(root, path.join(root, 'unrelated-profile')), false);

  assert.doesNotThrow(() => assertExactChildExit({code: 0, signal: null}, false, 'win32'));
  assert.doesNotThrow(() => assertExactChildExit({code: 1, signal: null}, true, 'win32'));
  assert.doesNotThrow(() => assertExactChildExit({code: null, signal: 'SIGKILL'}, true, 'linux'));
  assert.throws(() => assertExactChildExit({code: 0, signal: null}, true, 'win32'), /forced/i);
  assert.throws(() => assertExactChildExit({code: 1, signal: null}, false, 'win32'), /graceful/i);
  assert.throws(() => assertExactChildExit(null, false, 'win32'), /did not exit/i);
});

test('external API smoke is a real isolated second-extension gate over the artifact tree', async () => {
  const source = await readFile(new URL('../e2e/external-api-smoke.cjs', import.meta.url), 'utf8');

  assert.match(source, /name: 'ATD isolated external API controller'/);
  assert.match(source, /crypto\.generateKeyPairSync\('rsa'/);
  assert.match(source, /permissions: \['management', 'tabs', 'windows'\]/);
  assert.match(source, /const extensions = \[extension, controller\]\.join\(','\)/);
  assert.match(source, /`--disable-extensions-except=\$\{extensions\}`/);
  assert.match(source, /`--load-extension=\$\{extensions\}`/);
  assert.match(source, /'--headless=new'/);
  assert.match(source, /Pass --executable with a Chrome-for-Testing executable/);
  assert.match(source, /ensure\(!\/msedge\/i\.test\(path\.basename\(executable\)\)/);
  assert.match(source, /manifest\.manifest_version === 3 && manifest\.background\?\.service_worker/);
  assert.match(source, /treeSha256: hashTree\(extension\)/);
  assert.match(source, /chrome\.management\.getAll\(\)/);
  assert.match(source, /discovery\.controllerId === controller\.id/);
  assert.match(source, /openExtensionDriver\([\s\S]*controller\.id,[\s\S]*'index\.html'/);
  assert.match(source, /chrome\.runtime\.sendMessage\(id, payload, response =>/);

  assert.match(source, /'external\.trusted-ids': \[\]/);
  assert.match(source, /'external\.trusted-ids': \[id\]/);
  assert.match(source, /default-denied-hostile-query/);
  assert.match(source, /default-denied-malformed/);
  assert.match(source, /default-denied-excess-batch/);
  assert.match(source, /default-denied-active-tab/);
  assert.match(source, /default-denied-incognito-tab/);
  assert.match(source, /forced: true,[\s\S]*query: \{active: false, url: '<all_urls>'\}/);
  assert.match(source, /REQUEST_LIMIT \+ 1/);
  assert.match(source, /assert\.deepEqual\(delivery\.response, \{error: \{code: expectedCode\}, ok: false\}/);

  assert.match(source, /developerPrivate\.updateExtensionConfiguration/);
  assert.match(source, /incognitoAccess: true/);
  assert.match(source, /Target\.createBrowserContext/);
  assert.match(source, /Target\.disposeBrowserContext/);
  assert.match(source, /candidate\.incognito === true/);
  assert.match(source, /tab\.active !== true && tab\.incognito !== true|states\.incognito\.incognito === true/);
  assert.match(source, /assert\.deepEqual\(after, before, `\$\{name\} changed tab state`\)/);
  assert.match(source, /assert\.deepEqual\(fixture\.counts\(\), requestsBefore/);
  assert.match(source, /assert\.deepEqual\(events, \[\]/);

  assert.match(source, /allowlisted-hostile-query-rejected/);
  assert.match(source, /allowlisted-malformed-rejected/);
  assert.match(source, /allowlisted-excess-batch-rejected/);
  assert.match(source, /allowlisted-safe-bounded-discard/);
  assert.match(source, /\{code: 'DISCARDED', status: 'succeeded', tabId: ids\.eligible\}/);
  assert.match(source, /\{code: 'NOT_ELIGIBLE', status: 'skipped', tabId: ids\.protected\}/);
  assert.match(source, /summary: \{failed: 0, skipped: 3, succeeded: 1, total: 4\}/);
  assert.match(source, /Object\.keys\(outcome\)\.sort\(\), \['code', 'status', 'tabId'\]/);
  assert.match(source, /The external response reflected sensitive tab or extension data/);
  assert.match(source, /finalState\.eligible\.owner, 'self'/);
  assert.match(source, /finalState\.eligible\.status, 'unloaded'/);
  assert.match(source, /finalState\.eligible\.titleMarked, true/);
  assert.match(source, /finalState\.protected\.discarded, false/);
  assert.match(source, /finalState\.active\.active, true/);
  assert.match(source, /finalState\.incognito\.discarded, false/);

  assert.match(source, /RESULT_FILE = 'external-api-smoke\.json'/);
  assert.match(source, /JSON\.stringify\(sanitize\(report\), null, 2\)/);
  assert.match(source, /response: exactResponseSummary\(delivery\.response, labels\)/);
  assert.match(source, /report\.cleanup\.crashFree = crashes === 0/);
  assert.match(source, /ensure\(!fs\.existsSync\(runRoot\), 'The isolated external API run root was not removed'\)/);
  assert.match(source, /assertExactChildExit\(exit, !graceful\)/);
  assert.match(source, /\['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.doesNotMatch(source, /taskkill[^\n]+\/IM/i);
  assert.doesNotMatch(source, /--allow-edge|popup-matrix|edge-frozen-smoke/);
});

test('strict release gate requires Chrome external API evidence from the extracted artifact', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const start = gate.indexOf("id: 'chrome-external-api-smoke'");
  assert.notEqual(start, -1, 'Chrome external API release invocation is missing');
  const end = gate.indexOf('}));', start);
  assert.notEqual(end, -1, 'Chrome external API release invocation is unterminated');
  const block = gate.slice(start, end + 4);

  assert.match(block, /script: path\.join\(repositoryRoot, 'e2e', 'external-api-smoke\.cjs'\)/);
  assert.match(block, /'--extension', extractedRoot/);
  assert.match(block, /'--profile-root', path\.join\(outputDirectory, 'profiles', 'chrome-external-api'\)/);
  assert.match(block, /'--results', path\.join\(evidenceRoot, 'chrome-external-api'\)/);
  assert.match(block, /reportDirectory: path\.join\(evidenceRoot, 'chrome-external-api'\)/);
  assert.match(block, /report\.outcome !== 'passed'/);
  assert.match(block, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(gate,
    /Chrome artifact-tree popup, external API, form protection, window scope, and upgrade gates were not run: --chrome-executable is required/);
  assert.match(gate, /evidence\.push\(result\.evidence\)/);
  assert.ok(gate.indexOf('const extractedRoot =') < start,
    'the external API gate must run only after the final artifact is extracted');
  assert.ok(start < gate.indexOf('packageRelease({', start),
    'the external API evidence must precede strict final packaging');
});
