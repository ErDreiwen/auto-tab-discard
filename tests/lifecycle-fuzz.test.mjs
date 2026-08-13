import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {
  lifecycleInvariants,
  minimizeLifecycleFailure,
  persistLifecycleFailure,
  replayLifecycleScenario,
  runLifecycleCampaign,
  runLifecycleScenario
} from '../scripts/lifecycle-fuzz-model.mjs';

test('10,000 seeded Chrome lifecycle schedules preserve every declared invariant', () => {
  assert.deepEqual(lifecycleInvariants, [
    'active-safety', 'unique-ownership', 'bounded-operation', 'cleanup'
  ]);
  const outcome = runLifecycleCampaign({
    baseSeed: 0x41544401,
    scenarioCount: 10_000,
    steps: 32
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 2));
  assert.equal(outcome.scenarioCount, 10_000);
  for (const event of [
    'external-discard', 'extension-discard', 'replace', 'activate', 'close', 'restart', 'storage-failure'
  ]) {
    assert.ok(outcome.coverage[event] > 0, `campaign must schedule ${event}`);
  }
});

test('one seed has byte-for-byte deterministic actions and final state', () => {
  const first = runLifecycleScenario(0x1234abcd, {steps: 48});
  const second = runLifecycleScenario(0x1234abcd, {steps: 48});
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

test('failing schedules minimize, persist, and reproduce the exact invariant', async t => {
  const scenario = {
    actions: [
      {active: false, type: 'new-tab'},
      {type: 'run-next-event'},
      {tabId: 100, type: 'corrupt-active-discarded'},
      {type: 'restart'}
    ],
    initialTabs: 2,
    schedulerSeed: 77,
    seed: 991
  };
  let error;
  try {
    replayLifecycleScenario(scenario);
  }
  catch (caught) {
    error = caught;
  }
  assert.equal(error?.invariant, 'active-safety');
  const minimized = minimizeLifecycleFailure(scenario, error.invariant);
  assert.ok(minimized.actions.length < scenario.actions.length);
  assert.throws(() => replayLifecycleScenario(minimized), candidate =>
    candidate.invariant === 'active-safety');

  const directory = await mkdtemp(path.join(tmpdir(), 'atd-fuzz-failure-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const saved = await persistLifecycleFailure({
    directory,
    failure: {
      error: {invariant: error.invariant, message: error.message, snapshot: error.snapshot},
      scenario
    }
  });
  const payload = JSON.parse(await readFile(saved.jsonPath, 'utf8'));
  const command = await readFile(saved.commandPath, 'utf8');
  assert.equal(payload.minimized.seed, 991);
  assert.equal(payload.error.invariant, 'active-safety');
  assert.match(payload.reproduction, /run-lifecycle-fuzz\.mjs --reproduce/);
  assert.equal(command.trim(), payload.reproduction);
  assert.throws(() => replayLifecycleScenario(payload.minimized), candidate =>
    candidate.invariant === payload.error.invariant);
});
