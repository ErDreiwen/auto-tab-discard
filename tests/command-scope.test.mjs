import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterScopeTabs,
  prepareDiscardTargets,
  queryCommandScope,
  releaseAvailability,
  releaseCommands,
  releaseDiscardedTargets,
  runDirectDiscardCommand,
  runScopedCommand,
  scopeTakeoverTabs,
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

test('query failures carry command/scope context and mutate no tabs', async () => {
  const calls = [];
  await assert.rejects(runScopedCommand({
    cancelTakeover: async tab => calls.push(`cancel:${tab.id}`),
    check: async tabs => calls.push(`check:${tabs.length}`),
    command: 'discard-window',
    discard: async tab => calls.push(`discard:${tab.id}`),
    query: async () => {
      const error = Error('enterprise policy denied the query');
      error.code = 'BLOCKED_BY_POLICY';
      throw error;
    },
    reload: async tab => calls.push(`reload:${tab.id}`),
    resolveFresh: async tab => ({state: 'loaded', tab}),
    selected: {id: 9, index: 0, windowId: 3},
    takeover: async tab => calls.push(`takeover:${tab.id}`)
  }), error => {
    assert.equal(error.code, 'TAB_QUERY_FAILED');
    assert.equal(error.command, 'discard-window');
    assert.equal(error.phase, 'initial-scope');
    assert.equal(error.transient, false);
    assert.deepEqual(error.query, {active: false, windowId: 3, windowType: 'normal'});
    assert.match(error.message, /discard-window initial-scope tab query failed/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('query retries exactly once only for a classified idempotent transient', async () => {
  let attempts = 0;
  const tabs = [{id: 1}];
  assert.equal(await queryCommandScope(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = Error('browser tab service is restarting');
      error.code = 'TABS_QUERY_TEMPORARILY_UNAVAILABLE';
      throw error;
    }
    return tabs;
  }, {active: false}, {command: 'release-tabs', phase: 'release-refresh'}), tabs);
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(queryCommandScope(async () => {
    attempts += 1;
    const error = Error('unknown');
    error.code = 'SOMETHING_NEW';
    throw error;
  }, {}, {command: 'discard-tabs'}), error => error.code === 'TAB_QUERY_FAILED');
  assert.equal(attempts, 1);
});
const ALL_DISCARD_COMMANDS = ['discard-tab', 'discard-tree', ...DISCARD_COMMANDS];

test('maps every bulk popup command to its full ownership query scope', () => {
  for (const command of [...DISCARD_COMMANDS, ...RELEASE_COMMANDS]) {
    const query = scopeQuery(command);
    assert.equal(query.active, false, command);
    assert.equal('url' in query, false, command);

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

test('classifies every discard command into loaded, suspended takeover, and self-owned targets', async () => {
  for (const command of ALL_DISCARD_COMMANDS) {
    const tabs = [
      {id: 1, discarded: false},
      {id: 2, discarded: true},
      {id: 3, discarded: false},
      {id: 4, discarded: true},
      {id: 5, discarded: true},
      {id: 6, discarded: false, frozen: true}
    ];
    const resolved = [];
    const result = await prepareDiscardTargets(command, tabs, async tab => {
      resolved.push(tab.id);
      return {
        marker: {
          state: 'owned',
          source: tab.id === 4 ? 'self' : tab.id === 5 ? 'adopted' : 'claimed'
        },
        state: 'discarded',
        tab
      };
    });

    assert.deepEqual(resolved, [2, 4, 5, 6], command);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [6, 2, 5], command);
    assert.deepEqual(result.alreadyOwned.map(tab => tab.id), [4], command);
    assert.deepEqual(result.candidates.map(tab => tab.id), [1, 3], command);
  }
});

test('reclassifies a stale discard snapshot and fails closed on ownership write failures', async () => {
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
    assert.deepEqual(result.takeovers, [], command);
    assert.deepEqual(result.alreadyOwned, [], command);
    assert.equal(result.errors.length, 1, command);
    assert.deepEqual(result.unknownOwnership.map(entry => entry.tab.id), [3], command);
    assert.deepEqual(result.failed.map(entry => entry.tab.id), [3], command);
    assert.equal(result.failed[0].retryable, true, command);
  }
});

test('pins window scopes to the selected window instead of mutable currentWindow state', () => {
  const selected = {id: 99, index: 3, windowId: 7};
  assert.deepEqual(scopeQuery('discard-window', selected), {
    active: false,
    windowId: 7,
    windowType: 'normal'
  });
  assert.deepEqual(scopeQuery('discard-other-windows', selected), {
    active: false,
    windowType: 'normal'
  });

  const tabs = [
    {id: 1, index: 1, windowId: 7},
    {id: 2, index: 2, windowId: 8},
    {id: 3, index: 4, windowId: 7},
    {id: 4, index: 5, windowId: 8}
  ];
  assert.deepEqual(filterScopeTabs('discard-window', tabs, selected).map(tab => tab.id), [1, 3]);
  assert.deepEqual(filterScopeTabs('discard-other-windows', tabs, selected).map(tab => tab.id), [2, 4]);
  assert.deepEqual(filterScopeTabs('discard-rights', tabs, selected).map(tab => tab.id), [3]);
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
      adopt: async tab => {
        calls.push(`adopt:${tab.id}`);
        return true;
      },
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
      shiftKey: false,
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

test('revalidates native tab-group membership immediately before keeper activation', async () => {
  const selected = {
    id: 1,
    windowId: 7,
    groupId: 4,
    index: 0,
    active: true,
    discarded: false
  };
  const child = {
    id: 2,
    windowId: 7,
    groupId: 4,
    index: 1,
    active: false,
    discarded: false
  };
  const keeper = {
    id: 3,
    windowId: 7,
    groupId: -1,
    index: 2,
    active: false,
    discarded: false,
    highlighted: false
  };
  const calls = [];
  await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    allTabs: [{...selected}, {...child}, keeper],
    command: 'discard-tree',
    commitScope: async () => ({
      allTabs: [{...selected}, {...child}, keeper],
      selected: {...selected},
      targets: [{...selected}, {...child}],
      valid: true
    }),
    discard: async tab => calls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('a valid keeper exists'),
    resolveFresh: async () => assert.fail('loaded targets need no ownership read'),
    selected: {...selected},
    takeover: async () => assert.fail('loaded targets need no takeover'),
    targets: [{...selected}, {...child}]
  });
  assert.deepEqual(calls, ['activate:3', 'discard:1', 'discard:2']);
});

test('aborts a queued group command when move, regroup, or ungroup changes its commit scope', async () => {
  for (const reason of [
    'selected tab moved or changed group before discard',
    'tab-group membership changed before discard'
  ]) {
    const selected = {id: 1, active: true, discarded: false};
    const child = {id: 2, active: false, discarded: false};
    const calls = [];
    await assert.rejects(runDirectDiscardCommand({
      activate: async tab => calls.push(`activate:${tab.id}`),
      allTabs: [selected, child, {id: 3, active: false, discarded: false}],
      command: 'discard-tree',
      commitScope: async () => ({valid: false, reason}),
      discard: async tab => calls.push(`discard:${tab.id}`),
      inProgress: () => false,
      notifyNoKeeper: () => calls.push('notify'),
      resolveFresh: async () => assert.fail('loaded targets need no ownership read'),
      selected,
      takeover: async tab => calls.push(`takeover:${tab.id}`),
      targets: [selected, child]
    }), error => {
      assert.equal(error.message, reason);
      assert.equal(error.result.scopeChanged, true);
      assert.deepEqual(error.result.skipped.map(tab => tab.id), [1, 2]);
      return true;
    });
    assert.deepEqual(calls, [], reason);
  }
});

test('does not discard an active direct target when no keeper exists', async () => {
  const active = {id: 1, index: 0, active: true, discarded: false, highlighted: true};
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    adopt: async tab => {
      calls.push(`adopt:${tab.id}`);
      return true;
    },
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
    adopt: async tab => {
      calls.push(`adopt:${tab.id}`);
      return true;
    },
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
    shiftKey: false,
    takeover: async tab => {
      calls.push(`takeover:${tab.id}`);
      return true;
    },
    targets: [active, external]
  });

  assert.equal(result.blocked, true);
  assert.deepEqual(calls, ['claim:2', 'notify', 'takeover:2']);
});

test('discards loaded inactive group children when the active root has no keeper', async () => {
  const active = {id: 1, index: 0, active: true, discarded: false, highlighted: true};
  const loaded = {id: 2, index: 1, active: false, discarded: false, highlighted: false};
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async () => assert.fail('there is no keeper to activate'),
    allTabs: [active, loaded],
    command: 'discard-tree',
    discard: async tab => calls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => calls.push('notify'),
    resolveFresh: async () => assert.fail('loaded tabs do not need ownership resolution'),
    selected: active,
    takeover: async () => assert.fail('loaded children use ordinary discard'),
    targets: [active, loaded]
  });

  assert.equal(result.blocked, true);
  assert.deepEqual(calls, ['notify', 'discard:2']);
});

