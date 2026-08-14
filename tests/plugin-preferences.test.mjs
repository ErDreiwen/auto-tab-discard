import test from 'node:test';
import assert from 'node:assert/strict';

import {createPluginPreferenceGate} from '../v3/worker/core/plugin-preferences.mjs';

const fakePlugin = calls => ({
  disable: () => calls.push('disable'),
  enable: () => calls.push('enable')
});

test('a live plugin preference change supersedes an older startup snapshot', () => {
  const calls = [];
  const gate = createPluginPreferenceGate({blank: fakePlugin(calls)});
  const startup = gate.snapshot();

  gate.applyChange('blank', false);
  gate.applyStartup(startup, {blank: true});

  assert.deepEqual(calls, ['disable']);
});

test('an unchanged startup snapshot enables configured plugins and ignores unknown keys', () => {
  const calls = [];
  const gate = createPluginPreferenceGate({blank: fakePlugin(calls)});
  const startup = gate.snapshot();

  gate.applyStartup(startup, {blank: true});
  assert.equal(gate.applyChange('unknown', true), false);

  assert.deepEqual(calls, ['enable']);
});
