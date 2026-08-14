import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  runDirectDiscardCommand,
  runScopedCommand
} from '../v3/worker/core/command-scope.mjs';

const safePolicy = Object.freeze({
  audio: false,
  form: false,
  mode: 'time-based',
  paused: false,
  period: 0,
  pinned: false,
  whitelist: [],
  'notification.permission': false,
  'whitelist-url': [],
  'whitelist.session': []
});

const claimed = tab => ({
  marker: {state: 'owned', source: 'claimed'},
  state: 'discarded',
  tab
});

const suspended = (overrides = {}) => ({
  id: 2,
  index: 3,
  active: false,
  autoDiscardable: true,
  discarded: false,
  frozen: true,
  lastAccessed: 1,
  pinned: false,
  url: 'https://suspended.example/',
  ...overrides
});

const externallyDiscarded = (overrides = {}) => suspended({
  discarded: true,
  frozen: false,
  ...overrides
});

test('normal explicit commands protect a statically protected external discard', async () => {
  const tab = externallyDiscarded({
    autoDiscardable: false,
    pinned: true,
    url: 'https://protected.example/draft'
  });
  const calls = [];
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [tab],
    resolveFresh: async target => claimed(target),
    check: async () => assert.fail('an external discard must not enter loaded metadata'),
    discard: async () => assert.fail('an external discard must use ownership takeover'),
    suspendedPolicy: {
      ...safePolicy,
      form: true,
      period: 600,
      pinned: true,
      whitelist: ['protected.example']
    },
    takeover: async target => calls.push(target.id)
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result.takeovers, []);
  assert.deepEqual(result.protected.map(entry => entry.tab.id), [2]);
  assert.deepEqual(result.bypassed, []);
});

test('Shift takes over one protected external discard and retains every reason', async () => {
  const tab = externallyDiscarded({
    autoDiscardable: false,
    pinned: true,
    url: 'https://protected.example/draft'
  });
  const calls = [];
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: true,
    query: async () => [tab],
    resolveFresh: async target => claimed(target),
    discard: async () => assert.fail('external discard must use takeover'),
    suspendedPolicy: {...safePolicy, pinned: true, whitelist: ['protected.example']},
    takeover: async target => {
      calls.push(target.id);
      return true;
    }
  });
  assert.deepEqual(calls, [2]);
  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [2]);
  assert.deepEqual(result.bypassed.map(entry => entry.tab.id), [2]);
  assert.ok(result.bypassed[0].reasons.some(reason => /whitelist/.test(reason)));
  assert.ok(result.bypassed[0].reasons.some(reason => /pinned/.test(reason)));
  assert.ok(result.bypassed[0].reasons.some(reason => /automatically discardable/.test(reason)));
});

test('normal scoped commands protect suspended tabs before takeover', async () => {
  const tab = suspended({url: 'https://protected.example/draft'});
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [tab],
    resolveFresh: async target => claimed(target),
    check: async () => assert.fail('a suspended target must not enter loaded metadata'),
    discard: async () => assert.fail('a suspended target must not use ordinary discard'),
    suspendedPolicy: {
      ...safePolicy,
      whitelist: ['protected.example']
    },
    takeover: async () => assert.fail('normal protection must stop takeover')
  });

  assert.deepEqual(result.takeovers, []);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.protected.map(entry => entry.tab.id), [2]);
  assert.match(result.protected[0].reason, /whitelist/);
  assert.deepEqual(result.bypassed, []);
});