test('a normal command physically upgrades an adopted group child', async () => {
  const active = {id: 1, index: 0, active: true, discarded: false, highlighted: true};
  const adopted = {id: 2, index: 1, active: false, discarded: true, highlighted: false};
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    adopt: async () => assert.fail('Shift must not use in-place adoption'),
    allTabs: [active, adopted],
    command: 'discard-tree',
    discard: async tab => calls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => calls.push('notify'),
    resolveFresh: async tab => {
      calls.push(`claim:${tab.id}`);
      return {marker: {state: 'owned', source: 'adopted'}, state: 'discarded', tab};
    },
    selected: active,
    shiftKey: false,
    takeover: async tab => {
      calls.push(`takeover:${tab.id}`);
      return true;
    },
    targets: [active, adopted]
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

test('scopes temporarily active takeover jobs without admitting unrelated active tabs', async () => {
  const selected = {id: 99, index: 5, windowId: 1};
  const jobs = [
    {id: 11, started: true, tab: {id: 11, index: 2, windowId: 1}},
    {id: 12, started: false, tab: {id: 12, index: 8, windowId: 1}},
    {id: 13, started: true, tab: {id: 13, index: 3, windowId: 2}}
  ];

  assert.deepEqual(scopeTakeoverTabs('release-window', jobs, selected).map(tab => tab.id), [11, 12]);
  assert.deepEqual(scopeTakeoverTabs('release-lefts', jobs, selected).map(tab => tab.id), [11]);
  assert.deepEqual(scopeTakeoverTabs('release-rights', jobs, selected).map(tab => tab.id), [12]);
  assert.deepEqual(scopeTakeoverTabs('release-other-windows', jobs, selected).map(tab => tab.id), [13]);
  assert.deepEqual(scopeTakeoverTabs('release-tabs', jobs, selected).map(tab => tab.id), [11, 12, 13]);

  let snapshotReads = 0;
  const available = await releaseAvailability(async () => [], selected, async () => {
    snapshotReads += 1;
    return jobs;
  });
  assert.equal(snapshotReads, 1);
  assert.deepEqual(available, Object.fromEntries(releaseCommands.map(command => [command, true])));
});

test('release cancels scoped takeover jobs before selecting live targets and preserves other active tabs', async () => {
  const ordinary = {id: 1, index: 1, windowId: 1, active: false, discarded: true};
  const scopedJob = {id: 2, started: true, tab: {id: 2, index: 2, windowId: 1}};
  const otherWindowJob = {id: 3, started: true, tab: {id: 3, index: 1, windowId: 2}};
  const unrelatedActive = {id: 4, index: 4, windowId: 1, active: true, discarded: false};
  const calls = [];
  let queryCount = 0;
  let scopedCancelled = false;

  const result = await runScopedCommand({
    cancelTakeover: async tab => {
      calls.push(`cancel:${tab.id}`);
      if (tab.id === scopedJob.id) {
        scopedCancelled = true;
      }
    },
    command: 'release-window',
    query: async options => {
      queryCount += 1;
      calls.push(`query:${queryCount}`);
      assert.deepEqual(options, {active: false, windowId: 1, windowType: 'normal'});
      if (queryCount === 2) {
        assert.equal(scopedCancelled, true, 'takeover cancellation must settle before live selection');
      }
      // The browser intentionally omits both active tabs. Only the known job is
      // allowed back into the scope through its exact id.
      return [ordinary];
    },
    refresh: async tab => {
      calls.push(`refresh:${tab.id}`);
      assert.equal(tab.id, scopedJob.id, 'an unrelated active job must not be refreshed');
      assert.equal(scopedCancelled, true);
      return {...tab, active: false, discarded: true};
    },
    reload: async tab => calls.push(`reload:${tab.id}`),
    selected: {id: 99, index: 5, windowId: 1},
    shiftKey: false,
    takeoverSnapshot: () => [scopedJob, otherWindowJob]
  });

  assert.deepEqual(result.released.map(tab => tab.id), [ordinary.id, scopedJob.id]);
  assert.deepEqual(calls, [
    'query:1',
    'cancel:1',
    'cancel:2',
    'query:2',
    'refresh:2',
    'reload:1',
    'reload:2'
  ]);
  assert.equal(calls.some(call => call.endsWith(`:${otherWindowJob.id}`)), false);
  assert.equal(calls.some(call => call.endsWith(`:${unrelatedActive.id}`)), false);
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

    assert.deepEqual(released.released.map(tab => tab.id), [1, 3], command);
    assert.deepEqual(released.failed, [], command);
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

test('release re-queries its live scope after Edge replaces an id during cancellation', async () => {
  const predecessor = {id: 10, index: 2, discarded: true};
  const successor = {id: 11, index: 2, discarded: true};
  let live = [predecessor];
  let finishCancel;
  let queryCount = 0;
  const calls = [];

  const command = runScopedCommand({
    cancelTakeover: tab => new Promise(resolve => {
      calls.push(`cancel:${tab.id}`);
      finishCancel = () => {
        live = [successor];
        resolve();
      };
    }),
    command: 'release-tabs',
    query: async () => {
      queryCount += 1;
      return live;
    },
    reload: async tab => calls.push(`reload:${tab.id}`),
    selected: {id: 99, index: 5},
    shiftKey: false
  });

  while (!finishCancel) {
    await new Promise(resolve => setTimeout(resolve));
  }
  assert.equal(queryCount, 1);
  assert.deepEqual(calls, ['cancel:10']);
  finishCancel();

  const result = await command;
  assert.equal(queryCount, 2);
  assert.deepEqual(result.released.map(tab => tab.id), [11]);
  assert.deepEqual(calls, ['cancel:10', 'reload:11']);
});

test('release reports each verified loaded successor and isolates a peer failure', async () => {
  const released = await releaseDiscardedTargets(
    'release-tabs',
    [
      {id: 1, discarded: true},
      {id: 2, discarded: true}
    ],
    async () => assert.fail('the authoritative helper replaces raw reload'),
    {bypassCache: true},
    async () => {},
    async tab => tab,
    undefined,
    async (tab, options) => {
      assert.equal(options.bypassCache, true);
      if (tab.id === 2) {
        throw Error('did not settle loaded');
      }
      return {...tab, discarded: false, status: 'complete'};
    }
  );

  assert.deepEqual(released.released.map(tab => ({id: tab.id, discarded: tab.discarded})), [
    {id: 1, discarded: false}
  ]);
  assert.deepEqual(released.failed.map(entry => ({id: entry.tab.id, reason: entry.reason})), [
    {id: 2, reason: 'did not settle loaded'}
  ]);
});

test('release preserves the retained-frozen successor as a precise retryable failure', async () => {
  const retained = {
    active: false,
    discarded: false,
    frozen: true,
    id: 102,
    status: 'complete'
  };
  const result = await releaseDiscardedTargets(
    'release-tabs',
    [
      {id: 1, discarded: true},
      {id: 2, discarded: true}
    ],
    async () => assert.fail('the authoritative helper replaces raw reload'),
    {bypassCache: false},
    async () => {},
    async tab => tab,
    undefined,
    async tab => {
      if (tab.id === 1) {
        const error = Error('Edge kept the released successor frozen');
        error.code = 'TAB_RELEASE_REMAINS_FROZEN';
        error.disposition = 'retained-frozen';
        error.retryable = true;
        error.tab = retained;
        throw error;
      }
      return {...tab, discarded: false, frozen: false, status: 'complete'};
    }
  );

  assert.deepEqual(result.released.map(tab => tab.id), [2]);
  assert.deepEqual(result.failed, [{
    code: 'TAB_RELEASE_REMAINS_FROZEN',
    disposition: 'retained-frozen',
    reason: 'Edge kept the released successor frozen',
    retryable: true,
    tab: retained
  }]);

  const returned = await releaseDiscardedTargets(
    'release-tabs',
    [{id: 3, discarded: true}],
    async () => assert.fail('the authoritative helper replaces raw reload'),
    {},
    async () => {},
    async tab => tab,
    undefined,
    async () => ({
      code: 'TAB_RELEASE_REMAINS_FROZEN',
      disposition: 'retained-frozen',
      reason: 'stable retained-frozen disposition',
      retryable: true,
      tab: {...retained, id: 103}
    })
  );
  assert.deepEqual(returned.released, []);
  assert.deepEqual(returned.failed, [{
    code: 'TAB_RELEASE_REMAINS_FROZEN',
    disposition: 'retained-frozen',
    reason: 'stable retained-frozen disposition',
    retryable: true,
    tab: {...retained, id: 103}
  }]);
});

test('release availability includes Edge-frozen tabs and delegates one verified reload', async () => {
  const selected = {id: 99, index: 5};
  const frozen = {id: 2, index: 3, active: false, discarded: false, frozen: true};
  const availability = await releaseAvailability(async () => [frozen], selected);
  for (const command of releaseCommands) {
    assert.equal(availability[command], command.endsWith('rights') ? false : true, command);
  }

  const calls = [];
  const result = await runScopedCommand({
    cancelTakeover: async tab => calls.push(`cancel:${tab.id}`),
    command: 'release-tabs',
    query: async () => [frozen],
    reload: async () => assert.fail('the authoritative release helper owns the reload'),
    selected,
    shiftKey: false,
    release: async (tab, options) => {
      calls.push(`release:${tab.id}:${options.bypassCache}`);
      return {...tab, discarded: false, frozen: false, status: 'complete'};
    }
  });
  assert.equal(result.released[0].frozen, false);
  assert.deepEqual(calls, ['cancel:2', 'release:2:false']);
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
      adopt: async tab => {
        calls.push(`adopt:${tab.id}`);
        return true;
      },
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
        adopt: async tab => {
          calls.push(`adopt:${tab.id}`);
          return true;
        },
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

test('normal bulk commands physically take over Edge-style frozen tabs', async () => {
  for (const command of DISCARD_COMMANDS) {
    const calls = [];
    const result = await runScopedCommand({
      command,
      selected: {id: 99, index: 5},
      shiftKey: false,
      query: async () => [{
        id: 2,
        index: command.endsWith('lefts') ? 3 : 7,
        active: false,
        discarded: false,
        frozen: true
      }],
      resolveFresh: async () => assert.fail('a frozen tab is not an unloaded ownership claim'),
      check: async () => assert.fail('a frozen tab must not enter the loaded metadata pipeline'),
      discard: async () => assert.fail('a frozen tab must use the controlled takeover path'),
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        return true;
      },
      reload: async () => assert.fail('discard commands do not use the release path')
    });

    assert.deepEqual(calls, ['takeover:2'], command);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [2], command);
  }
});

test('reclassifies a takeover target that wakes before execution into the loaded command path', async () => {
  for (const shiftKey of [false, true]) {
    const calls = [];
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 5},
      shiftKey,
      query: async () => [{id: 2, index: 3, active: false, discarded: true}],
      resolveFresh: async tab => {
        calls.push(`claim:${tab.id}`);
        return {
          marker: {state: 'owned', source: 'claimed'},
          state: 'discarded',
          tab
        };
      },
      refresh: async tab => {
        calls.push(`refresh:${tab.id}`);
        return {...tab, discarded: false, frozen: false, status: 'complete'};
      },
      check: async tabs => calls.push(`check:${tabs.map(tab => tab.id).join(',')}`),
      discard: async tab => calls.push(`discard:${tab.id}`),
      takeover: async () => assert.fail('an already-awake tab must not enter takeover'),
      reload: async () => assert.fail('discard commands do not use the release path')
    });

    assert.deepEqual(result.candidates.map(tab => tab.id), [2]);
    assert.deepEqual(result.takeovers, []);
    assert.deepEqual(calls, shiftKey ?
      ['claim:2', 'refresh:2', 'discard:2'] :
      ['claim:2', 'refresh:2', 'check:2']);
  }

  const directCalls = [];
  const stale = {id: 3, index: 1, active: false, discarded: true, highlighted: false};
  const direct = await runDirectDiscardCommand({
    activate: async () => assert.fail('an inactive target does not need a keeper'),
    allTabs: [stale],
    command: 'discard-tree',
    discard: async tab => directCalls.push(`discard:${tab.id}`),
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('an inactive target is not blocked'),
    refresh: async tab => {
      directCalls.push(`refresh:${tab.id}`);
      return {...tab, discarded: false, frozen: false, status: 'complete'};
    },
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    selected: stale,
    shiftKey: false,
    takeover: async () => assert.fail('an already-awake direct target must not enter takeover'),
    targets: [stale]
  });
  assert.deepEqual(direct.candidates.map(tab => tab.id), [3]);
  assert.deepEqual(direct.takeovers, []);
  assert.deepEqual(directCalls, ['refresh:3', 'discard:3']);
});

test('skips a takeover target that wakes active before execution', async () => {
  for (const shiftKey of [false, true]) {
    const calls = [];
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 5},
      shiftKey,
      query: async () => [{id: 2, index: 3, active: false, discarded: true}],
      resolveFresh: async tab => {
        calls.push(`claim:${tab.id}`);
        return {
          marker: {state: 'owned', source: 'claimed'},
          state: 'discarded',
          tab
        };
      },
      refresh: async tab => {
        calls.push(`refresh:${tab.id}`);
        return {...tab, active: true, discarded: false, frozen: false, status: 'complete'};
      },
      check: async () => assert.fail('a newly active tab must not enter the normal discard pipeline'),
      discard: async () => assert.fail('a newly active tab must not be force-discarded'),
      takeover: async () => assert.fail('an already-awake tab must not enter takeover'),
      reload: async () => assert.fail('discard commands do not use the release path')
    });

    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.takeovers, []);
    assert.deepEqual(result.skipped.map(tab => tab.id), [2]);
    assert.deepEqual(calls, ['claim:2', 'refresh:2']);
  }

  const directCalls = [];
  const stale = {id: 3, index: 1, active: false, discarded: true, highlighted: false};
  const direct = await runDirectDiscardCommand({
    activate: async () => assert.fail('a skipped target does not need a keeper'),
    allTabs: [stale],
    command: 'discard-tree',
    discard: async () => assert.fail('a newly active direct target must not be force-discarded'),
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('a skipped target is not blocked'),
    refresh: async tab => {
      directCalls.push(`refresh:${tab.id}`);
      return {...tab, active: true, discarded: false, frozen: false, status: 'complete'};
    },
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    selected: stale,
    shiftKey: false,
    takeover: async () => assert.fail('an already-awake direct target must not enter takeover'),
    targets: [stale]
  });
  assert.deepEqual(direct.candidates, []);
  assert.deepEqual(direct.takeovers, []);
  assert.deepEqual(direct.skipped.map(tab => tab.id), [3]);
  assert.equal(direct.blocked, false);
  assert.deepEqual(directCalls, ['refresh:3']);
});

