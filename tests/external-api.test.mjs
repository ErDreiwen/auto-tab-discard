import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {runScopedCommand} from '../v3/worker/core/command-scope.mjs';
import {
  createExternalDiscardController,
  EXTERNAL_BATCH_LIMIT,
  EXTERNAL_CONCURRENCY_LIMIT,
  EXTERNAL_TRUSTED_IDS_KEY,
  normalizeTrustedIds,
  sanitizeExternalDiscardResult,
  validateExternalDiscardRequest
} from '../v3/worker/core/external-api-policy.mjs';

const TRUSTED = 'abcdefghijklmnopabcdefghijklmnop';
const SECOND_TRUSTED = 'bcdefghijklmnopabcdefghijklmnopa';
const THIRD_TRUSTED = 'cdefghijklmnopabcdefghijklmnopab';
const request = tabIds => ({method: 'discard', tabIds});

test('external request schema accepts only a bounded explicit tab-ID scope', () => {
  const parsed = validateExternalDiscardRequest(request([1, 2, 3]));
  assert.deepEqual(parsed, request([1, 2, 3]));
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.tabIds));

  const invalid = [
    undefined,
    null,
    [],
    'discard',
    {},
    {method: 'release', tabIds: [1]},
    {method: 'discard'},
    {method: 'discard', tabIds: []},
    {method: 'discard', tabIds: [1], forced: false},
    {method: 'discard', tabIds: [1], query: {}},
    {method: 'discard', tabIds: [1], url: '*://*/*'},
    {method: 'discard', tabIds: [1, 1]},
    {method: 'discard', tabIds: [-1]},
    {method: 'discard', tabIds: [1.5]},
    {method: 'discard', tabIds: ['1']},
    {method: 'discard', tabIds: Array.from({length: EXTERNAL_BATCH_LIMIT + 1}, (_, i) => i)}
  ];
  for (const candidate of invalid) {
    assert.throws(() => validateExternalDiscardRequest(candidate));
  }
});

test('trusted sender normalization is exact, bounded, and fails malformed policy closed', () => {
  assert.deepEqual(normalizeTrustedIds(undefined), []);
  assert.deepEqual(normalizeTrustedIds('all'), []);
  assert.deepEqual(normalizeTrustedIds([
    TRUSTED,
    TRUSTED,
    '',
    'bad id',
    SECOND_TRUSTED
  ]), [TRUSTED, SECOND_TRUSTED]);
  assert.equal(normalizeTrustedIds(Array.from({length: 40}, (_, i) => `id-${i}`)).length, 32);
});

test('unknown, missing, and malformed senders are denied without executing tab code', async () => {
  let mutations = 0;
  const controller = createExternalDiscardController({
    execute: async () => {
      mutations += 1;
    },
    readTrustedIds: async () => [TRUSTED]
  });

  for (const sender of [{}, {id: ''}, {id: 'unknown'}, {id: `${TRUSTED} `}]) {
    assert.deepEqual(await controller.handle(request([1]), sender), {
      error: {code: 'UNAUTHORIZED'},
      ok: false
    });
  }
  assert.equal(mutations, 0);

  const failedPolicy = createExternalDiscardController({
    execute: async () => {
      mutations += 1;
    },
    readTrustedIds: async () => {
      throw Error('managed storage unavailable');
    }
  });
  assert.equal((await failedPolicy.handle(request([1]), {id: TRUSTED})).error.code, 'UNAUTHORIZED');
  assert.equal(mutations, 0);
});

test('a second extension is denied by default before any tab operation', async () => {
  let mutations = 0;
  const controller = createExternalDiscardController({
    execute: async () => {
      mutations += 1;
    },
    readTrustedIds: async () => []
  });
  assert.deepEqual(await controller.handle(request([1]), {id: SECOND_TRUSTED}), {
    error: {code: 'UNAUTHORIZED'},
    ok: false
  });
  assert.equal(mutations, 0);
});

test('trusted malformed and legacy requests cannot force, query, or mutate', async () => {
  let mutations = 0;
  const controller = createExternalDiscardController({
    execute: async () => {
      mutations += 1;
    },
    readTrustedIds: async () => [TRUSTED]
  });
  const hostile = [
    {method: 'discard', query: {}},
    {method: 'discard', query: {active: false}, forced: true},
    {method: 'discard', tabIds: [1], forced: true},
    {method: 'discard', tabIds: [1], callback: 'discard'},
    {method: 'release', tabIds: [1]}
  ];
  for (const candidate of hostile) {
    const response = await controller.handle(candidate, {id: TRUSTED});
    assert.equal(response.ok, false);
    assert.match(response.error.code, /^INVALID_/);
  }
  assert.equal(mutations, 0);
});