test('Shift explicitly bypasses suspended protection without losing its audit reasons', async () => {
  const tab = suspended({
    autoDiscardable: false,
    pinned: true,
    url: 'https://protected.example/draft'
  });
  const calls = [];
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: true,
    query: async () => [tab],
    resolveFresh: async target => claimed(target),
    check: async () => assert.fail('Shift does not run normal metadata checks'),
    discard: async () => assert.fail('a suspended target must use takeover'),
    suspendedPolicy: {
      ...safePolicy,
      form: true,
      pinned: true,
      whitelist: ['protected.example']
    },
    takeover: async target => {
      calls.push(target.id);
      return true;
    }
  });

  assert.deepEqual(calls, [2]);
  assert.deepEqual(result.protected, []);
  assert.deepEqual(result.bypassed.map(entry => entry.tab.id), [2]);
  assert.ok(result.bypassed[0].reasons.some(reason => reason.includes('whitelist')));
  assert.ok(result.bypassed[0].reasons.some(reason => reason.includes('not automatically discardable')));
  assert.ok(result.bypassed[0].reasons.some(reason => reason.includes('unsaved-form')));
});

test('issue 3: every suspended protection is explicit for discarded and Edge-frozen targets', async () => {
  const cases = [
    {
      name: 'persistent whitelist',
      policy: {whitelist: ['protected.example']},
      reason: /whitelist/,
      tab: {url: 'https://protected.example/draft'}
    },
    {
      name: 'session whitelist',
      policy: {'whitelist.session': ['protected.example']},
      reason: /whitelist/,
      tab: {url: 'https://protected.example/draft'}
    },
    {
      name: 'URL-mode allowlist',
      policy: {mode: 'url-based', 'whitelist-url': ['allowed.example']},
      reason: /outside the URL-based discard list/,
      tab: {url: 'https://protected.example/draft'}
    },
    {
      name: 'pinned',
      policy: {pinned: true},
      reason: /pinned-tab protection/,
      tab: {pinned: true}
    },
    {
      name: 'autoDiscardable',
      policy: {},
      reason: /not automatically discardable/,
      tab: {autoDiscardable: false}
    },
    {
      name: 'audible',
      policy: {audio: true},
      reason: /tab is audible/,
      tab: {audible: true}
    },
    {
      name: 'recent access',
      policy: {period: 60},
      reason: /not old enough/,
      tab: {lastAccessed: Date.now()}
    },
    {
      name: 'unknown access age',
      policy: {period: 60},
      reason: /last-accessed time is unavailable/,
      tab: {lastAccessed: undefined}
    },
    {
      name: 'unsaved-form state',
      policy: {form: true},
      reason: /unsaved-form state cannot be verified/,
      rendererOnly: true,
      tab: {}
    },
    {
      name: 'picture-in-picture state',
      policy: {audio: true},
      reason: /picture-in-picture state cannot be verified/,
      rendererOnly: true,
      tab: {audible: false}
    },
    {
      name: 'paused-media state',
      policy: {paused: true},
      reason: /paused-media state cannot be verified/,
      rendererOnly: true,
      tab: {}
    },
    {
      name: 'notification state',
      policy: {'notification.permission': true},
      reason: /notification permission cannot be verified/,
      rendererOnly: true,
      tab: {}
    }
  ];
  let id = 1_000;

  const execute = async ({definition, medium, shiftKey}) => {
    const tab = medium === 'discarded' ? externallyDiscarded({
      id: id++,
      windowId: 1,
      ...definition.tab
    }) : suspended({
      id: id++,
      windowId: 1,
      ...definition.tab
    });
    const takeovers = [];
    const settledMarkers = new Map();
    const result = await runScopedCommand({
      check: async () => assert.fail(`${definition.name}/${medium}: suspended target entered metadata`),
      command: 'discard-tabs',
      discard: async () => assert.fail(`${definition.name}/${medium}: suspended target used loaded discard`),
      query: async () => [tab],
      resolveFresh: async target => claimed(target),
      selected: {id: 999, incognito: false, index: 99, windowId: 1},
      shiftKey,
      suspendedPolicy: {...safePolicy, ...definition.policy},
      takeover: async target => {
        takeovers.push(target.id);
        settledMarkers.set(target.id, {source: 'self', state: 'owned'});
        return {
          ok: true,
          tab: {...target, discarded: true, frozen: false, status: 'unloaded'}
        };
      }
    });
    return {result, settledMarkers, tab, takeovers};
  };

  for (const definition of cases) {
    for (const medium of ['discarded', 'frozen']) {
      // A browser-discarded renderer no longer has form/PiP/media/notification
      // state to preserve. The matrix still covers that medium explicitly and
      // proves that the worker does not invent renderer state. Edge-frozen
      // renderers retain it and therefore fail closed when it is unavailable.
      const protectedNormally = definition.rendererOnly !== true || medium === 'frozen';
      const normal = await execute({definition, medium, shiftKey: false});
      if (protectedNormally) {
        assert.deepEqual(normal.takeovers, [], `${definition.name}/${medium}: normal wake`);
        assert.equal(normal.result.protected.length, 1, `${definition.name}/${medium}: protected count`);
        assert.match(normal.result.protected[0].reason, definition.reason,
          `${definition.name}/${medium}: protected reason`);
      }
      else {
        assert.deepEqual(normal.takeovers, [normal.tab.id],
          `${definition.name}/${medium}: destroyed renderer must not invent protection`);
        assert.deepEqual(normal.result.protected, [], `${definition.name}/${medium}: invented protection`);
      }

      const forced = await execute({definition, medium, shiftKey: true});
      assert.deepEqual(forced.takeovers, [forced.tab.id],
        `${definition.name}/${medium}: Shift must execute exactly once`);
      assert.deepEqual(forced.settledMarkers.get(forced.tab.id), {
        source: 'self',
        state: 'owned'
      }, `${definition.name}/${medium}: Shift settlement`);
      assert.equal(forced.result.succeeded.length, 1,
        `${definition.name}/${medium}: Shift success accounting`);
      if (protectedNormally) {
        assert.equal(forced.result.bypassed.length, 1,
          `${definition.name}/${medium}: Shift bypass audit`);
        assert.match(forced.result.bypassed[0].reason, definition.reason,
          `${definition.name}/${medium}: Shift bypass reason`);
      }
      else {
        assert.deepEqual(forced.result.bypassed, [],
          `${definition.name}/${medium}: no nonexistent state may be bypassed`);
      }
    }
  }
});

