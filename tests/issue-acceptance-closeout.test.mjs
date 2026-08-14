import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import {
  releaseCommands,
  runDirectDiscardCommand,
  runScopedCommand
} from '../v3/worker/core/command-scope.mjs';
import {runEntryCommand} from '../v3/worker/core/entry.mjs';
import {
  createPopupProgressManager,
  POPUP_CODES
} from '../v3/worker/core/popup-progress.mjs';
import {FAILURE_CAUSES} from '../v3/worker/core/failure-causes.mjs';
import {
  commitSettingsImport,
  parseSettingsBackup,
  RAW_BACKUP_LABEL,
  serializeRawSettingsBackup,
  SettingsBackupError
} from '../v3/data/options/core/settings-backup.mjs';
import {
  clearRuleCache,
  evaluateRuleList,
  RULE_LIMITS,
  validateRuleList
} from '../v3/worker/core/rules.mjs';

const runGcProbe = source => {
  const child = spawnSync(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '--eval',
    source
  ], {
    encoding: 'utf8',
    timeout: 15_000
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, 'isolated benchmark must emit one JSON result');
  return JSON.parse(line);
};

const sortedIds = values => values.map(value => value?.tab?.id ?? value?.id ?? value)
  .toSorted((a, b) => a - b);

test('issue 2: unconfirmed discard results fail visibly for all seven discard commands', async () => {
  const commands = [
    'discard-tab',
    'discard-tree',
    'discard-window',
    'discard-rights',
    'discard-lefts',
    'discard-other-windows',
    'discard-tabs'
  ];
  const unconfirmed = [
    ['false', false],
    ['undefined', undefined],
    ['null', null],
    ['empty-object', {}],
    ['unknown-status', {status: 'unknown'}]
  ];

  for (const [resultOrdinal, [resultLabel, discardResult]] of unconfirmed.entries()) {
    for (const [ordinal, command] of commands.entries()) {
      const assertionLabel = `${command}/${resultLabel}`;
      const selected = {
        active: false,
        discarded: false,
        frozen: false,
        id: 10_000 + resultOrdinal * 1_000 + ordinal * 10,
        incognito: false,
        index: 5,
        status: 'complete',
        url: `https://selected-${command}.example/`,
        windowId: 100 + ordinal,
        windowType: 'normal'
      };
      const target = command === 'discard-tab' || command === 'discard-tree' ? selected : {
        ...selected,
        active: false,
        id: selected.id + 1,
        index: command === 'discard-rights' ? 6 : 4,
        url: `https://target-${command}.example/`,
        windowId: command === 'discard-other-windows' ? selected.windowId + 1 : selected.windowId
      };
      const manager = createPopupProgressManager();
      const request = {cmd: command, tabId: selected.id, windowId: selected.windowId};
      const snapshot = await manager.run(request, async progress => {
        await progress.addTargets([target]);
        if (command === 'discard-tab' || command === 'discard-tree') {
          return runDirectDiscardCommand({
            activate: async () => assert.fail(`${command}: inactive target needs no keeper`),
            allTabs: [target],
            command,
            discard: async () => discardResult,
            inProgress: () => false,
            notifyNoKeeper: () => assert.fail(`${command}: inactive target is not keeper-blocked`),
            selected,
            shiftKey: true,
            takeover: async () => assert.fail(`${command}: loaded target must not use takeover`),
            targets: [target]
          });
        }
        return runScopedCommand({
          check: async () => assert.fail(`${command}: Shift must use the forced loaded path`),
          command,
          discard: async () => discardResult,
          query: async () => [target],
          selected,
          shiftKey: true,
          takeover: async () => assert.fail(`${command}: loaded target must not use takeover`)
        });
      });

      assert.equal(snapshot.state, 'failed', assertionLabel);
      assert.equal(snapshot.errorCode, POPUP_CODES.COMMAND_FAILED, assertionLabel);
      assert.deepEqual(snapshot.summary, {failed: 1, skipped: 0, success: 0}, assertionLabel);
      assert.deepEqual(snapshot.outcomes[target.id], {
        code: POPUP_CODES.TAB_FAILED,
        failureCause: FAILURE_CAUSES.OPERATION_FAILED,
        status: 'failed',
        tabId: target.id
      }, assertionLabel);
      assert.deepEqual(await manager.snapshot(request), snapshot,
        `${assertionLabel}: useful terminal failure must remain available after popup recreation`);
    }
  }
});