test('sanitizer returns one fixed nonsensitive exact outcome per declared tab', () => {
  const result = {
    alreadyOwned: [{id: 2, title: 'secret title', url: 'https://secret.example/'}],
    failed: [{reason: 'private failure detail', tab: {id: 5, url: 'https://private.example/'}}],
    protected: [{reason: 'whitelist contains private.example', tab: {id: 3}}],
    succeeded: [{tab: {id: 1, title: 'do not reflect'}}],
    unknownOwnership: [{tab: {id: 4}}],
    unsupported: [{tab: {id: 6}}]
  };
  const outcomes = sanitizeExternalDiscardResult([1, 2, 3, 4, 5, 6, 7], result);
  assert.deepEqual(outcomes, [
    {code: 'DISCARDED', status: 'succeeded', tabId: 1},
    {code: 'ALREADY_DISCARDED', status: 'skipped', tabId: 2},
    {code: 'PROTECTED', status: 'skipped', tabId: 3},
    {code: 'STATE_UNAVAILABLE', status: 'failed', tabId: 4},
    {code: 'OPERATION_FAILED', status: 'failed', tabId: 5},
    {code: 'UNSUPPORTED', status: 'skipped', tabId: 6},
    {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: 7}
  ]);
  assert.ok(Object.isFrozen(outcomes));
  assert.ok(outcomes.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(outcomes), /secret|private|https/i);
});

test('authorized caller receives bounded exact summary and partial pipeline failures', async () => {
  const controller = createExternalDiscardController({
    execute: async ({tabIds}) => {
      assert.deepEqual(tabIds, [1, 2, 3]);
      return {
        failed: [{reason: 'internal exception', tab: {id: 3}}],
        protected: [{reason: 'private rule', tab: {id: 2}}],
        succeeded: [{tab: {id: 1}}]
      };
    },
    readTrustedIds: async () => [TRUSTED]
  });
  const response = await controller.handle(request([1, 2, 3]), {id: TRUSTED});
  assert.deepEqual(response, {
    ok: false,
    outcomes: [
      {code: 'DISCARDED', status: 'succeeded', tabId: 1},
      {code: 'PROTECTED', status: 'skipped', tabId: 2},
      {code: 'OPERATION_FAILED', status: 'failed', tabId: 3}
    ],
    summary: {failed: 1, skipped: 1, succeeded: 1, total: 3}
  });
});

test('unexpected execution failures return fixed per-tab failures without exception text', async () => {
  const controller = createExternalDiscardController({
    execute: async () => {
      throw Error('token=top-secret https://internal.example/');
    },
    readTrustedIds: async () => [TRUSTED]
  });
  const response = await controller.handle(request([4, 8]), {id: TRUSTED});
  assert.deepEqual(response, {
    ok: false,
    outcomes: [
      {code: 'OPERATION_FAILED', status: 'failed', tabId: 4},
      {code: 'OPERATION_FAILED', status: 'failed', tabId: 8}
    ],
    summary: {failed: 2, skipped: 0, succeeded: 0, total: 2}
  });
  assert.doesNotMatch(JSON.stringify(response), /secret|internal|https/i);
});

test('per-sender and global concurrency bounds deny overlap without queueing mutations', async () => {
  assert.equal(EXTERNAL_CONCURRENCY_LIMIT, 1);
  const releases = [];
  let starts = 0;
  const controller = createExternalDiscardController({
    execute: () => new Promise(resolve => {
      starts += 1;
      releases.push(() => resolve({succeeded: [{tab: {id: starts}}]}));
    }),
    maxConcurrent: 2,
    readTrustedIds: async () => [TRUSTED, SECOND_TRUSTED, THIRD_TRUSTED]
  });
  const first = controller.handle(request([1]), {id: TRUSTED});
  await Promise.resolve();
  assert.equal((await controller.handle(request([2]), {id: TRUSTED})).error.code, 'BUSY');
  const second = controller.handle(request([2]), {id: SECOND_TRUSTED});
  await Promise.resolve();
  assert.equal((await controller.handle(request([3]), {id: THIRD_TRUSTED})).error.code, 'BUSY');
  assert.equal(starts, 2);
  releases[0]();
  releases[1]();
  await Promise.all([first, second]);
});