test('a failed policy read fails closed normally but Shift can still force', async () => {
  for (const shiftKey of [false, true]) {
    const calls = [];
    const tab = suspended();
    const result = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 5},
      shiftKey,
      query: async () => [tab],
      resolveFresh: async target => claimed(target),
      check: async () => assert.fail('the target remains suspended'),
      discard: async () => assert.fail('the target remains suspended'),
      suspendedPolicy: async () => {
        throw Error('storage unavailable');
      },
      takeover: async target => {
        calls.push(target.id);
        return true;
      }
    });

    assert.deepEqual(calls, shiftKey ? [2] : []);
    assert.deepEqual(result.protected.map(entry => entry.tab.id), shiftKey ? [] : [2]);
    assert.deepEqual(result.bypassed.map(entry => entry.tab.id), shiftKey ? [2] : []);
    const entry = shiftKey ? result.bypassed[0] : result.protected[0];
    assert.match(entry.reason, /storage unavailable/);
  }
});

test('incomplete self-marker repair is not blocked by loaded-tab protections', async () => {
  const tab = externallyDiscarded({id: 7, url: 'https://repair.example/'});
  const calls = [];
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [tab],
    resolveFresh: async target => ({
      marker: {
        state: 'owned',
        source: 'self',
        visual: {complete: false, repair: true}
      },
      state: 'discarded',
      tab: target
    }),
    check: async () => assert.fail('repair remains suspended'),
    discard: async () => assert.fail('repair remains suspended'),
    suspendedPolicy: {...safePolicy, form: true},
    takeover: async target => {
      calls.push(target.id);
      return true;
    }
  });

  assert.deepEqual(calls, [7]);
  assert.deepEqual(result.markerRepairs.map(entry => entry.id), [7]);
  assert.deepEqual(result.takeovers.map(entry => entry.id), [7]);
  assert.deepEqual(result.protected, []);
});