test('issue 8: mixed no-keeper group settles loaded, frozen, and external children', async () => {
  const active = {
    id: 1,
    index: 0,
    active: true,
    discarded: false,
    frozen: false,
    highlighted: true
  };
  const loaded = {
    id: 2,
    index: 1,
    active: false,
    discarded: false,
    frozen: false,
    highlighted: false
  };
  const frozen = {
    id: 3,
    index: 2,
    active: false,
    discarded: false,
    frozen: true,
    highlighted: false
  };
  const external = {
    id: 4,
    index: 3,
    active: false,
    discarded: true,
    frozen: false,
    highlighted: false,
    status: 'unloaded'
  };
  const calls = [];
  const result = await runDirectDiscardCommand({
    activate: async () => assert.fail('no keeper exists'),
    allTabs: [active, loaded, frozen, external],
    command: 'discard-tree',
    discard: async tab => {
      calls.push(`discard:${tab.id}`);
      return true;
    },
    inProgress: () => false,
    notifyNoKeeper: () => calls.push('no-keeper'),
    refresh: async tab => tab,
    resolveFresh: async tab => ({
      marker: {state: 'owned', source: 'claimed'},
      state: 'discarded',
      tab
    }),
    selected: active,
    takeover: async tab => {
      calls.push(`takeover:${tab.id}`);
      return true;
    },
    targets: [active, loaded, frozen, external]
  });

  assert.equal(result.blocked, true);
  assert.equal(result.keeper, null);
  assert.deepEqual(sortedIds(result.succeeded), [2, 3, 4]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.protected, []);
  assert.deepEqual(calls.toSorted(), [
    'discard:2',
    'no-keeper',
    'takeover:3',
    'takeover:4'
  ]);
  assert.equal(calls.some(call => call.endsWith(':1')), false,
    'the active root must remain loaded');

  const entry = await runEntryCommand('discard-tree', async () => result, async () => {});
  assert.equal(entry.ok, true);
  assert.equal(entry.partial, true);
  assert.equal(entry.code, 'TAB_NO_SAFE_KEEPER');
  assert.match(entry.reasons[0], /no safe keeper/);
});

test('issue 9: all five release scopes wake only their mixed frozen/discarded targets', async () => {
  const selected = {id: 99, index: 5, windowId: 1, incognito: false};
  const tabs = [
    {id: 1, windowId: 1, index: 1, active: false, discarded: false, frozen: true},
    {id: 2, windowId: 1, index: 2, active: false, discarded: true, frozen: false},
    {id: 3, windowId: 1, index: 7, active: false, discarded: false, frozen: true},
    {id: 4, windowId: 1, index: 8, active: false, discarded: true, frozen: false},
    {id: 5, windowId: 2, index: 1, active: false, discarded: false, frozen: true},
    {id: 6, windowId: 2, index: 2, active: false, discarded: true, frozen: false}
  ];
  const expected = {
    'release-window': [1, 2, 3, 4],
    'release-rights': [3, 4],
    'release-lefts': [1, 2],
    'release-other-windows': [5, 6],
    'release-tabs': [1, 2, 3, 4, 5, 6]
  };

  assert.deepEqual(releaseCommands, Object.keys(expected));
  for (const command of releaseCommands) {
    const calls = [];
    const result = await runScopedCommand({
      cancelTakeover: async tab => calls.push(`cancel:${tab.id}`),
      command,
      query: async () => tabs.map(tab => ({...tab})),
      refresh: async tab => ({...tab}),
      reload: async () => assert.fail('the shared release helper owns every physical wake'),
      selected,
      shiftKey: false,
      release: async tab => {
        calls.push(`release:${tab.id}`);
        return {...tab, discarded: false, frozen: false, status: 'complete'};
      }
    });

    assert.deepEqual(sortedIds(result.released), expected[command], command);
    assert.deepEqual(result.failed, [], command);
    assert.deepEqual(sortedIds(calls.filter(call => call.startsWith('cancel:')).map(call => ({
      id: Number(call.split(':')[1])
    }))), expected[command], `${command}: cancellation scope`);
    assert.deepEqual(sortedIds(calls.filter(call => call.startsWith('release:')).map(call => ({
      id: Number(call.split(':')[1])
    }))), expected[command], `${command}: shared release targets`);
  }
});