test('reclassifies a target that wakes while its takeover waits in the queue', async () => {
  for (const shiftKey of [false, true]) {
    const calls = [];
    let refreshCount = 0;
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 5},
      shiftKey,
      query: async () => [{id: 4, index: 3, active: false, discarded: true}],
      resolveFresh: async tab => ({
        marker: {state: 'owned', source: 'claimed'},
        state: 'discarded',
        tab
      }),
      refresh: async tab => {
        refreshCount += 1;
        calls.push(`refresh:${refreshCount}`);
        return refreshCount === 1 ? tab :
          {...tab, discarded: false, frozen: false, status: 'complete'};
      },
      check: async tabs => calls.push(`check:${tabs.map(tab => tab.id).join(',')}`),
      discard: async tab => calls.push(`discard:${tab.id}`),
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        throw Error(`tab ${tab.id} is no longer an inactive takeover target`);
      },
      reload: async () => assert.fail('discard commands do not use the release path')
    });

    assert.deepEqual(result.candidates.map(tab => tab.id), [4]);
    assert.deepEqual(result.takeovers, []);
    assert.deepEqual(calls, shiftKey ?
      ['refresh:1', 'takeover:4', 'refresh:2', 'discard:4'] :
      ['refresh:1', 'takeover:4', 'refresh:2', 'check:4']);
  }
});

