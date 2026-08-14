#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  persistLifecycleFailure,
  replayLifecycleScenario,
  runLifecycleCampaign,
  runLifecycleScenario
} from './lifecycle-fuzz-model.mjs';

const options = {};
for (let index = 0; index < process.argv.slice(2).length; index += 2) {
  const name = process.argv.slice(2)[index];
  const value = process.argv.slice(2)[index + 1];
  if (!name?.startsWith('--') || value === undefined) {
    throw new Error('Usage: run-lifecycle-fuzz.mjs [--scenarios N] [--seed N] [--steps N] [--failure-dir DIR] [--reproduce FILE]');
  }
  options[name.slice(2)] = value;
}

if (options.reproduce) {
  const saved = JSON.parse(await readFile(path.resolve(options.reproduce), 'utf8'));
  const scenario = saved.minimized || saved.scenario;
  try {
    replayLifecycleScenario(scenario);
    process.stdout.write(`${JSON.stringify({ok: true, reproduced: false, seed: scenario.seed}, null, 2)}\n`);
  }
  catch (error) {
    process.stdout.write(`${JSON.stringify({
      invariant: error.invariant || 'unexpected',
      message: error.message,
      ok: false,
      reproduced: true,
      seed: scenario.seed
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
else if (options.seed) {
  const failure = runLifecycleScenario(Number(options.seed), {steps: Number(options.steps || 32)});
  process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
  if (!failure.ok) {
    const persisted = await persistLifecycleFailure({
      directory: path.resolve(options['failure-dir'] || 'build/fuzz-failures'),
      failure
    });
    process.stderr.write(`Persisted minimized failure: ${persisted.jsonPath}\n`);
    process.exitCode = 1;
  }
}
else {
  const outcome = runLifecycleCampaign({
    baseSeed: Number(options['base-seed'] || 0x41544401),
    scenarioCount: Number(options.scenarios || 10_000),
    steps: Number(options.steps || 32)
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (!outcome.ok) {
    const persisted = await persistLifecycleFailure({
      directory: path.resolve(options['failure-dir'] || 'build/fuzz-failures'),
      failure: outcome
    });
    process.stderr.write(`Persisted minimized failure: ${persisted.jsonPath}\n`);
    process.exitCode = 1;
  }
}
