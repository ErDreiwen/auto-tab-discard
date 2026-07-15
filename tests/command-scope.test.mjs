import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterScopeTabs,
  prepareDiscardTargets,
  releaseAvailability,
  releaseCommands,
  releaseDiscardedTargets,
  runDirectDiscardCommand,
  runScopedCommand,
  scopeQuery
} from '../v3/worker/core/command-scope.mjs';

const DISCARD_COMMANDS = [
  'discard-window',
  'discard-rights',
  'discard-lefts',
  'discard-other-windows',
  'discard-tabs'
];
const RELEASE_COMMANDS = [
  'release-window',
  'release-rights',
  'release-lefts',
  'release-other-windows',
  'release-tabs'
];
const ALL_DISCARD_COMMANDS = ['discard-tab', 'discard-tree', ...DISCARD_COMMANDS];

test('maps every bulk popup command to its full ownership query scope', () => {
  for (const command of [...DISCARD_COMMANDS, ...RELEASE_COMMANDS]) {
    const query = scopeQuery(command);
    assert.equal(query.active, false, command);
    assert.equal(query.url, '*://*/*', command);

    if (command.includes('other-windows')) {
      assert.equal(query.currentWindow, false, command);
    }
    else if (command.endsWith('tabs')) {
      assert.equal('currentWindow' in query, false, command);
    }
    else {
      assert.equal(query.currentWindow, true, command);
    }
    assert.equal('discarded' in query, false, command);
  }
});

test('keeps left and right ownership scopes on the selected side', () => {
  const selected = {index: 3};
  const tabs = [1, 2, 4, 5].map((index, id) => ({id, index}));

  for (const prefix of ['discard', 'release']) {
    assert.deepEqual(
      filterScopeTabs(`${prefix}-lefts`, tabs, selected).map(tab => tab.index),
      [1, 2]
    );
    assert.deepEqual(
      filterScopeTabs(`${prefix}-rights`, tabs, selected).map(tab => tab.index),
      [4, 5]
    );
  }
});

test('classifies every discard command into loaded, external takeover, and self-owned targets', async () => {
  for (const command of ALL_DISCARD_COMMANDS) {
    const tabs = [
      {id: 1, discarded: false},
      {id: 2, discarded: true},
      {id: 3, discarded: false},
      {id: 4, discarded: true}
    ];
    const resolved = [];
    const result = await prepareDiscardTargets(command, tabs, async tab => {
      resolved.push(tab.id);
      return {
        marker: tab.id === 4 ? {state: 'owned', source: 'self'} : {state: 'owned', source: 'claimed'},
        state: 'discarded',
        tab
      };
    });

    assert.deepEqual(resolved, [2, 4], command);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [2], command);
    assert.deepEqual(result.alreadyOwned.map(tab => tab.id), [4], command);
    assert.deepEqual(result.candidates.map(tab => tab.id), [1, 3], command);
  }
});

test('reclassifies a stale discard snapshot and isolates ownership write failures', async () => {
  for (const command of ALL_DISCARD_COMMANDS) {
    const tabs = [
      {id: 1, discarded: false},
      {id: 2, discarded: true},
      {id: 3, discarded: true}
    ];
    const result = await prepareDiscardTargets(command, tabs, async tab => {
      if (tab.id === 2) {
        return {state: 'loaded', tab: {...tab, discarded: false}};
      }
      throw Error(`claim failed for ${command}`);
    });

    assert.deepEqual(result.candidates.map(tab => tab.id), [1, 2], command);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [3], command);
    assert.deepEqual(result.alreadyOwned, [], command);
    assert.equal(result.errors.length, 1, command);
  }
});

test('runs the selected-tab and tab-group rows through their real keeper executor', async () => {
  for (const command of ['discard-tab', 'discard-tree']) {
    const active = {id: 1, index: 4, active: true, discarded: false, highlighted: true};
    const alreadyDiscarded = {id: 2, index: 5, active: false, discarded: true, highlighted: false};
    const loadedGroupTab = {id: 3, index: 6, active: false, discarded: false, highlighted: true};
    const keeper = {id: 4, index: 3, active: false, discarded: false, highlighted: false};
    const selfOwned = {id: 5, index: 7, active: false, discarded: true, highlighted: false};
    const targets = command === 'discard-tab' ? [active] :
      [active, alreadyDiscarded, loadedGroupTab, selfOwned];
    const calls = [];

    const result = await runDirectDiscardCommand({
      activate: async tab => calls.push(`activate:${tab.id}`),
      allTabs: [...targets, keeper],
      command,
      discard: async tab => calls.push(`discard:${tab.id}:${tab.active}`),
      inProgress: () => false,
      notifyNoKeeper: () => calls.push('notify'),
      resolveFresh: async tab => {
        calls.push(`claim:${tab.id}`);
        return {
          marker: {state: 'owned', source: tab.id === 5 ? 'self' : 'claimed'},
          state: 'discarded',
          tab
        };
      },
      selected: active,
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        return true;
      },
      targets
    });

    assert.equal(result.blocked, false, command);
    assert.equal(result.keeper.id, keeper.id, command);
    if (command === 'discard-tab') {
      assert.deepEqual(calls, ['activate:4', 'discard:1:false'], command);
    }
    else {
      assert.deepEqual(calls, [
        'claim:2',
        'claim:5',
        'activate:4',
        'discard:1:false',
        'discard:3:false',
        'takeover:2'
      ], command);
    }
  }
});

