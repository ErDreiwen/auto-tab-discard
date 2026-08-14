import test from 'node:test';
import assert from 'node:assert/strict';

import {runEntryCommand} from '../v3/worker/core/entry.mjs';

test('non-popup command entry settles success and reports failure without rejecting', async () => {
  const reports = [];
  assert.deepEqual(await runEntryCommand('discard-tabs', async () => 7, value => reports.push(value)), {
    ok: true,
    value: 7
  });
  assert.deepEqual(await runEntryCommand('discard-tabs', async () => {
    throw Error('native discard failed');
  }, value => reports.push(value)), {
    error: 'native discard failed',
    ok: false
  });
  assert.deepEqual(reports, [{command: 'discard-tabs', message: 'native discard failed'}]);
});

test('blocked and partial results surface bounded per-target reasons', async () => {
  const reports = [];
  const blocked = {blocked: true, failed: [], succeeded: []};
  assert.deepEqual(await runEntryCommand('discard-tree', async () => blocked,
    value => reports.push(value)), {
    code: 'TAB_NO_SAFE_KEEPER',
    error: 'command was blocked because no safe keeper was available',
    ok: false,
    value: blocked
  });

  const partial = {
    failed: [
      {tab: {id: 4}, reason: 'native discard rejected'},
      {tab: {id: 5}, reason: 'tab woke'}
    ],
    succeeded: [{tab: {id: 3}}]
  };
  const result = await runEntryCommand('discard-window', async () => partial,
    value => reports.push(value));
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.code, undefined);
  assert.deepEqual(result.reasons, [
    'tab 4: native discard rejected',
    'tab 5: tab woke'
  ]);
  assert.equal(reports.length, 2);

  const many = Array.from({length: 20}, (_, index) => ({tab: {id: index}, reason: `reason-${index}`}));
  const failed = await runEntryCommand('toolbar', async () => {
    const error = Error('aggregate');
    error.result = {failed: many};
    throw error;
  }, value => reports.push(value));
  assert.equal(failed.ok, false);
  assert.equal(failed.reasons.length, 5);
  assert.equal(failed.error.includes('reason-19'), false);
});