test('protected suspended filtering preserves physical and unsupported scheme arrays', async () => {
  const physical = externallyDiscarded({id: 3, url: 'edge://settings/'});
  const unsupported = externallyDiscarded({id: 4, url: 'mailto:user@example.test'});
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [physical, unsupported],
    resolveFresh: async target => claimed(target),
    check: async () => assert.fail('restricted URLs never enter loaded metadata'),
    discard: async () => assert.fail('normal restricted pages stay protected'),
    suspendedPolicy: safePolicy,
    takeover: async () => assert.fail('restricted URLs never enter renderer takeover')
  });

  assert.deepEqual(result.physicalOnly.map(entry => entry.tab.id), [3]);
  assert.deepEqual(result.unsupported.map(entry => entry.tab.id), [4]);
  assert.deepEqual(result.markerRepairs, []);
  assert.deepEqual(result.takeovers, []);
});

test('a takeover wake race still reroutes to the normal loaded check', async () => {
  const tab = suspended();
  const calls = [];
  let refreshes = 0;
  const result = await runScopedCommand({
    command: 'discard-tabs',
    selected: {id: 99, index: 5},
    shiftKey: false,
    query: async () => [tab],
    resolveFresh: async target => claimed(target),
    refresh: async target => {
      refreshes += 1;
      return refreshes === 1 ? target : {
        ...target,
        discarded: false,
        frozen: false,
        status: 'complete'
      };
    },
    check: async tabs => {
      calls.push(`check:${tabs.map(target => target.id).join(',')}`);
      return {succeeded: tabs};
    },
    discard: async () => assert.fail('normal loaded rerouting uses check'),
    suspendedPolicy: safePolicy,
    takeover: async () => {
      calls.push('takeover');
      throw Error('tab 2 is no longer an inactive takeover target');
    }
  });

  assert.deepEqual(calls, ['takeover', 'check:2']);
  assert.deepEqual(result.takeovers, []);
  assert.deepEqual(result.candidates.map(entry => entry.id), [2]);
  assert.deepEqual(result.succeeded.map(entry => entry.tab.id), [2]);
});

test('direct suspended commands use the same normal protection and Shift bypass', async () => {
  for (const shiftKey of [false, true]) {
    const tab = suspended({url: 'https://protected.example/'});
    const calls = [];
    const result = await runDirectDiscardCommand({
      activate: async () => assert.fail('inactive target does not need a keeper'),
      allTabs: [tab],
      command: 'discard-tab',
      discard: async () => assert.fail('suspended target uses takeover'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('inactive target has no keeper requirement'),
      resolveFresh: async target => claimed(target),
      selected: tab,
      shiftKey,
      suspendedPolicy: {...safePolicy, whitelist: ['protected.example']},
      takeover: async target => {
        calls.push(target.id);
        return true;
      },
      targets: [tab]
    });

    assert.deepEqual(calls, shiftKey ? [2] : []);
    assert.deepEqual(result.protected.map(entry => entry.tab.id), shiftKey ? [] : [2]);
    assert.deepEqual(result.bypassed.map(entry => entry.tab.id), shiftKey ? [2] : []);
  }
});

test('menu supplies one lazy local and session policy to direct and scoped commands', () => {
  const source = readFileSync(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');

  assert.match(source,
    /import \{SUSPENDED_POLICY_DEFAULTS\} from '\.\/core\/suspended-protection\.mjs';/);
  assert.match(source, /const suspendedPolicy = async \(\) => Object\.assign\(\s*await storage\(SUSPENDED_POLICY_DEFAULTS\),\s*number\.IGNORE,\s*await storage\(\{'whitelist\.session': \[\]\}, 'session'\)\s*\);/s);
  assert.equal((source.match(/\bsuspendedPolicy,/g) || []).length, 2,
    'both direct and scoped command calls must receive the lazy provider');
});