test('authorized request starts are rate limited in a deterministic sliding window', async () => {
  let timestamp = 100;
  let mutations = 0;
  const controller = createExternalDiscardController({
    execute: async ({tabIds}) => {
      mutations += 1;
      return {succeeded: [{tab: {id: tabIds[0]}}]};
    },
    maxRequests: 2,
    now: () => timestamp,
    rateWindow: 1_000,
    readTrustedIds: async () => [TRUSTED]
  });
  assert.equal((await controller.handle(request([1]), {id: TRUSTED})).ok, true);
  assert.equal((await controller.handle(request([2]), {id: TRUSTED})).ok, true);
  assert.equal((await controller.handle(request([3]), {id: TRUSTED})).error.code, 'RATE_LIMITED');
  assert.equal(mutations, 2);
  timestamp += 1_000;
  assert.equal((await controller.handle(request([4]), {id: TRUSTED})).ok, true);
  assert.equal(mutations, 3);
});

test('authorized conceptual second extension traverses shared scope, protection, and ownership logic', async () => {
  const eligible = {
    active: false,
    autoDiscardable: true,
    discarded: false,
    id: 10,
    incognito: false,
    index: 1,
    status: 'complete',
    url: 'https://eligible.example/',
    windowId: 1,
    windowType: 'normal'
  };
  const protectedDiscard = {
    ...eligible,
    discarded: true,
    id: 11,
    pinned: true,
    url: 'https://protected.example/'
  };
  const active = {...eligible, active: true, id: 12};
  const allTabs = [eligible, protectedDiscard, active];
  const mutations = [];

  const execute = ({tabIds}) => {
    const declared = new Set(tabIds);
    return runScopedCommand({
      check: async tabs => {
        mutations.push(...tabs.map(tab => `discard:${tab.id}`));
        return {succeeded: tabs.map(tab => tab.id)};
      },
      command: 'discard-tabs',
      discard: async tab => mutations.push(`force:${tab.id}`),
      query: async options => allTabs.filter(tab => declared.has(tab.id) &&
        (options.active !== false || tab.active === false) &&
        (options.windowType !== 'normal' || tab.windowType === 'normal')),
      refresh: async tab => tab,
      resolveFresh: async tab => ({
        marker: {source: 'claimed', state: 'owned'},
        state: 'discarded',
        tab
      }),
      shiftKey: false,
      suspendedPolicy: {
        audio: false,
        form: false,
        mode: 'time-based',
        paused: false,
        period: 0,
        pinned: true,
        whitelist: [],
        'notification.permission': false,
        'whitelist-url': [],
        'whitelist.session': []
      },
      takeover: async tab => {
        mutations.push(`takeover:${tab.id}`);
        return true;
      }
    });
  };
  const controller = createExternalDiscardController({
    execute,
    readTrustedIds: async () => [TRUSTED]
  });

  const denied = await controller.handle(request([10, 11, 12, 999]), {id: SECOND_TRUSTED});
  assert.equal(denied.error.code, 'UNAUTHORIZED');
  assert.deepEqual(mutations, []);

  const authorized = await controller.handle(request([10, 11, 12, 999]), {id: TRUSTED});
  assert.deepEqual(mutations, ['discard:10']);
  assert.deepEqual(authorized, {
    ok: true,
    outcomes: [
      {code: 'DISCARDED', status: 'succeeded', tabId: 10},
      {code: 'PROTECTED', status: 'skipped', tabId: 11},
      {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: 12},
      {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: 999}
    ],
    summary: {failed: 0, skipped: 3, succeeded: 1, total: 4}
  });
});

test('production listener is allowlisted and cannot consume caller-supplied query or forced mode', () => {
  const core = fs.readFileSync(new URL('../v3/worker/core.mjs', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../v3/worker/core/external-api.mjs', import.meta.url), 'utf8');
  const schema = JSON.parse(fs.readFileSync(new URL('../v3/schema.json', import.meta.url), 'utf8'));

  assert.match(core, /installExternalDiscardApi\(\)/);
  assert.match(runtime, /runScopedCommand\(\{/);
  assert.match(runtime, /command: 'discard-tabs'/);
  assert.match(runtime, /shiftKey: false/);
  assert.match(runtime, /number\.check\(tabs, number\.IGNORE/);
  assert.match(runtime, /resolveFresh: ownership\.resolveFresh/);
  assert.match(runtime, /discard\.takeover\(tab, \{manual: true\}\)/);
  assert.doesNotMatch(runtime, /request\.(query|forced)/);
  assert.ok(schema.properties[EXTERNAL_TRUSTED_IDS_KEY]);
});