test('skips a target that wakes active while its takeover waits in the queue', async () => {
  for (const shiftKey of [false, true]) {
    const calls = [];
    let refreshCount = 0;
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 5},
      shiftKey,
      query: async () => [{id: 4, index: 3, active: false, discarded: true}],
      resolveFresh: async tab => ({
        marker: {state: 'owned', source: 'claimed'},
        state: 'discarded',
        tab
      }),
      refresh: async tab => {
        refreshCount += 1;
        calls.push(`refresh:${refreshCount}`);
        return refreshCount === 1 ? tab :
          {...tab, active: true, discarded: false, frozen: false, status: 'complete'};
      },
      check: async () => assert.fail('a newly active tab must not enter the normal discard pipeline'),
      discard: async () => assert.fail('a newly active tab must not be force-discarded'),
      takeover: async tab => {
        calls.push(`takeover:${tab.id}`);
        throw Error(`tab ${tab.id} is no longer an inactive takeover target`);
      },
      reload: async () => assert.fail('discard commands do not use the release path')
    });

    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.takeovers, []);
    assert.deepEqual(result.skipped.map(tab => tab.id), [4]);
    assert.deepEqual(calls, ['refresh:1', 'takeover:4', 'refresh:2']);
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
      adopt: async () => assert.fail('Shift must use physical takeover instead of adoption'),
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
    shiftKey: true,
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