test('does not discard an active direct target when no keeper exists', async () => {
  const active = {id: 1, index: 0, active: true, discarded: false, highlighted: true};
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    allTabs: [active],
    command: 'discard-tab',
    discard: async tab => calls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => calls.push('notify'),
    resolveFresh: async tab => ({state: 'discarded', tab}),
    selected: active,
    takeover: async () => true,
    targets: [active]
  });

  assert.equal(result.blocked, true);
  assert.deepEqual(calls, ['notify']);
});

test('still takes over discarded group children when the active root has no keeper', async () => {
  const active = {id: 1, index: 0, active: true, discarded: false, highlighted: true};
  const external = {id: 2, index: 1, active: false, discarded: true, highlighted: false};
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    allTabs: [active, external],
    command: 'discard-tree',
    discard: async tab => calls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => calls.push('notify'),
    resolveFresh: async tab => {
      calls.push(`claim:${tab.id}`);
      return {marker: {state: 'owned', source: 'claimed'}, state: 'discarded', tab};
    },
    selected: active,
    takeover: async tab => {
      calls.push(`takeover:${tab.id}`);
      return true;
    },
    targets: [active, external]
  });

  assert.equal(result.blocked, true);
  assert.deepEqual(calls, ['claim:2', 'notify', 'takeover:2']);
});

test('computes all five popup X controls from the worker scopes', async () => {
  assert.deepEqual(releaseCommands, RELEASE_COMMANDS);
  const queries = [];
  const selected = {index: 5};
  const available = await releaseAvailability(async options => {
    queries.push(options);
    if (options.currentWindow === false) {
      return [{id: 3, index: 1, discarded: true}];
    }
    if (options.currentWindow === true) {
      return [
        {id: 1, index: 2, discarded: true},
        {id: 2, index: 8, discarded: false}
      ];
    }
    return [{id: 4, index: 4, discarded: true}];
  }, selected);

  assert.deepEqual(available, {
    'release-window': true,
    'release-rights': false,
    'release-lefts': true,
    'release-other-windows': true,
    'release-tabs': true
  });
  assert.equal(queries.filter(options => options.currentWindow === true).length, 3);
  assert.equal(queries.filter(options => options.currentWindow === false).length, 1);
  assert.equal(queries.filter(options => 'currentWindow' in options === false).length, 1);
});

test('release waits for discarded:false instead of erasing a concurrent rediscard', async () => {
  for (const command of RELEASE_COMMANDS) {
    const calls = [];
    let ownershipState = 'owned';
    const tabs = [
      {id: 1, discarded: true},
      {id: 2, discarded: false},
      {id: 3, discarded: true}
    ];
    const released = await releaseDiscardedTargets(
      command,
      tabs,
      async (tab, options) => {
        calls.push(`reload:${tab.id}:${options.bypassCache}`);
        ownershipState = 'new-pending-discard';
      },
      {bypassCache: false},
      async tab => calls.push(`cancel:${tab.id}`)
    );

    assert.deepEqual(released.map(tab => tab.id), [1, 3], command);
    assert.deepEqual(calls, ['cancel:1', 'cancel:2', 'cancel:3', 'reload:1:false', 'reload:3:false'], command);
    assert.equal(calls.some(call => call.includes('reload:2')), false, command);
    assert.equal(ownershipState, 'new-pending-discard', command);
  }
});

test('release waits for an in-flight takeover to cancel before reloading', async () => {
  const calls = [];
  let finishCancel;
  const released = releaseDiscardedTargets(
    'release-tabs',
    [{id: 1, discarded: true}],
    async tab => calls.push(`reload:${tab.id}`),
    {},
    tab => new Promise(resolve => {
      calls.push(`cancel:${tab.id}`);
      finishCancel = resolve;
    })
  );

  while (!finishCancel) {
    await new Promise(resolve => setTimeout(resolve));
  }
  assert.deepEqual(calls, ['cancel:1']);
  finishCancel();
  await released;
  assert.deepEqual(calls, ['cancel:1', 'reload:1']);
});

