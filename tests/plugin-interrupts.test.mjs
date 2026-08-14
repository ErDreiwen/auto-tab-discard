import test from 'node:test';
import assert from 'node:assert/strict';

import {createInterruptRegistry} from '../v3/worker/core/plugin-interrupts.mjs';

test('releasing a plugin interrupt restores the immutable default', async () => {
  const calls = [];
  const registry = createInterruptRegistry({
    'before-menu-click': async () => calls.push('default')
  });
  const plugin = async () => calls.push('plugin');

  registry.overwrite('before-menu-click', plugin);
  await registry.interrupts['before-menu-click']();
  assert.equal(registry.release('before-menu-click'), true);
  await registry.interrupts['before-menu-click']();

  assert.deepEqual(calls, ['plugin', 'default']);
  assert.notEqual(registry.interrupts['before-menu-click'], plugin);
});

test('interrupt registry rejects unknown overwrite names and ignores unknown releases', () => {
  const registry = createInterruptRegistry({known: () => {}});

  assert.throws(() => registry.overwrite('unknown', () => {}), /unknown or invalid/);
  assert.equal(registry.release('unknown'), false);
});