test('does not report a normal popup discard command complete when takeover fails', async () => {
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

test('a restarted direct-native frozen or transitional intent is protected without any second operation', async () => {
  for (const tab of [
    {id: 201, active: false, discarded: false, frozen: true, status: 'complete'},
    {id: 202, active: false, discarded: true, frozen: false, status: 'complete'}
  ]) {
    const calls = [];
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 999, index: 9},
      shiftKey: false,
      query: async () => [tab],
      resolveFresh: async current => ({
        marker: {state: 'direct-native-pending', attemptId: `direct-${current.id}`},
        state: current.discarded ? 'discarded' : 'direct-native-pending',
        tab: current
      }),
      check: async () => calls.push('check'),
      discard: async () => calls.push('discard'),
      takeover: async () => calls.push('takeover'),
      reload: async () => calls.push('reload')
    });
    assert.deepEqual(calls, [], `tab ${tab.id}`);
    assert.deepEqual(result.protected.map(entry => entry.tab.id), [tab.id]);
    assert.deepEqual(result.takeovers, []);
    assert.deepEqual(result.succeeded, []);
  }

  const bothFalse = {
    id: 205,
    active: false,
    discarded: false,
    frozen: false,
    status: 'complete'
  };
  const calls = [];
  const transitional = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 999, index: 9},
    shiftKey: false,
    query: async () => [bothFalse],
    hasBlockingNativeIntent: async id => id === bothFalse.id,
    resolveFresh: async tab => ({state: 'loaded', tab}),
    check: async () => calls.push('check'),
    discard: async () => calls.push('discard'),
    takeover: async () => calls.push('takeover'),
    reload: async () => calls.push('reload')
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(transitional.protected.map(entry => entry.tab.id), [bothFalse.id]);

  const unattributed = {
    id: 206,
    active: false,
    discarded: true,
    frozen: false,
    status: 'unloaded'
  };
  const orphanCalls = [];
  const orphan = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 999, index: 9},
    shiftKey: false,
    query: async () => [unattributed],
    resolveFresh: async tab => ({
      nativeOrphan: true,
      state: 'direct-native-orphan',
      tab
    }),
    check: async () => orphanCalls.push('check'),
    discard: async () => orphanCalls.push('discard'),
    takeover: async () => orphanCalls.push('takeover'),
    reload: async () => orphanCalls.push('reload')
  });
  assert.deepEqual(orphanCalls, []);
  assert.deepEqual(orphan.protected.map(entry => entry.tab.id), [unattributed.id]);
  assert.deepEqual(orphan.takeovers, []);
});

