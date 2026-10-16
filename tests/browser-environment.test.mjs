import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {browserEnvironment} = require('../e2e/browser-environment.cjs');

test('browser launches drop an inherited Windows compatibility layer in any case', () => {
  const base = {
    PATH: 'C:\\Windows',
    __COMPAT_LAYER: 'DetectorsAppHealth',
    __compat_layer: 'RunAsInvoker'
  };
  assert.deepEqual(browserEnvironment(base), {PATH: 'C:\\Windows'});
  assert.equal(base.__COMPAT_LAYER, 'DetectorsAppHealth');
});

test('every Edge-capable harness launches its browser without the compatibility layer', async () => {
  for (const name of [
    'popup-matrix.cjs',
    'edge-direct-native-races.cjs',
    'edge-frozen-smoke.cjs',
    'upgrade-rollback-smoke.cjs'
  ]) {
    const harness = await readFile(path.resolve('e2e', name), 'utf8');
    assert.match(harness, /require\('\.\/browser-environment\.cjs'\)/, name);
    assert.match(harness, /env: browserEnvironment\(\)/, name);
  }
});
