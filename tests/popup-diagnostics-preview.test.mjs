import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const source = fs.readFileSync(fileURLToPath(
  new URL('../e2e/popup-diagnostics-preview.html', import.meta.url)
), 'utf8');
const server = fs.readFileSync(fileURLToPath(
  new URL('../e2e/popup-diagnostics-preview-server.cjs', import.meta.url)
), 'utf8');

test('visual diagnostic fixture uses the production popup stylesheet and exact disclosure contract', () => {
  assert.match(source, /href="\.\.\/v3\/data\/popup\/index\.css"/);
  assert.match(source, /id="activity-diagnostics-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="activity-diagnostics-panel"/);
  assert.match(source, /id="activity-diagnostics-panel" role="region" aria-labelledby="activity-diagnostics-heading"/);
  assert.match(source, /0 succeeded, 19 skipped, 47 failed/);
  assert.match(source, /id="whitelist-layout-preview"/);
  assert.match(source, /<span>Session<\/span>/);
  assert.match(source, /<span>Always<\/span>/);
});

test('preview server is loopback-only and exposes no general filesystem route', () => {
  assert.match(server, /server\.listen\(8765, '127\.0\.0\.1'/);
  assert.match(server, /const routes = new Map\(\[/);
  assert.match(server, /content-security-policy/);
  assert.match(server, /routes\.get\(new URL\(request\.url/);
  assert.doesNotMatch(server, /createReadStream\(request|path\.join\([^\n]*request/);
});

test('visual diagnostic fixture demonstrates grouped fixed causes and a sanitized Minecraft-style log', () => {
  assert.match(source, /native-discard \/ NATIVE_POSTCONDITION_FAILED/);
  assert.match(source, /eligibility \/ PROTECTION_RULE/);
  assert.match(source, /# Auto Tab Discard SANITIZED latest\.log/);
  assert.match(source, /\[AutoTabDiscard\/ERROR\].*event=OUTCOME.*code=TAB_FAILED count=47/);
  assert.doesNotMatch(source, /https?:\/\/|file:\/\/|C:\\Users|tabId|windowId|SECRET/);
});