test('structured direct frozen success exposes visual warning once and repeat stays a skipped no-op', async () => {
  const frozen = {id: 203, active: false, discarded: false, frozen: true, status: 'complete'};
  const first = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 999, index: 9},
    shiftKey: false,
    query: async () => [frozen],
    resolveFresh: async tab => ({state: 'loaded', tab}),
    check: async () => assert.fail('frozen target must not enter check'),
    discard: async () => assert.fail('frozen target must not enter ordinary discard'),
    takeover: async tab => ({
      ok: true,
      physicalOnly: true,
      visualUnavailable: true,
      reason: 'frozen renderer visual unavailable',
      tab: {...tab, discarded: true, frozen: false, status: 'unloaded'}
    }),
    reload: async () => assert.fail('discard command must not reload')
  });
  assert.deepEqual(first.physicalOnly.map(entry => entry.tab.id), [frozen.id]);
  assert.deepEqual(first.succeeded.map(entry => entry.tab.id), [frozen.id]);

  const physicalSelf = {...frozen, discarded: true, frozen: false, status: 'unloaded'};
  let touched = false;
  const repeat = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 999, index: 9},
    shiftKey: false,
    query: async () => [physicalSelf],
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'self', visual: {
        complete: false, favicon: false, physicalOnly: true, repair: false, title: false
      }},
      state: 'discarded',
      tab
    }),
    check: async () => { touched = true; },
    discard: async () => { touched = true; },
    takeover: async () => { touched = true; },
    reload: async () => { touched = true; }
  });
  assert.equal(touched, false);
  assert.deepEqual(repeat.alreadyOwnedPhysicalOnly.map(entry => entry.tab.id), [frozen.id]);
  assert.deepEqual(repeat.physicalOnly, []);
  assert.deepEqual(repeat.succeeded, []);
});

test('an ordinary incomplete self marker is not relabelled as a frozen physical-only takeover', async () => {
  const tab = {id: 204, active: false, discarded: true, status: 'unloaded'};
  const result = await prepareDiscardTargets('discard-tabs', [tab], async () => ({
    marker: {state: 'owned', source: 'self', visual: {
      complete: false, favicon: false, repair: false, title: false
    }},
    state: 'discarded',
    tab
  }));
  assert.deepEqual(result.alreadyOwned.map(value => value.id), [tab.id]);
  assert.deepEqual(result.alreadyOwnedPhysicalOnly, []);
});

test('direct discard reports mixed loaded outcomes without hiding the failed tab', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://one.example/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'https://two.example/'}
  ];
  const result = await runDirectDiscardCommand({
    activate: async () => assert.fail('inactive targets do not need a keeper'),
    allTabs: tabs,
    command: 'discard-tree',
    discard: async tab => tab.id === 1,
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('inactive targets do not need a keeper'),
    selected: tabs[0],
    takeover: async () => true,
    targets: tabs
  });

  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [1]);
  assert.deepEqual(result.failed.map(entry => entry.tab.id), [2]);
  assert.equal(result.failed[0].reason, 'loaded discard returned false');
});

test('direct discard throws an aggregate carrying every false and thrown loaded outcome', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://one.example/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'https://two.example/'}
  ];
  let caught;
  try {
    await runDirectDiscardCommand({
      activate: async () => assert.fail('inactive targets do not need a keeper'),
      allTabs: tabs,
      command: 'discard-tree',
      discard: async tab => {
        if (tab.id === 2) {
          throw Error('native failure');
        }
        return false;
      },
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('inactive targets do not need a keeper'),
      selected: tabs[0],
      takeover: async () => true,
      targets: tabs
    });
  }
  catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AggregateError);
  assert.match(caught.message, /all 2 intended loaded tab discards failed/);
  assert.deepEqual(caught.result.succeeded, []);
  assert.deepEqual(caught.result.failed.map(entry => [entry.tab.id, entry.reason]), [
    [1, 'loaded discard returned false'],
    [2, 'loaded discard failed: native failure']
  ]);
});

