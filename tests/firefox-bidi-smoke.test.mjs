import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

import {inspectDirectory} from '../scripts/archive-inventory.mjs';

const require = createRequire(import.meta.url);
const {
  extensionTreeSha256,
  safeProfile,
  sanitizeText
} = require('../e2e/firefox-bidi-smoke.cjs');

test('Firefox smoke sanitizes private paths, extension origins, and fixture identities', () => {
  const source = [
    path.resolve('secret-workspace', 'extension'),
    'C:\\Users\\alice\\private',
    'moz-extension://12345678-1234-1234-1234-123456789abc/data/popup/index.html',
    'http://127.0.0.1:4567/firefox-bidi-smoke/12345678-1234-1234-1234-123456789abc/ordinary',
    'WebDriver BiDi listening on ws://127.0.0.1:9222',
    'incoming connection from 127.0.0.1:9223',
    'Firefox BiDi ordinary 12345678-1234-1234-1234-123456789abc'
  ].join(' ');
  const sanitized = sanitizeText(source);

  assert.doesNotMatch(sanitized, /Users\\alice|moz-extension:\/\/1234|127\.0\.0\.1:\d+|12345678-1234/);
  assert.match(sanitized, /<user-path>|<workspace>/);
  assert.match(sanitized, /moz-extension:\/\/<redacted>/);
  assert.match(sanitized, /<fixture-url>/);
  assert.match(sanitized, /<loopback-url>/);
  assert.match(sanitized, /<loopback-endpoint>/);
  assert.match(sanitized, /Firefox BiDi ordinary <token>/);
});

test('Firefox profile cleanup accepts only named children of the configured root', () => {
  const root = path.resolve('e2e', '.profiles');
  assert.equal(safeProfile(root, path.join(root, 'firefox-bidi-smoke-1')), true);
  assert.equal(safeProfile(root, root), false);
  assert.equal(safeProfile(root, path.resolve(root, '..', 'firefox-bidi-smoke-1')), false);
  assert.equal(safeProfile(root, path.join(root, 'unrelated-profile')), false);
});

test('Firefox evidence uses the canonical archive-inventory tree digest without exposing a path', async () => {
  const extension = path.resolve(import.meta.dirname, '..', 'v3');
  const inventory = await inspectDirectory(extension);
  assert.equal(extensionTreeSha256(extension), inventory.treeSha256);

  const source = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');
  assert.match(source, /treeSha256: extensionTreeSha256\(extension\)/);
  assert.match(source,
    /hash\.update\(entry\.path, 'utf8'\)[\s\S]*hash\.update\('\\0'\)[\s\S]*hash\.update\(entry\.data\)[\s\S]*hash\.update\('\\0'\)/);
  assert.doesNotMatch(source, /extension: \{[^}]*\bpath\s*:/s);
});

test('Firefox smoke source uses raw BiDi, temporary path install, scoped runtime command, and PID-only cleanup', async () => {
  const source = await readFile(new URL('../e2e/firefox-bidi-smoke.cjs', import.meta.url), 'utf8');

  assert.match(source, /new WebSocket\(url\)/);
  assert.match(source, /bidi\.send\('session\.new'/);
  assert.match(source, /bidi\.send\('webExtension\.install'/);
  assert.match(source, /extensionData: \{path: extension, type: 'path'\}/);
  assert.match(source, /'moz:permanent': false/);
  assert.match(source, /manifest\.browser_specific_settings\?\.gecko\?\.id/);
  assert.match(source, /extensionHandle === extensionId/);
  assert.doesNotMatch(source, /c2c003ee-bd69-42a2-b0e9-6f34222cb046/);
  assert.match(source, /'moz:scope': 'chrome'/);
  assert.match(source, /runPopupCommand\(bidi, controllerContext, 'discard-window'\)/);
  assert.match(source, /onSpawn: child =>/);
  assert.match(source, /WebDriver BiDi command timed out/);
  assert.match(source, /summarizePostSettlement/);
  assert.match(source, /extra ordinary navigation, including an aborted reload/);
  assert.match(source, /removeTabs\(bidi, controllerContext/);
  assert.match(source, /ensure\(exited, `The exact Firefox child did not exit/);
  assert.match(source, /\['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.doesNotMatch(source, /taskkill[^\n]+\/IM/i);
});

test('release gate binds Firefox BiDi and Edge frozen evidence to the extracted artifact digest', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const edgeStart = gate.indexOf('const frozenDirectory =');
  const firefoxStart = gate.indexOf("id: 'firefox-bidi-smoke'", edgeStart);
  assert.ok(edgeStart > 0 && firefoxStart > edgeStart, 'browser evidence blocks exist in release order');

  const edgeBlock = gate.slice(edgeStart, firefoxStart);
  const firefoxBlock = gate.slice(firefoxStart, gate.indexOf('for (const result of browserRuns)', firefoxStart));
  assert.match(edgeBlock, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(edgeBlock, /tested tree digest does not match the release artifact/);
  assert.match(firefoxBlock, /report\.extension\?\.treeSha256 !== archiveInventory\.treeSha256/);
  assert.match(firefoxBlock, /tested tree digest does not match the release artifact/);
});