test('issue 12: 25- and 100-target batches meet p95 and retained-memory budgets', () => {
  const moduleUrl = new URL('../v3/worker/core/takeover-scheduler.mjs', import.meta.url).href;
  const metrics = runGcProbe(`
    const {createTakeoverScheduler} = await import(${JSON.stringify(moduleUrl)});
    const turn = () => new Promise(resolve => setImmediate(resolve));
    const run = async count => {
      const scheduler = createTakeoverScheduler({concurrency: 4});
      const pulseWindows = new Set();
      const completed = [];
      const startedAt = performance.now();
      let active = 0;
      let maximum = 0;
      const jobs = Array.from({length: count}, (_, index) => {
        const frozen = index % 5 === 0;
        const key = 'window:' + (index % 8);
        return scheduler.schedule(async () => {
          if (frozen && pulseWindows.has(key)) throw Error('focus collision in ' + key);
          if (frozen) pulseWindows.add(key);
          active += 1;
          maximum = Math.max(maximum, active);
          await turn();
          active -= 1;
          if (frozen) pulseWindows.delete(key);
          completed.push(performance.now() - startedAt);
        }, {key: frozen ? key : undefined}).promise;
      });
      await Promise.all(jobs);
      await turn();
      const ordered = completed.toSorted((a, b) => a - b);
      return {
        maximum,
        p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
        snapshot: scheduler.snapshot()
      };
    };

    await run(10);
    const twentyFive = await run(25);
    await run(100);
    await turn();
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let hundred;
    for (let pass = 0; pass < 8; pass += 1) hundred = await run(100);
    await turn();
    global.gc();
    global.gc();
    const after = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({before, after, retained: after - before, twentyFive, hundred}));
  `);

  const empty = {active: 0, activeKeys: 0, concurrency: 4, queued: 0};
  assert.deepEqual(metrics.twentyFive.snapshot, empty);
  assert.deepEqual(metrics.hundred.snapshot, empty);
  assert.equal(metrics.twentyFive.maximum, 4);
  assert.equal(metrics.hundred.maximum, 4);
  assert.ok(metrics.twentyFive.p95 < 500,
    `25-target p95 ${metrics.twentyFive.p95.toFixed(1)}ms exceeded 500ms`);
  assert.ok(metrics.hundred.p95 < 1_000,
    `100-target p95 ${metrics.hundred.p95.toFixed(1)}ms exceeded 1s`);
  assert.ok(metrics.retained < 4 * 1024 * 1024,
    `settled scheduler retained ${metrics.retained} bytes (4 MiB budget)`);
});

test('issue 21: 100 delayed/hung metadata targets stay deadline- and memory-bounded', () => {
  const moduleUrl = new URL('../v3/worker/core/metadata-scan.mjs', import.meta.url).href;
  const metrics = runGcProbe(`
    const {metadataPhysicalPoolSnapshot, runBoundedScan} = await import(${JSON.stringify(moduleUrl)});
    const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const retained = [];
    let active = 0;
    let maximum = 0;
    let physicalStarted = 0;
    const run = async count => {
      const startedAt = performance.now();
      const scan = await runBoundedScan(Array.from({length: count}, (_, index) => index), item => {
        active += 1;
        physicalStarted += 1;
        maximum = Math.max(maximum, active);
        const operation = new Promise(() => {});
        retained.push(operation);
        return operation;
      }, {concurrency: 4, timeout: 75});
      return {
        completed: scan.completed.length,
        elapsed: performance.now() - startedAt,
        maximum,
        skipped: scan.skipped.length,
        started: scan.started,
        timedOut: scan.timedOut,
        total: scan.total
      };
    };

    const first = await run(100);
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let last;
    for (let pass = 0; pass < 8; pass += 1) last = await run(100);
    global.gc();
    global.gc();
    const after = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({
      before,
      after,
      first,
      last,
      maximum,
      physicalStarted,
      pool: metadataPhysicalPoolSnapshot(),
      retainedBytes: after - before
    }));
  `);

  assert.equal(metrics.first.started, 4);
  assert.equal(metrics.last.total, 100);
  assert.equal(metrics.last.timedOut, true);
  assert.equal(metrics.maximum, 4);
  assert.equal(metrics.physicalStarted, 4,
    'repeated scans must not start more physical operations while the first four remain hung');
  assert.equal(metrics.last.completed, 0);
  assert.equal(metrics.last.skipped, 100);
  assert.equal(metrics.last.started, 0);
  assert.deepEqual(metrics.pool, {active: 4, limit: 4, maxQueued: 4, queued: 0});
  assert.ok(metrics.last.elapsed < 500,
    `100-target delayed scan took ${metrics.last.elapsed.toFixed(1)}ms (500ms budget)`);
  assert.ok(metrics.retainedBytes < 4 * 1024 * 1024,
    `repeated delayed scans retained ${metrics.retainedBytes} bytes (4 MiB budget)`);
});

const shuffled = (values, seed) => {
  const output = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
};