test('Shift bulk discard aggregates loaded results and throws only when every attempt fails', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://one.example/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'https://two.example/'}
  ];
  const partial = await runScopedCommand({
    command: 'discard-tabs',
    discard: async tab => tab.id === 1,
    query: async () => tabs,
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => true
  });
  assert.deepEqual(partial.succeeded.map(entry => entry.tab.id), [1]);
  assert.deepEqual(partial.failed.map(entry => entry.tab.id), [2]);

  await assert.rejects(runScopedCommand({
    command: 'discard-tabs',
    discard: async () => false,
    query: async () => tabs,
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => true
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.result.failed.map(entry => entry.tab.id), [1, 2]);
    return true;
  });
});

test('normal bulk discard merges truthful check outcomes and deduplicates identical failures', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://one.example/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'https://two.example/'},
    {id: 3, index: 3, active: false, discarded: false, url: 'https://three.example/'}
  ];
  const result = await runScopedCommand({
    check: async candidates => ({
      failed: [
        {tab: candidates[1], reason: 'loaded discard returned false'},
        {tab: candidates[1], reason: 'loaded discard returned false'}
      ],
      protected: [{tab: candidates[2], reason: 'tab contains an unsaved form'}],
      succeeded: [{tab: candidates[0]}]
    }),
    command: 'discard-tabs',
    discard: async () => assert.fail('normal commands use the metadata check'),
    query: async () => tabs,
    selected: {id: 99, index: 9},
    shiftKey: false,
    takeover: async () => true
  });

  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [1]);
  assert.deepEqual(result.failed.map(entry => entry.tab.id), [2]);
  assert.deepEqual(result.protected.map(entry => entry.tab.id), [3]);
});

test('normal bulk discard exposes a check throw as an all-failed aggregate result', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://one.example/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'https://two.example/'}
  ];
  await assert.rejects(runScopedCommand({
    check: async () => {
      throw Error('metadata pipeline stopped');
    },
    command: 'discard-tabs',
    discard: async () => assert.fail('normal commands use the metadata check'),
    query: async () => tabs,
    selected: {id: 99, index: 9},
    shiftKey: false,
    takeover: async () => true
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.result.failed.map(entry => [entry.tab.id, entry.reason]), [
      [1, 'normal discard check failed: metadata pipeline stopped'],
      [2, 'normal discard check failed: metadata pipeline stopped']
    ]);
    return true;
  });
});

test('a physical-only success makes a loaded failure an explicit partial Shift result', async () => {
  const loaded = {
    id: 1,
    index: 1,
    active: false,
    discarded: false,
    url: 'https://example.com/'
  };
  const restricted = {
    id: 2,
    index: 2,
    active: false,
    discarded: false,
    url: 'edge://settings/'
  };
  const result = await runScopedCommand({
    command: 'discard-tabs',
    discard: async tab => tab.id === restricted.id,
    query: async () => [loaded, restricted],
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => true
  });

  assert.deepEqual(result.failed.map(entry => entry.tab.id), [loaded.id]);
  assert.deepEqual(result.physicalOnly.map(entry => entry.tab.id), [restricted.id]);
  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [restricted.id]);
});

test('a successful takeover makes a loaded failure an explicit partial result', async () => {
  const loaded = {
    id: 1,
    index: 1,
    active: false,
    discarded: false,
    url: 'https://example.com/'
  };
  const suspended = {
    id: 2,
    index: 2,
    active: false,
    discarded: true,
    url: 'https://example.net/'
  };
  const result = await runScopedCommand({
    command: 'discard-tabs',
    discard: async () => false,
    query: async () => [loaded, suspended],
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => true
  });

  assert.deepEqual(result.failed.map(entry => entry.tab.id), [loaded.id]);
  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [suspended.id]);
});

test('a direct group keeps successful targets when one sibling takeover fails', async () => {
  const selected = {
    id: 10,
    index: 0,
    windowId: 1,
    active: true,
    discarded: false,
    status: 'complete',
    url: 'https://selected.example/'
  };
  const keeper = {
    id: 11,
    index: 1,
    windowId: 1,
    active: false,
    discarded: false,
    highlighted: false,
    status: 'complete',
    url: 'https://keeper.example/'
  };
  const successful = {
    id: 12,
    index: 2,
    windowId: 1,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://successful.example/'
  };
  const failed = {
    id: 13,
    index: 3,
    windowId: 1,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://failed.example/'
  };

  const result = await runDirectDiscardCommand({
    activate: async tab => {
      selected.active = false;
      tab.active = true;
    },
    allTabs: [selected, keeper, successful, failed],
    command: 'discard-tree',
    discard: async () => true,
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('the explicit keeper is eligible'),
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    selected,
    shiftKey: true,
    takeover: async tab => tab.id === successful.id,
    targets: [selected, successful, failed]
  });

  assert.deepEqual(result.succeeded.map(entry => entry.tab.id).sort((a, b) => a - b), [10, 12]);
  assert.deepEqual(result.failed.map(entry => entry.tab.id), [13]);
  assert.match(result.failed[0].reason, /takeover returned false/);
  assert.equal(result.keeper.id, keeper.id);
});

