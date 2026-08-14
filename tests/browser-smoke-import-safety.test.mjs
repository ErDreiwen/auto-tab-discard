import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const harnesses = [
  '../e2e/external-api-smoke.cjs',
  '../e2e/form-protection-smoke.cjs',
  '../e2e/window-scope-smoke.cjs'
].map(relative => fileURLToPath(new URL(relative, import.meta.url)));

test('browser smoke harness imports defer Playwright resolution until launch', () => {
  const probe = String.raw`
    const Module = require('node:module');
    const path = require('node:path');
    const originalLoad = Module._load;
    Module._load = function(request) {
      const candidate = String(request);
      if (candidate === 'playwright' || path.basename(candidate) === 'playwright') {
        throw Error('Playwright was resolved during harness import: ' + candidate);
      }
      return originalLoad.apply(this, arguments);
    };
    for (const target of process.argv.slice(1)) require(target);
  `;
  const result = spawnSync(process.execPath, ['-e', probe, ...harnesses], {
    encoding: 'utf8',
    env: {...process.env, NODE_OPTIONS: '', NODE_PATH: ''},
    windowsHide: true
  });
  const diagnostic = [result.error?.stack, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n');

  assert.equal(result.status, 0, diagnostic || `import probe exited with ${result.signal || result.status}`);
});