test('issue 26: a seeded 10-hop lifecycle preserves one current marker/job', async () => {
  const storage = {};
  const listeners = {};
  const live = new Map();
  const event = name => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });
  const storageArea = {
    get(options, callback) {
      callback(structuredClone(storage));
    },
    remove(key, callback) {
      delete storage[key];
      callback();
    },
    set(values, callback) {
      Object.assign(storage, structuredClone(values));
      callback();
    }
  };

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {local: {}, session: storageArea},
    tabs: {
      get(id, callback) {
        callback(live.get(id));
      },
      query(options, callback) {
        callback([...live.values()]);
      },
      onAttached: event('attached'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
      onUpdated: event('updated')
    }
  };

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('issue-26', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    const original = {
      id: 10_000,
      active: false,
      discarded: true,
      frozen: false,
      status: 'unloaded',
      url: 'https://ten-hop.example/'
    };
    live.set(original.id, original);
    const attemptId = await ownership.beginTakeover(original);
    assert.equal(typeof attemptId, 'string');

    const predecessors = [];
    const hops = [];
    let current = original;
    for (let hop = 1; hop <= 10; hop += 1) {
      predecessors.push(current);
      const successor = {...current, id: original.id + hop};
      hops.push([successor.id, current.id]);
      live.delete(current.id);
      live.set(successor.id, successor);
      listeners.replaced(successor.id, current.id);
      listeners.replaced(successor.id, current.id); // duplicate event is idempotent
      current = successor;
    }

    let state = await ownership.snapshot();
    assert.deepEqual(Object.keys(state), [String(current.id)]);
    assert.equal(state[current.id].attemptId, attemptId);
    assert.equal(state[current.id].state, 'takeover-waking');
    assert.deepEqual(await ownership.diagnostics(), {
      attempts: 1,
      generations: 1,
      observedDiscards: 0,
      replacements: 10,
      takeoverAttempts: 1
    });

    // Every obsolete identity delivers its late lifecycle callbacks in one
    // deterministic randomized order. None may delete the successor job or
    // recreate a predecessor marker.
    const callbacks = predecessors.flatMap(tab => [
      () => listeners.updated(tab.id, {discarded: false}, {...tab, discarded: false}),
      () => listeners.updated(tab.id, {discarded: true}, tab),
      () => listeners.attached(tab.id),
      () => listeners.removed(tab.id)
    ]);
    for (const callback of shuffled(callbacks, 0x26_10_2026)) callback();

    state = await ownership.snapshot();
    assert.deepEqual(Object.keys(state), [String(current.id)]);
    assert.equal(state[current.id].attemptId, attemptId);
    assert.equal(ownership.resolveId(original.id), current.id);

    // Model the native API callback arriving with the first predecessor after
    // all replacement events. Its nonce must settle on the current identity.
    assert.equal(await ownership.finish(original, attemptId, 'self'), true);
    state = await ownership.snapshot();
    assert.deepEqual(Object.keys(state), [String(current.id)]);
    assert.equal(state[current.id].source, 'self');
    assert.equal(state[current.id].attemptId, attemptId);
    assert.deepEqual(await ownership.diagnostics(), {
      attempts: 0,
      generations: 1,
      observedDiscards: 0,
      replacements: 10,
      takeoverAttempts: 0
    });

    for (const predecessor of predecessors) {
      assert.equal(state[predecessor.id], undefined);
      assert.equal((await ownership.status(predecessor.id)).marker.source, 'self');
    }
    assert.equal(hops.length, 10);

    // The production event path must prune completed lineage without relying
    // on a worker restart or a test-only explicit reconcile call.
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await ownership.diagnostics()).replacements, 0);
    assert.equal(ownership.resolveId(original.id), original.id);
  }
  finally {
    delete globalThis.chrome;
  }
});

const validSettings = extra => ({
  audio: true,
  click: 'click.popup',
  faqs: true,
  favicon: false,
  'lifecycle-feedback': false,
  mode: 'time-based',
  period: 600,
  prepends: 'zzz',
  whitelist: [],
  ...extra
});

const backupText = settings => JSON.stringify({
  exportedAt: '2026-08-12T12:00:00.000Z',
  format: 'auto-tab-discard-settings',
  label: RAW_BACKUP_LABEL,
  settings,
  version: 1
});