test('the shared menu executor routes every bulk popup command through ownership', async () => {
  for (const command of [...DISCARD_COMMANDS, ...RELEASE_COMMANDS]) {
    const left = command.endsWith('lefts');
    const positional = command.endsWith('lefts') || command.endsWith('rights');
    const selected = {id: 99, index: 5};
    const targetIndexes = positional ? (left ? [2, 3] : [7, 8]) : [2, 7];
    const tabs = [
      {id: 1, index: targetIndexes[0], discarded: false},
      {id: 2, index: targetIndexes[1], discarded: true}
    ];
    const calls = [];
    let queryOptions;

    await runScopedCommand({
      command,
      selected,
      shiftKey: false,
      query: async options => {
        queryOptions = options;
        return tabs;
      },
      resolveFresh: async tab => {
        calls.push(`claim:${tab.id}`);
        return {marker: {state: 'owned', source: 'claimed'}, state: 'discarded', tab};
      },
      check: async candidates => calls.push(`check:${candidates.map(tab => tab.id).join(',')}`),
      discard: async tab => calls.push(`discard:${tab.id}`),
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        return true;
      },
      cancelTakeover: async tab => calls.push(`cancel:${tab.id}`),
      reload: async (tab, options) => calls.push(`reload:${tab.id}:${options.bypassCache}`)
    });

    assert.deepEqual(queryOptions, scopeQuery(command), command);
    if (command.startsWith('discard')) {
      assert.deepEqual(calls, ['claim:2', 'takeover:2', 'check:1'], command);
    }
    else {
      assert.deepEqual(calls, ['cancel:1', 'cancel:2', 'reload:2:false'], command);
    }
  }
});

test('never turns an empty scoped discard into an unfiltered global check', async () => {
  for (const command of DISCARD_COMMANDS) {
    for (const tabs of [[], [{id: 2, index: command.endsWith('lefts') ? 3 : 7, discarded: true}]]) {
      const calls = [];
      await runScopedCommand({
        command,
        selected: {id: 99, index: 5},
        shiftKey: false,
        query: async () => tabs,
        resolveFresh: async tab => {
          calls.push(`claim:${tab.id}`);
          return {marker: {state: 'owned', source: 'claimed'}, state: 'discarded', tab};
        },
        check: async () => calls.push('check'),
        discard: async () => calls.push('discard'),
        takeover: async tab => {
          calls.push(`takeover:${tab.id}`);
          return true;
        },
        reload: async () => calls.push('reload')
      });

      assert.deepEqual(calls, tabs.length ? ['claim:2', 'takeover:2'] : [], command);
    }
  }
});

test('routes Shift through forced discards and cache-bypassing releases', async () => {
  for (const command of [...DISCARD_COMMANDS, ...RELEASE_COMMANDS]) {
    const selected = {id: 99, index: 5};
    const tabs = [
      {id: 1, index: command.endsWith('lefts') ? 2 : 7, discarded: false},
      {id: 2, index: command.endsWith('lefts') ? 3 : 8, discarded: true}
    ];
    const calls = [];

    await runScopedCommand({
      command,
      selected,
      shiftKey: true,
      query: async () => tabs,
      resolveFresh: async tab => {
        calls.push(`claim:${tab.id}`);
        return {marker: {state: 'owned', source: 'claimed'}, state: 'discarded', tab};
      },
      check: async candidates => calls.push(`check:${candidates.length}`),
      discard: async tab => calls.push(`discard:${tab.id}`),
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        return true;
      },
      cancelTakeover: async tab => calls.push(`cancel:${tab.id}`),
      reload: async (tab, options) => calls.push(`reload:${tab.id}:${options.bypassCache}`)
    });

    if (command.startsWith('discard')) {
      assert.deepEqual(calls, ['claim:2', 'takeover:2', 'discard:1'], command);
    }
    else {
      assert.deepEqual(calls, ['cancel:1', 'cancel:2', 'reload:2:true'], command);
    }
  }
});

test('does not report a popup discard command complete when a takeover fails', async () => {
  await assert.rejects(runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [{id: 2, index: 3, discarded: true}],
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    check: async () => {},
    discard: async () => true,
    takeover: async () => false,
    reload: async () => {}
  }), /takeovers failed/);
});
