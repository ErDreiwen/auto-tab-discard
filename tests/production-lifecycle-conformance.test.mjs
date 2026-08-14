import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../scripts/production-lifecycle-conformance.mjs', import.meta.url));

const run = async (...args) => {
  const {stderr, stdout} = await execute(process.execPath, [runner, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: 30000,
    windowsHide: true
  });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
};

test('production lifecycle campaign executes real scope, discard, and ownership modules', async () => {
  const report = await run('--scenarios', '24', '--seed', '1347571524');
  assert.deepEqual(report, {
    coverage: {
      activation: 25,
      cleanup: 120,
      close: 24,
      'command-scope': 25,
      replacement: 24,
      restart: 1,
      'storage-failure': 24
    },
    invariants: ['active-safety', 'unique-ownership', 'bounded-operation', 'cleanup'],
    maximumNativeInFlight: 4,
    nativeCalls: 216,
    ok: true,
    productionModules: [
      'v3/worker/core/command-scope.mjs',
      'v3/worker/core/discard.mjs',
      'v3/worker/core/ownership.mjs'
    ],
    scenarioCount: 24,
    seed: 1347571524
  });
  assert.equal(report.productionModules.some(file => file.includes('lifecycle-fuzz-model')), false);
});

test('one production campaign seed is exactly reproducible in isolated worker processes', async () => {
  const args = ['--scenarios', '6', '--seed', '305441741'];
  // Replay is a sequential property. Launching both OS processes together
  // adds host scheduling contention that is outside the generated lifecycle
  // schedule and obscures which isolated replay failed.
  const first = await run(...args);
  const second = await run(...args);
  assert.deepEqual(second, first);
  assert.equal(first.coverage.replacement, 6);
  assert.equal(first.coverage.activation, 7);
  assert.equal(first.coverage['storage-failure'], 6);
});

test('isolated campaign teardown drains delayed lineage reconciliation without stderr',
  {timeout: 30000}, async () => {
    // Every one-scenario campaign includes a real replacement and therefore
    // arms ownership's delayed lineage reconcile. Repeating fresh processes
    // catches the old teardown race where the callback observed deleted chrome.
    for (let replay = 0; replay < 10; replay += 1) {
      const report = await run(
        '--scenarios',
        '1',
        '--seed',
        String(0x1ee7c0de + replay)
      );
      assert.equal(report.ok, true);
      assert.equal(report.coverage.replacement, 1);
      assert.equal(report.coverage.cleanup, 5);
    }
  });