test('issue 47: seeded import fuzz is bounded, atomic, and exactly round-trippable', async () => {
  const validateRules = (values, options) => validateRuleList(values, options);
  const stableExistingSettings = validSettings({audio: false, period: 900});
  const stableCopy = structuredClone(stableExistingSettings);
  let seed = 0x47_08_2026;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let accepted = 0;
  let rejected = 0;
  const startedAt = performance.now();

  for (let index = 0; index < 600; index += 1) {
    const candidate = validSettings({
      audio: random() > 0.5,
      period: Math.floor(random() * 31_536_001)
    });
    let text;
    switch (index % 10) {
      case 0:
        candidate.whitelist = [`host-${index}.example`];
        text = backupText(candidate);
        break;
      case 1:
        candidate.audio = 'true';
        text = backupText(candidate);
        break;
      case 2:
        candidate.period = -1;
        text = backupText(candidate);
        break;
      case 3:
        candidate[`unknown-${index}`] = true;
        text = backupText(candidate);
        break;
      case 4:
        candidate.whitelist = ['re:(a+)+$'];
        text = backupText(candidate);
        break;
      case 5:
        candidate.whitelist = [index];
        text = backupText(candidate);
        break;
      case 6:
        candidate['./plugins/hostile/core.js'] = true;
        text = backupText(candidate);
        break;
      case 7:
        candidate.click = index % 20 === 7 ? 'click.discard' : 'click.release-tabs';
        text = backupText(candidate);
        break;
      case 8:
        text = backupText(candidate).slice(0, -1);
        break;
      default:
        candidate.prepends = `  marker-${index}\u202e  `;
        text = backupText(candidate);
        break;
    }

    try {
      const parsed = parseSettingsBackup(text, {validateRules});
      accepted += 1;
      const serialized = serializeRawSettingsBackup(parsed.document.settings, {
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        validateRules
      });
      const roundTrip = parseSettingsBackup(serialized, {validateRules});
      assert.deepEqual(roundTrip.document.settings, parsed.document.settings,
        `accepted seed case ${index} must round-trip exactly`);

      const state = {
        local: {historical: 'value'},
        storage: structuredClone(stableExistingSettings)
      };
      await commitSettingsImport(parsed.document.settings, {
        async readLocalStorage() {
          return structuredClone(state.local);
        },
        async readStorage() {
          return structuredClone(state.storage);
        },
        async removeStorage(keys) {
          keys.forEach(key => delete state.storage[key]);
        },
        async replaceLocalStorage(value) {
          state.local = structuredClone(value);
        },
        async writeStorage(value) {
          Object.assign(state.storage, structuredClone(value));
        }
      }, {validateRules});
      assert.deepEqual(state.storage, parsed.document.settings);
      assert.deepEqual(state.local, {});
    }
    catch (error) {
      assert.ok(error instanceof SettingsBackupError, `seed case ${index}: ${error?.stack || error}`);
      rejected += 1;
    }
    assert.deepEqual(stableExistingSettings, stableCopy,
      `rejected seed case ${index} must not partially alter existing preferences`);
  }

  const elapsed = performance.now() - startedAt;
  assert.ok(accepted > 0 && rejected > 0);
  assert.ok(elapsed < 2_000, `600-case settings fuzz took ${elapsed.toFixed(1)}ms (2s budget)`);
});

test('issue 48: malicious regexp validation and matching stay within a fixed budget', () => {
  clearRuleCache();
  const templates = [
    '(a+)+$',
    '((a|aa))+$',
    '(?:a|aa){1,3}$',
    'a+a+',
    'a{0,1000}ba{0,1000}',
    '.*middle.*',
    '(?=secret)secret',
    '(secret)\\1',
    'a{1001}',
    '()*'
  ];
  const href = `${'a'.repeat(RULE_LIMITS.inputLength - 1)}!`;
  const startedAt = performance.now();

  for (let index = 0; index < 1_000; index += 1) {
    const rule = `re:${templates[index % templates.length]}literal-${index}`;
    const validation = validateRuleList([rule]);
    assert.equal(validation.ok, false, rule);
    const evaluated = evaluateRuleList([rule], 'malicious.example', href);
    assert.equal(evaluated.valid, false, rule);
    assert.equal(evaluated.matched, false, rule);
  }

  // Include a valid high-repeat boundary so the fixed budget covers the real
  // regexp execution path as well as conservative rejection.
  for (let index = 0; index < 1_000; index += 1) {
    const evaluated = evaluateRuleList(['re:^a{0,1000}b$'], 'safe.example', href);
    assert.equal(evaluated.valid, true);
    assert.equal(evaluated.matched, false);
  }

  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed < 1_000,
    `2,000 malicious/boundary validations and matches took ${elapsed.toFixed(1)}ms (1s budget)`);
});
