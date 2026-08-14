import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('every popup action uses a native keyboard-operable control', async () => {
  const html = await readFile(new URL('../v3/data/popup/index.html', import.meta.url), 'utf8');
  const controls = [...html.matchAll(/<([a-z]+)[^>]*\sdata-cmd="([^"]+)"[^>]*>/g)]
    .map(([, tag, command]) => ({command, tag}));
  assert.equal(controls.length, 18);
  for (const {command, tag} of controls) {
    assert.ok(tag === 'button' || tag === 'input' || tag === 'select',
      `${command} must use a native interactive element, got ${tag}`);
  }
  assert.equal(controls.filter(control => control.tag === 'button').every(({command}) =>
    new RegExp(`<button[^>]*type="button"[^>]*data-cmd="${command}"|<button[^>]*data-cmd="${command}"[^>]*type="button"`)
      .test(html)), true);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  for (const id of [
    'activity-diagnostics-toggle', 'activity-diagnostics-copy',
    'activity-diagnostics-download', 'activity-diagnostics-clear'
  ]) {
    assert.match(html, new RegExp(`<button[^>]*type="button"[^>]*id="${id}"|` +
      `<button[^>]*id="${id}"[^>]*type="button"`));
  }
  assert.match(html,
    /id="activity-diagnostics-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="activity-diagnostics-panel"/);
  assert.match(html,
    /id="activity-diagnostics-panel" role="region" aria-labelledby="activity-diagnostics-heading" hidden/);
  assert.match(html,
    /id="activity-diagnostics-heading"[^>]*data-i18n="popup_diagnostics_region"/);
});

test('release disabled state and visible focus are semantic', async () => {
  const script = await readFile(new URL('../v3/data/popup/index.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../v3/data/popup/index.css', import.meta.url), 'utf8');
  assert.match(script, /control\.disabled = disabled/);
  assert.match(script, /setAttribute\('aria-disabled', String\(disabled\)\)/);
  assert.match(script, /setAttribute\('aria-label', message\)/);
  assert.match(script,
    /\[\.\.\.diagnosticsPanel\.querySelectorAll\('button, input, select'\)\]\s*\.includes\(document\.activeElement\)/,
    'focus containment must convert the real-DOM NodeList before using Array.includes');
  assert.doesNotMatch(script, /value\.(?:incidentId|reasonGroups|outcomeGroups)/,
    'diagnostic rendering must accept only the locked worker incident schema');
  assert.match(css, /\[data-cmd\]:focus-visible/);
  assert.match(css, /#activity-diagnostics-log[\s\S]*user-select:\s*text/);
  assert.match(css, /@media \(max-width:\s*377px\)/);
});
