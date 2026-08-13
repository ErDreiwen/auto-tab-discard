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
});

test('release disabled state and visible focus are semantic', async () => {
  const script = await readFile(new URL('../v3/data/popup/index.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../v3/data/popup/index.css', import.meta.url), 'utf8');
  assert.match(script, /control\.disabled = disabled/);
  assert.match(script, /setAttribute\('aria-disabled', String\(disabled\)\)/);
  assert.match(script, /setAttribute\('aria-label', message\)/);
  assert.match(css, /\[data-cmd\]:focus-visible/);
});