test('normal commands never wake self-owned or external tabs when ownership storage fails', async () => {
  const tabs = [
    {
      expectedOwner: 'self',
      id: 1,
      index: 1,
      active: false,
      discarded: true,
      url: 'https://self.example/'
    },
    {
      expectedOwner: 'external',
      id: 2,
      index: 2,
      active: false,
      discarded: true,
      url: 'https://external.example/'
    }
  ];
  const attempts = new Map();

  await assert.rejects(runScopedCommand({
    check: async () => assert.fail('unknown unloaded tabs cannot enter the loaded check'),
    command: 'discard-tabs',
    discard: async () => assert.fail('unknown unloaded tabs cannot enter loaded discard'),
    query: async () => tabs,
    resolveFresh: async tab => {
      attempts.set(tab.id, (attempts.get(tab.id) || 0) + 1);
      throw Error(`storage unavailable for ${tab.expectedOwner}`);
    },
    selected: {id: 99, index: 9},
    shiftKey: false,
    takeover: async () => assert.fail('normal ownership failure must never wake a tab')
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.result.takeovers, []);
    assert.deepEqual(error.result.unknownOwnership.map(entry => entry.tab.id), [1, 2]);
    assert.deepEqual(error.result.failed.map(entry => [entry.tab.id, entry.retryable]), [
      [1, true],
      [2, true]
    ]);
    assert.equal(error.result.errors.length, 2);
    return true;
  });
  assert.deepEqual([...attempts], [[1, 1], [2, 1]]);
});

test('Shift retries one fresh read and distinguishes recovered self from external ownership', async () => {
  const self = {
    id: 1,
    index: 1,
    active: false,
    discarded: true,
    url: 'https://self.example/'
  };
  const external = {
    id: 2,
    index: 2,
    active: false,
    discarded: true,
    url: 'https://external.example/'
  };
  const attempts = new Map();
  const woken = [];
  const result = await runScopedCommand({
    check: async () => assert.fail('recovered unloaded tabs do not enter the loaded check'),
    command: 'discard-tabs',
    discard: async () => assert.fail('recovered unloaded tabs do not enter loaded discard'),
    query: async () => [self, external],
    resolveFresh: async tab => {
      const attempt = (attempts.get(tab.id) || 0) + 1;
      attempts.set(tab.id, attempt);
      if (attempt === 1) {
        throw Error(`transient storage failure for ${tab.id}`);
      }
      return {
        marker: {
          state: 'owned',
          source: tab.id === self.id ? 'self' : 'claimed'
        },
        state: 'discarded',
        tab
      };
    },
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async tab => {
      woken.push(tab.id);
      return true;
    }
  });

  assert.deepEqual([...attempts], [[1, 2], [2, 2]]);
  assert.deepEqual(result.alreadyOwned.map(tab => tab.id), [self.id]);
  assert.deepEqual(result.takeovers.map(tab => tab.id), [external.id]);
  assert.deepEqual(woken, [external.id]);
  assert.deepEqual(result.unknownOwnership, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.errors.length, 2);
});

test('Shift fails closed when its fresh ownership retry is still erroneous', async () => {
  const tab = {
    id: 1,
    index: 1,
    active: false,
    discarded: true,
    url: 'https://unknown.example/'
  };
  let attempts = 0;

  await assert.rejects(runScopedCommand({
    check: async () => assert.fail('unknown unloaded tab cannot enter the loaded check'),
    command: 'discard-tabs',
    discard: async () => assert.fail('unknown unloaded tab cannot enter loaded discard'),
    query: async () => [tab],
    resolveFresh: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Error('storage read rejected');
      }
      return {
        error: Error('storage retry remained unstable'),
        state: 'discarded',
        tab,
        unstable: true
      };
    },
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => assert.fail('an unsuccessful retry must never wake the tab')
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.result.errors.length, 2);
    assert.equal(error.result.unknownOwnership[0].attempts, 2);
    assert.match(error.result.failed[0].reason, /ownership resolution retry failed/);
    assert.equal(error.result.failed[0].retryable, true);
    return true;
  });
  assert.equal(attempts, 2);
});

test('Shift routes an authoritative awake retry to loaded discard without takeover', async () => {
  const stale = {
    id: 1,
    index: 1,
    active: false,
    discarded: true,
    url: 'https://awake.example/'
  };
  let attempts = 0;
  const calls = [];
  const result = await runScopedCommand({
    command: 'discard-tabs',
    discard: async tab => {
      calls.push(`discard:${tab.id}`);
      return true;
    },
    query: async () => [stale],
    resolveFresh: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Error('transient storage failure');
      }
      return {
        state: 'loaded',
        tab: {...stale, discarded: false, status: 'complete'}
      };
    },
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => assert.fail('an authoritative awake retry uses loaded discard')
  });

  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['discard:1']);
  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [1]);
  assert.equal(result.errors.length, 1);
});

test('direct ownership failures stay asleep and Shift receives only one retry', async () => {
  const tab = {
    id: 1,
    index: 1,
    active: false,
    discarded: true,
    highlighted: false,
    url: 'https://direct-unknown.example/'
  };

  for (const shiftKey of [false, true]) {
    let attempts = 0;
    await assert.rejects(runDirectDiscardCommand({
      activate: async () => assert.fail('inactive unknown target does not need a keeper'),
      allTabs: [tab],
      command: 'discard-tab',
      discard: async () => assert.fail('unknown unloaded target cannot use loaded discard'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('inactive unknown target is not keeper-blocked'),
      resolveFresh: async () => {
        attempts += 1;
        throw Error('session storage unavailable');
      },
      selected: tab,
      shiftKey,
      takeover: async () => assert.fail('unknown ownership must never wake'),
      targets: [tab]
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.result.takeovers, []);
      assert.equal(error.result.failed[0].retryable, true);
      return true;
    });
    assert.equal(attempts, shiftKey ? 2 : 1);
  }
});
