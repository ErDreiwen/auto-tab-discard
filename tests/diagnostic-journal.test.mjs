import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  createDiagnosticStorageChangeListener,
  createDiagnosticJournal,
  DIAGNOSTIC_EVENT_TYPES,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_MAX_AGE,
  DIAGNOSTIC_SESSION_FORMAT,
  DIAGNOSTIC_STORAGE_KEY,
  DIAGNOSTIC_VERSION,
  diagnosticSessionStorageAdapter,
  diagnosticStorageAdapter,
  formatDiagnosticLog,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_SESSIONS,
  projectDiagnosticEvent,
  projectDiagnosticIncident
} from '../v3/worker/core/diagnostic-journal.mjs';
import {
  FAILURE_CAUSES,
  failureCausePolicy
} from '../v3/worker/core/failure-causes.mjs';

const runtime = {
  manifest: {version: '0.6.9.2'},
  userAgent: 'Mozilla/5.0 Chrome/152.0.7977.42 Safari/537.36'
};

const popupSnapshot = ({
  id = 'ATD-MTEST-1',
  startedAt = 1_800_000_000_000,
  state = 'failed'
} = {}) => ({
  checked: false,
  command: 'discard-window',
  completed: 66,
  endedAt: startedAt + 2_500,
  error: Error(`SECRET-ERROR https://private.invalid/ C:\\Users\\alice\\secret.log`),
  errorCode: 'POPUP_COMMAND_FAILED',
  incidentId: id,
  outcomes: Object.fromEntries([
    ...Array.from({length: 19}, (_, index) => [90_000 + index, {
      code: 'TAB_PROTECTED',
      rawReason: 'SECRET-PROTECTED-REASON',
      status: 'skipped',
      tabId: 90_000 + index,
      title: 'SECRET-TITLE',
      url: 'https://secret.example/'
    }]),
    ...Array.from({length: 47}, (_, index) => [100_000 + index, {
      code: 'TAB_UNSUPPORTED',
      rawReason: 'SECRET-UNSUPPORTED-REASON',
      status: 'failed',
      tabId: 100_000 + index
    }])
  ]),
  privateContext: false,
  scope: 'window:888888',
  shiftKey: true,
  startedAt,
  state,
  summary: {failed: 47, skipped: 19, success: 0},
  targetIds: [90_000, 100_000],
  title: 'SECRET-SNAPSHOT-TITLE',
  total: 66,
  updatedAt: startedAt + 2_500,
  windowId: 888888
});

const memoryStore = initial => {
  let value = structuredClone(initial);
  let writes = 0;
  let removals = 0;
  return {
    read: async () => structuredClone(value),
    remove: async () => {
      removals += 1;
      value = undefined;
    },
    removals: () => removals,
    value: () => structuredClone(value),
    write: async next => {
      writes += 1;
      value = structuredClone(next);
    },
    writes: () => writes
  };
};

const browserStorageArea = (initial = {}) => {
  let values = structuredClone(initial);
  let setCalls = 0;
  let totalSetBytes = 0;
  let maximumSetBytes = 0;
  let rejectNextRemove = false;
  let rejectNextSet = false;
  const clone = value => structuredClone(value);
  return {
    async get(query, callback) {
      let result;
      if (query === null) result = clone(values);
      if (Array.isArray(query)) {
        result = Object.fromEntries(query.filter(key => Object.hasOwn(values, key))
          .map(key => [key, clone(values[key])]));
      }
      else if (typeof query === 'string') {
        result = Object.hasOwn(values, query) ? {[query]: clone(values[query])} : {};
      }
      else if (query !== null) {
        result = Object.fromEntries(Object.keys(query || {}).map(key => [
          key,
          Object.hasOwn(values, key) ? clone(values[key]) : clone(query[key])
        ]));
      }
      callback?.(clone(result));
      return result;
    },
    failNextRemove: () => rejectNextRemove = true,
    failNextSet: () => rejectNextSet = true,
    maximumSetBytes: () => maximumSetBytes,
    async remove(keys, callback) {
      if (rejectNextRemove) {
        rejectNextRemove = false;
        throw Error('simulated diagnostic removal failure');
      }
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      callback?.();
    },
    async set(next, callback) {
      if (rejectNextSet) {
        rejectNextSet = false;
        throw Error('simulated atomic chunk commit failure');
      }
      const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
      maximumSetBytes = Math.max(maximumSetBytes, bytes);
      setCalls += 1;
      totalSetBytes += bytes;
      values = {...values, ...clone(next)};
      callback?.();
    },
    setCalls: () => setCalls,
    totalSetBytes: () => totalSetBytes,
    values: () => clone(values)
  };
};

const chromeDualStorageArea = (initial = {}, emit = () => {}) => {
  let values = structuredClone(initial);
  const clone = value => structuredClone(value);
  // Edge exposes both surfaces. Model the observed ordering where the returned
  // thenable resolves before the authoritative callback fires.
  const afterPromiseResolution = task => queueMicrotask(() => queueMicrotask(task));
  const resultFor = query => {
    if (query === null) return clone(values);
    if (Array.isArray(query)) {
      return Object.fromEntries(query.filter(key => Object.hasOwn(values, key))
        .map(key => [key, clone(values[key])]));
    }
    return Object.fromEntries(Object.keys(query || {}).map(key => [
      key,
      Object.hasOwn(values, key) ? clone(values[key]) : clone(query[key])
    ]));
  };
  return {
    get(query, callback) {
      afterPromiseResolution(() => callback(resultFor(query)));
      return Promise.resolve(undefined);
    },
    remove(keys, callback) {
      afterPromiseResolution(() => {
        const changes = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!Object.hasOwn(values, key)) continue;
          changes[key] = {oldValue: clone(values[key])};
          delete values[key];
        }
        callback();
        if (Object.keys(changes).length) queueMicrotask(() => emit(changes, 'local'));
      });
      return Promise.resolve(undefined);
    },
    set(next, callback) {
      afterPromiseResolution(() => {
        const changes = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, {
          ...(Object.hasOwn(values, key) && {oldValue: clone(values[key])}),
          newValue: clone(value)
        }]));
        values = {...values, ...clone(next)};
        callback();
        queueMicrotask(() => emit(changes, 'local'));
      });
      return Promise.resolve(undefined);
    },
    values: () => clone(values)
  };
};

const recordsFrom = document => (document?.sessions || []).flatMap(session => session.records || []);
const incidentsFrom = document => recordsFrom(document)
  .filter(record => record.kind === 'incident').map(record => record.incident);

test('projects the screenshot-like 0/19/47 failure into fixed diagnostic groups only', () => {
  const incident = projectDiagnosticIncident(popupSnapshot(), runtime);
  assert.deepEqual(incident.summary, {failed: 47, skipped: 19, success: 0});
  assert.equal(incident.total, 66);
  assert.equal(incident.forced, true);
  assert.deepEqual(incident.runtime, {browserFamily: 'Chromium', extensionVersion: '0.6.9.2'});
  assert.deepEqual(incident.groups, [{
    code: 'TAB_UNSUPPORTED',
    count: 47,
    reasonCode: 'UNSUPPORTED_PAGE',
    stage: 'eligibility',
    status: 'failed'
  }, {
    code: 'TAB_PROTECTED',
    count: 19,
    reasonCode: 'PROTECTION_RULE',
    stage: 'eligibility',
    status: 'skipped'
  }]);

  const serialized = JSON.stringify(incident);
  for (const secret of [
    'secret.example', 'SECRET-TITLE', 'SECRET-ERROR', 'SECRET-PROTECTED-REASON',
    'SECRET-UNSUPPORTED-REASON', '888888', '100000', 'Users', 'secret.log', 'window:'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'i'));
  }
});

test('derives status from fixed code, collapses unknown codes, and never invokes outcome getters', () => {
  let getterInvoked = false;
  const snapshot = popupSnapshot({id: 'ATD-HOSTILE-1'});
  snapshot.outcomes = {
    first: {code: 'TAB_PROTECTED', status: 'success'},
    second: {code: 'RAW_PRIVATE_CODE', status: 'skipped'},
    get third() {
      getterInvoked = true;
      throw Error('SECRET-GETTER');
    }
  };
  snapshot.total = 2;
  const incident = projectDiagnosticIncident(snapshot, runtime);
  assert.equal(getterInvoked, false);
  assert.deepEqual(incident.summary, {failed: 1, skipped: 1, success: 0});
  assert.equal(incident.groups.find(group => group.code === 'TAB_PROTECTED').status, 'skipped');
  assert.equal(incident.groups.find(group => group.code === 'TAB_FAILED').reasonCode,
    'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(incident), /RAW_PRIVATE_CODE|SECRET-GETTER/);
});

test('projects every allowlisted generic failure cause without widening the incident shape', () => {
  const snapshot = popupSnapshot({id: 'ATD-CAUSES-1'});
  const causes = Object.values(FAILURE_CAUSES);
  snapshot.outcomes = Object.fromEntries(causes.map((failureCause, index) => [index + 1, {
    code: 'TAB_FAILED',
    failureCause,
    rawReason: `SECRET-${failureCause}`,
    status: 'failed',
    tabId: index + 1
  }]));
  snapshot.summary = {failed: causes.length, skipped: 0, success: 0};
  snapshot.total = causes.length;

  const incident = projectDiagnosticIncident(snapshot, runtime);
  assert.equal(DIAGNOSTIC_VERSION, 2);
  assert.equal(incident.groups.length, causes.length);
  for (const failureCause of causes) {
    const [stage, reasonCode] = failureCausePolicy(failureCause);
    assert.deepEqual(incident.groups.find(group =>
      group.stage === stage && group.reasonCode === reasonCode), {
      code: 'TAB_FAILED',
      count: 1,
      reasonCode,
      stage,
      status: 'failed'
    });
  }
  assert.equal(incident.groups.every(group =>
    Object.keys(group).sort().join(',') === 'code,count,reasonCode,stage,status'), true);
  assert.doesNotMatch(JSON.stringify(incident), /SECRET|rawReason|tabId/);
});

test('unsupported incidents keep separate fixed metadata groups without browsing-data leaks', () => {
  const snapshot = popupSnapshot({id: 'ATD-UNSUPPORTED-CAUSES'});
  const causes = [
    FAILURE_CAUSES.METADATA_SCAN_FAILED,
    FAILURE_CAUSES.METADATA_SCAN_CAPACITY,
    FAILURE_CAUSES.METADATA_SCAN_TIMEOUT,
    FAILURE_CAUSES.METADATA_UNAVAILABLE,
    FAILURE_CAUSES.METADATA_NO_INSPECTABLE_DOCUMENT,
    FAILURE_CAUSES.METADATA_EVALUATION_FAILED
  ];
  snapshot.outcomes = Object.fromEntries([
    ...causes.map((failureCause, index) => [index + 1, {
      code: 'TAB_UNSUPPORTED',
      failureCause,
      rawReason: `SECRET ${failureCause} https://private-${index}.example/`,
      status: 'failed',
      tabId: index + 1
    }]),
    [90, {
      code: 'TAB_UNSUPPORTED',
      rawReason: 'SECRET legacy unsupported reason',
      status: 'failed',
      tabId: 90
    }],
    [91, {
      code: 'TAB_UNSUPPORTED',
      failureCause: 'RAW_PRIVATE_BROWSER_CAUSE',
      rawReason: 'SECRET invalid unsupported reason',
      status: 'failed',
      tabId: 91
    }]
  ]);
  snapshot.summary = {failed: causes.length + 2, skipped: 0, success: 0};
  snapshot.total = causes.length + 2;

  const incident = projectDiagnosticIncident(snapshot, runtime);
  for (const failureCause of causes) {
    const [stage, reasonCode] = failureCausePolicy(failureCause);
    assert.deepEqual(incident.groups.find(group =>
      group.stage === stage && group.reasonCode === reasonCode), {
      code: 'TAB_UNSUPPORTED',
      count: 1,
      reasonCode,
      stage,
      status: 'failed'
    });
  }
  assert.deepEqual(incident.groups.find(group => group.reasonCode === 'UNSUPPORTED_PAGE'), {
    code: 'TAB_UNSUPPORTED',
    count: 2,
    reasonCode: 'UNSUPPORTED_PAGE',
    stage: 'eligibility',
    status: 'failed'
  });
  assert.doesNotMatch(JSON.stringify(incident), /SECRET|private-|RAW_PRIVATE|https?:/i);
});

test('command-level scope failure uses the same allowlist and rejects raw causes', () => {
  const fixed = popupSnapshot({id: 'ATD-SCOPE-1'});
  fixed.outcomes = {};
  fixed.total = 0;
  fixed.errorCode = 'POPUP_COMMAND_FAILED';
  fixed.errorCause = FAILURE_CAUSES.SCOPE_QUERY_FAILED;
  assert.deepEqual(projectDiagnosticIncident(fixed, runtime).groups, [{
    code: 'POPUP_COMMAND_FAILED',
    count: 1,
    reasonCode: 'SCOPE_QUERY_FAILED',
    stage: 'scope-query',
    status: 'failed'
  }]);

  fixed.errorCause = 'SECRET_RAW_CAUSE';
  assert.deepEqual(projectDiagnosticIncident(fixed, runtime).groups, [{
    code: 'POPUP_COMMAND_FAILED',
    count: 1,
    reasonCode: 'OPERATION_FAILED',
    stage: 'tab-operation',
    status: 'failed'
  }]);
});

test('a command-level failure with no tab outcomes still has one fixed diagnosis', () => {
  const snapshot = popupSnapshot({id: 'ATD-COMMAND-1'});
  snapshot.outcomes = {};
  snapshot.total = 0;
  snapshot.errorCode = 'POPUP_NO_ACTIVE_TAB';
  const incident = projectDiagnosticIncident(snapshot, runtime);
  assert.deepEqual(incident.summary, {failed: 0, skipped: 0, success: 0});
  assert.deepEqual(incident.groups, [{
    code: 'POPUP_NO_ACTIVE_TAB',
    count: 1,
    reasonCode: 'NO_ACTIVE_TAB',
    stage: 'command',
    status: 'failed'
  }]);
});

test('latest.log is deterministic Minecraft-style text and contains no browsing data', () => {
  const incident = projectDiagnosticIncident(popupSnapshot(), runtime);
  const text = formatDiagnosticLog(incident);
  assert.match(text, /^# Auto Tab Discard SANITIZED latest\.log/m);
  assert.match(text, /\[AutoTabDiscard\/ERROR\].*stage=eligibility reason=UNSUPPORTED_PAGE.*count=47/);
  assert.match(text, /event=COMMAND_END state=failed duration_ms=2500 success=0 skipped=19 failed=47/);
  assert.ok(text.endsWith('\n'));
  for (const secret of ['secret.example', 'SECRET', '888888', '100000', 'window:', 'userAgent']) {
    assert.doesNotMatch(text, new RegExp(secret, 'i'));
  }
});

test('journal serializes concurrent updates, replaces incidents, and enforces age/count/byte bounds', async () => {
  const store = memoryStore();
  let current = 1_800_000_020_000;
  const journal = createDiagnosticJournal({
    ...runtime,
    maxBytes: 5_000,
    maxIncidents: 3,
    now: () => current,
    store
  });
  await Promise.all(Array.from({length: 8}, (_, index) => {
    const startedAt = current - (7 - index) * 1_000;
    return journal.record(popupSnapshot({id: `ATD-BOUND-${index + 1}`, startedAt}));
  }));
  const saved = await journal.snapshot();
  assert.equal(saved.format, DIAGNOSTIC_FORMAT);
  assert.equal(saved.version, DIAGNOSTIC_VERSION);
  assert.equal(incidentsFrom(saved).length, 3);
  assert.deepEqual(incidentsFrom(saved).map(incident => incident.id),
    ['ATD-BOUND-6', 'ATD-BOUND-7', 'ATD-BOUND-8']);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).byteLength <= 5_000);
  assert.equal(store.writes(), 8);

  current += DIAGNOSTIC_MAX_AGE + 3_000;
  assert.equal(incidentsFrom(await journal.snapshot()).length, 0);
  assert.equal(incidentsFrom(store.value()).length, 0,
    'expired incidents must also be removed from durable storage');
  assert.equal(store.writes(), 9);
});

test('incognito incidents remain memory-only but can be explicitly copied during the worker lifetime', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  const source = popupSnapshot({id: 'ATD-PRIVATE-1'});
  source.privateContext = true;
  await journal.record(source);
  assert.equal(store.writes(), 0);
  assert.equal(incidentsFrom(await journal.snapshot()).length, 0);
  const privateAccess = {includeDurable: false, includePrivate: true};
  assert.equal(await journal.latest('ATD-PRIVATE-1'), undefined);
  assert.equal((await journal.latest('ATD-PRIVATE-1', privateAccess)).id, 'ATD-PRIVATE-1');
  assert.match((await journal.exportText('ATD-PRIVATE-1', privateAccess)).text, /ATD-PRIVATE-1/);
});

test('private snapshot access cannot project durable regular incidents', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  await journal.record(popupSnapshot({id: 'ATD-REGULAR-1'}));

  assert.deepEqual(incidentsFrom(await journal.snapshot()).map(incident => incident.id),
    ['ATD-REGULAR-1']);
  assert.deepEqual((await journal.snapshot({includeDurable: false})).sessions, []);
});

test('latest, export, snapshot, and clear preserve the regular/private partition', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  const regular = popupSnapshot({id: 'ATD-REGULAR-2'});
  const privateSnapshot = popupSnapshot({id: 'ATD-PRIVATE-2'});
  privateSnapshot.privateContext = true;
  await journal.record(regular);
  await journal.record(privateSnapshot);

  const regularAccess = {
    clearDurable: true,
    clearPrivate: false,
    includeDurable: true,
    includePrivate: false
  };
  const privateAccess = {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  };
  assert.equal(await journal.latest('ATD-PRIVATE-2', regularAccess), undefined);
  const unavailable = await journal.exportText('ATD-PRIVATE-2', regularAccess);
  assert.equal(unavailable.incident, null);
  assert.equal(unavailable.text, '');
  assert.deepEqual(incidentsFrom(await journal.snapshot(regularAccess)).map(incident => incident.id),
    ['ATD-REGULAR-2']);

  await journal.clear(regularAccess);
  assert.equal((await journal.latest('ATD-PRIVATE-2', privateAccess)).id, 'ATD-PRIVATE-2');
  assert.equal(await journal.latest('ATD-REGULAR-2', regularAccess), undefined);
  await journal.clear(privateAccess);
  assert.equal(await journal.latest('ATD-PRIVATE-2', privateAccess), undefined);
});

test('corrupt storage is not exported and a failed write does not commit an incident', async () => {
  let fail = true;
  let stored = {
    format: DIAGNOSTIC_FORMAT,
    incidents: [{url: 'https://SECRET.invalid/', id: 'RAW'}],
    updatedAt: 'not-a-time',
    version: 999
  };
  const store = {
    read: async () => structuredClone(stored),
    remove: async () => stored = undefined,
    write: async value => {
      if (fail) throw Error('quota unavailable');
      stored = structuredClone(value);
    }
  };
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  await assert.rejects(journal.record(popupSnapshot({id: 'ATD-RETRY-1'})), /quota unavailable/);
  assert.equal(await journal.latest('ATD-RETRY-1'), undefined);
  fail = false;
  await journal.record(popupSnapshot({id: 'ATD-RETRY-1'}));
  assert.equal((await journal.latest()).id, 'ATD-RETRY-1');
  assert.doesNotMatch(JSON.stringify(stored), /SECRET\.invalid|url/);
});

test('storage adapter invokes callback/promise APIs once and clear removes only its reserved key', async () => {
  const values = {[DIAGNOSTIC_STORAGE_KEY]: {format: DIAGNOSTIC_FORMAT}};
  const calls = {get: 0, remove: 0, set: 0};
  const area = {
    get(defaults, callback) {
      calls.get += 1;
      callback({...defaults, ...values});
      return Promise.resolve({...defaults, ...values});
    },
    remove(key, callback) {
      calls.remove += 1;
      delete values[key];
      callback();
      return Promise.resolve();
    },
    set(next, callback) {
      calls.set += 1;
      Object.assign(values, next);
      callback();
      return Promise.resolve();
    }
  };
  const adapter = diagnosticStorageAdapter(area);
  await adapter.read();
  await adapter.write({format: DIAGNOSTIC_FORMAT});
  await adapter.remove();
  assert.deepEqual(calls, {get: 1, remove: 1, set: 1});
  assert.equal(DIAGNOSTIC_STORAGE_KEY in values, false);
});

test('storage adapter rejects a backend that never settles within its fixed deadline', async () => {
  const area = {
    get() {},
    remove() {},
    set() {}
  };
  const adapter = diagnosticStorageAdapter(area, DIAGNOSTIC_STORAGE_KEY, {timeoutMs: 10});
  await assert.rejects(adapter.read(), /timed out/);
  await assert.rejects(adapter.write({}), /timed out/);
  await assert.rejects(adapter.remove(), /timed out/);
});

test('storage listener ignores own index writes but invalidates an out-of-band removal', async () => {
  let invalidations = 0;
  const listener = createDiagnosticStorageChangeListener({
    invalidate: async () => invalidations += 1
  });
  listener({
    [DIAGNOSTIC_STORAGE_KEY]: {
      newValue: {layout: 'chunked-v1'},
      oldValue: {layout: 'chunked-v1'}
    }
  }, 'local');
  await Promise.resolve();
  assert.equal(invalidations, 0);

  listener({
    [DIAGNOSTIC_STORAGE_KEY]: {oldValue: {layout: 'chunked-v1'}}
  }, 'local');
  await Promise.resolve();
  assert.equal(invalidations, 1);
});

test('clear removes durable and private history without clearing unrelated storage', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  await journal.record(popupSnapshot({id: 'ATD-CLEAR-1'}));
  const privateSnapshot = popupSnapshot({id: 'ATD-CLEAR-2'});
  privateSnapshot.privateContext = true;
  await journal.record(privateSnapshot);
  assert.deepEqual(await journal.clear(), {cleared: true});
  assert.equal(await journal.latest(), undefined);
  assert.equal((await journal.latest('ATD-CLEAR-2', {
    includeDurable: false,
    includePrivate: true
  })).id, 'ATD-CLEAR-2');
  await journal.clear({clearDurable: false, clearPrivate: true});
  assert.equal(await journal.latest('ATD-CLEAR-2', {
    includeDurable: false,
    includePrivate: true
  }), undefined);
  assert.equal(store.removals(), 1);
});

test('v2 capacity defaults are deep but remain below the local-storage safety budget', () => {
  assert.equal(DIAGNOSTIC_VERSION, 2);
  assert.equal(DIAGNOSTIC_MAX_AGE, 30 * 24 * 60 * 60 * 1000);
  assert.equal(MAX_DIAGNOSTIC_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_DIAGNOSTIC_EVENTS, 10_000);
  assert.equal(MAX_DIAGNOSTIC_SESSIONS, 64);
});

test('browser session identity, sequence, and monotonic offset survive worker restart', async () => {
  const store = memoryStore();
  const sessionStore = memoryStore();
  let clock = 10_000;
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-SESSION-ONE',
    now: () => clock,
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  const one = await first.event({
    action: 'SHOW_DIAGNOSTICS',
    outcome: 'STARTED',
    phase: 'CLICK',
    source: 'options',
    type: 'UI_ACTION'
  });
  assert.deepEqual(await first.browserSession(), {
    id: 'ATDS-SESSION-ONE',
    offsetMs: 0,
    sequence: 1,
    startedAt: '1970-01-01T00:00:10.000Z'
  });

  clock = 9_000; // wall-clock rollback must not move the session backward
  const restarted = createDiagnosticJournal(options);
  const two = await restarted.event({
    code: 'WORKER_STARTED',
    outcome: 'STARTED',
    phase: 'startup',
    source: 'worker',
    type: 'WORKER_START'
  });
  assert.equal(one.sequence, 1);
  assert.equal(two.sequence, 2);
  assert.ok(two.offsetMs >= one.offsetMs);
  assert.equal((await restarted.browserSession()).id, 'ATDS-SESSION-ONE');
  assert.deepEqual(recordsFrom(await restarted.snapshot()).map(record => record.sequence), [1, 2]);
});

test('browser-session loss rotates identity and current-session export never falls back', async () => {
  const store = memoryStore();
  let clock = 20_000;
  const first = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-SESSION-OLD',
    now: () => clock,
    sessionStore: memoryStore(),
    store
  });
  await first.record(popupSnapshot({id: 'ATD-OLD-1', startedAt: clock}));

  clock += 1_000;
  const restarted = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-SESSION-NEW',
    now: () => clock,
    sessionStore: memoryStore(),
    store
  });
  const emptyCurrent = await restarted.exportText({scope: 'current-session'});
  assert.equal(emptyCurrent.sessionCount, 0);
  assert.equal(emptyCurrent.incident, null);
  assert.doesNotMatch(emptyCurrent.text, /ATD-OLD-1/);
  await restarted.event({source: 'worker', type: 'WORKER_START'});
  const current = await restarted.exportText({scope: 'current-session'});
  assert.equal(current.sessionCount, 1);
  assert.match(current.text, /ATDS-SESSION-NEW/);
  assert.doesNotMatch(current.text, /ATD-OLD-1|ATDS-SESSION-OLD/);
  const retained = await restarted.exportText({scope: 'all'});
  assert.equal(retained.sessionCount, 2);
  assert.match(retained.text, /ATDS-SESSION-OLD/);
  assert.match(retained.text, /ATDS-SESSION-NEW/);
});

test('valid v1 incident envelopes migrate once into a separate legacy session', async () => {
  const incident = projectDiagnosticIncident(popupSnapshot({id: 'ATD-LEGACY-1'}), runtime);
  const store = memoryStore({
    format: DIAGNOSTIC_FORMAT,
    incidents: [incident],
    updatedAt: incident.endedAt,
    version: 1
  });
  const sessionStore = memoryStore();
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-CURRENT-V2',
    now: () => new Date(incident.endedAt).getTime(),
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  const migrated = await first.snapshot();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.sessions[0].id, 'ATDS-LEGACY-V1');
  assert.equal(incidentsFrom(migrated)[0].id, 'ATD-LEGACY-1');
  assert.equal(store.writes(), 1);

  const restarted = createDiagnosticJournal(options);
  assert.equal((await restarted.snapshot()).version, 2);
  assert.equal(store.writes(), 1, 'a v2 restart must not rewrite the migration');
  assert.equal((await restarted.exportText({scope: 'current-session'})).incidentCount, 0,
    'legacy incidents must never become current-session incidents');
});

test('production chunk storage migrates v1 atomically and restarts without rewriting it', async () => {
  const incident = projectDiagnosticIncident(popupSnapshot({id: 'ATD-CHUNK-MIGRATE'}), runtime);
  const legacy = {
    format: DIAGNOSTIC_FORMAT,
    incidents: [incident],
    updatedAt: incident.endedAt,
    version: 1
  };
  const area = browserStorageArea({[DIAGNOSTIC_STORAGE_KEY]: legacy});
  const store = diagnosticStorageAdapter(area);
  const options = {
    ...runtime,
    now: () => new Date(incident.endedAt).getTime(),
    sessionStore: memoryStore(),
    store
  };
  const first = createDiagnosticJournal(options);
  assert.deepEqual(incidentsFrom(await first.snapshot()).map(value => value.id),
    ['ATD-CHUNK-MIGRATE']);
  assert.equal(area.values()[DIAGNOSTIC_STORAGE_KEY].layout, 'chunked-v1');
  assert.equal(area.setCalls(), 1);

  const restarted = createDiagnosticJournal(options);
  assert.deepEqual(incidentsFrom(await restarted.snapshot()).map(value => value.id),
    ['ATD-CHUNK-MIGRATE']);
  assert.equal(area.setCalls(), 1);
});

test('failed v1 migration write leaves the original envelope untouched', async () => {
  const incident = projectDiagnosticIncident(popupSnapshot({id: 'ATD-LEGACY-FAIL'}), runtime);
  const original = {
    format: DIAGNOSTIC_FORMAT,
    incidents: [incident],
    updatedAt: incident.endedAt,
    version: 1
  };
  let value = structuredClone(original);
  const journal = createDiagnosticJournal({
    ...runtime,
    now: () => new Date(incident.endedAt).getTime(),
    store: {
      read: async () => structuredClone(value),
      remove: async () => value = undefined,
      write: async () => { throw Error('migration storage unavailable'); }
    }
  });
  await assert.rejects(journal.snapshot(), /migration storage unavailable/);
  assert.deepEqual(value, original);
});

test('structured event projection is strict, getter-safe, and strips every browsing-data canary', async () => {
  let getterCalled = false;
  const hostile = {
    action: 'RUN_CONFLICT_SCAN',
    code: 'CONFLICT_SCAN_COMPLETED',
    correlation: 'ATDC-ABCDEFGHIJKLMNOP',
    counts: {conflicts: 2, duplicates: 1, enabled: 3},
    error: Error('SECRET C:\\Users\\alice\\private.log'),
    outcome: 'SUCCEEDED',
    phase: 'SCAN',
    source: 'options',
    title: 'SECRET TITLE',
    type: 'UI_ACTION',
    url: 'https://secret.example/'
  };
  Object.defineProperty(hostile, 'command', {get() { getterCalled = true; throw Error('SECRET'); }});
  const projected = projectDiagnosticEvent(hostile, {
    correlation: hostile.correlation,
    manifest: runtime.manifest,
    userAgent: runtime.userAgent
  });
  assert.equal(getterCalled, false);
  assert.deepEqual(projected, {
    source: 'options',
    type: 'UI_ACTION',
    action: 'RUN_CONFLICT_SCAN',
    phase: 'SCAN',
    code: 'CONFLICT_SCAN_COMPLETED',
    outcome: 'SUCCEEDED',
    counts: {enabled: 3, conflicts: 2, duplicates: 1},
    correlation: 'ATDC-ABCDEFGHIJKLMNOP',
    runtime: {browserFamily: 'Chromium', extensionVersion: '0.6.9.2'}
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /SECRET|Users|private|https|title|url|error/i);
  assert.equal(projectDiagnosticEvent({...hostile, phase: 'https://secret.example/'}, runtime), undefined);
  assert.equal(projectDiagnosticEvent({...hostile, counts: {failed: -1}}, runtime), undefined);
  assert.equal(DIAGNOSTIC_EVENT_TYPES.UI_ACTION, 'UI_ACTION');
});

test('events are durable, terminal incidents coexist with them, and full export is chronological', async () => {
  const store = memoryStore();
  const sessionStore = memoryStore();
  let clock = 30_000;
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-HISTORY-ONE',
    now: () => clock,
    sessionStore,
    store
  });
  await journal.event({
    command: 'discard-window', outcome: 'STARTED', phase: 'admission',
    source: 'popup', type: 'ACTION_START'
  });
  clock += 5;
  await journal.record(popupSnapshot({id: 'ATD-HISTORY-1', startedAt: 30_001}));
  clock += 5;
  await journal.event({
    command: 'discard-window', counts: {failed: 47, skipped: 19, total: 66},
    outcome: 'FAILED', phase: 'completion', source: 'popup', type: 'ACTION_END'
  });
  const saved = await journal.snapshot();
  assert.deepEqual(recordsFrom(saved).map(record => record.kind), ['event', 'incident', 'event']);
  assert.deepEqual(recordsFrom(saved).map(record => record.sequence), [1, 2, 3]);
  const exported = await journal.exportText({scope: 'all'});
  assert.equal(exported.recordCount, 3);
  assert.equal(exported.incidentCount, 1);
  assert.match(exported.text, /event=ACTION_START/);
  assert.match(exported.text, /incident=ATD-HISTORY-1 event=COMMAND_END/);
  assert.match(exported.text, /event=ACTION_END/);
  assert.ok(exported.text.indexOf('event=ACTION_START') <
    exported.text.indexOf('incident=ATD-HISTORY-1 event=COMMAND_END'));
  assert.ok(exported.text.indexOf('incident=ATD-HISTORY-1 event=COMMAND_END') <
    exported.text.indexOf('event=ACTION_END'));
  assert.doesNotMatch(exported.text, /secret\.example|SECRET|window:|100000|Users/i);
});

test('private events and incidents remain memory-only and vanish with the worker instance', async () => {
  const store = memoryStore();
  const sessionStore = memoryStore();
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-PRIVATE-SESSION',
    now: () => 40_000,
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  await first.event({
    action: 'COPY_DIAGNOSTICS', outcome: 'STARTED', phase: 'CLICK',
    source: 'popup', type: 'UI_ACTION'
  }, {privateContext: true});
  const privateSnapshot = popupSnapshot({id: 'ATD-PRIVATE-DEEP', startedAt: 40_000});
  privateSnapshot.privateContext = true;
  await first.record(privateSnapshot);
  assert.equal(store.writes(), 0);
  const access = {includeDurable: false, includePrivate: true};
  const current = await first.exportText({scope: 'current-session'}, access);
  assert.equal(current.recordCount, 2);
  assert.match(current.text, /COPY_DIAGNOSTICS|ATD-PRIVATE-DEEP/);

  const restarted = createDiagnosticJournal(options);
  assert.equal(await restarted.latest('ATD-PRIVATE-DEEP', access), undefined);
  assert.equal((await restarted.exportText({scope: 'current-session'}, access)).recordCount, 0);
  assert.equal(store.writes(), 0);
});

test('retention bounds total records and browser sessions, preserving the newest', async () => {
  const store = memoryStore();
  let clock = 50_000;
  for (const id of ['ATDS-RETENTION-ONE', 'ATDS-RETENTION-TWO', 'ATDS-RETENTION-THREE']) {
    const journal = createDiagnosticJournal({
      ...runtime,
      createSessionId: () => id,
      maxEvents: 3,
      maxSessions: 2,
      now: () => clock++,
      sessionStore: memoryStore(),
      store
    });
    await journal.event({source: 'worker', type: 'WORKER_START'});
    await journal.event({
      code: 'NO_CHANGE', outcome: 'COMPLETED', phase: 'completion',
      source: 'worker', type: 'ACTION_END'
    });
  }
  const reader = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-RETENTION-FOUR',
    maxEvents: 3,
    maxSessions: 2,
    now: () => clock,
    sessionStore: memoryStore(),
    store
  });
  const saved = await reader.snapshot();
  assert.ok(saved.sessions.length <= 2);
  assert.ok(recordsFrom(saved).length <= 3);
  assert.deepEqual(saved.sessions.map(session => session.id),
    ['ATDS-RETENTION-TWO', 'ATDS-RETENTION-THREE']);
  assert.deepEqual(recordsFrom(saved).map(record => record.sequence), [2, 1, 2]);
});

test('10k durable events use bounded chunk writes and restart from the committed sequence', async () => {
  const area = browserStorageArea();
  const store = diagnosticStorageAdapter(area);
  const sessionStore = memoryStore();
  let clock = 80_000;
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-STRESS-SESSION',
    now: () => clock,
    sessionStore,
    store
  };
  const journal = createDiagnosticJournal(options);
  for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS; index += 1) {
    clock += 1;
    const record = await journal.event({
      attempt: index,
      counts: {attempted: index, total: index},
      outcome: 'PROGRESS',
      phase: 'command',
      source: 'worker',
      type: 'ACTION_STAGE'
    });
    assert.equal(record?.sequence, index + 1);
  }

  const beforeRestart = await journal.snapshot();
  assert.equal(recordsFrom(beforeRestart).length, MAX_DIAGNOSTIC_EVENTS);
  assert.equal(sessionStore.writes(), 1,
    'the browser-session identity is written once, not checkpointed for every event');
  assert.ok(area.setCalls() <= MAX_DIAGNOSTIC_EVENTS + 1);
  assert.ok(area.maximumSetBytes() < 96 * 1024,
    'no append may rewrite a multi-megabyte history envelope');
  assert.ok(area.totalSetBytes() < 256 * 1024 * 1024,
    '10k append traffic must remain linear and bounded');
  const persisted = area.values();
  assert.equal(persisted[DIAGNOSTIC_STORAGE_KEY].layout, 'chunked-v1');
  assert.ok(Object.keys(persisted).length < 512);
  assert.ok(new TextEncoder().encode(JSON.stringify(persisted)).byteLength <= MAX_DIAGNOSTIC_BYTES);

  const restarted = createDiagnosticJournal({
    ...options,
    createSessionId: () => { throw Error('must reuse persisted browser session'); }
  });
  assert.deepEqual(await restarted.browserSession(), {
    id: 'ATDS-STRESS-SESSION',
    offsetMs: MAX_DIAGNOSTIC_EVENTS - 1,
    sequence: MAX_DIAGNOSTIC_EVENTS,
    startedAt: '1970-01-01T00:01:20.001Z'
  });
  assert.equal(sessionStore.writes(), 2,
    'one restart reconciliation derives the clock from the last committed chunk');
  clock += 1;
  const next = await restarted.event({source: 'worker', type: 'WORKER_START'});
  assert.equal(next.sequence, MAX_DIAGNOSTIC_EVENTS + 1);
  const retained = await restarted.snapshot();
  assert.equal(recordsFrom(retained).length, MAX_DIAGNOSTIC_EVENTS);
  assert.equal(recordsFrom(retained)[0].sequence, 2);
  assert.equal(recordsFrom(retained).at(-1).sequence, MAX_DIAGNOSTIC_EVENTS + 1);
});

test('failed atomic chunk commit leaves no ghost record and restart reconciles the next commit', async () => {
  const area = browserStorageArea();
  const store = diagnosticStorageAdapter(area);
  const sessionStore = memoryStore();
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-CRASH-SESSION',
    now: () => 95_000,
    sessionStore,
    store
  };
  const journal = createDiagnosticJournal(options);
  area.failNextSet();
  assert.equal(await journal.event({source: 'worker', type: 'WORKER_START'}), undefined);
  assert.deepEqual(area.values(), {});

  const committed = await journal.event({source: 'worker', type: 'WORKER_START'});
  assert.equal(committed.sequence, 2);
  assert.deepEqual(recordsFrom(await journal.snapshot()).map(record => record.sequence), [2]);

  const restarted = createDiagnosticJournal(options);
  assert.equal((await restarted.browserSession()).sequence, 2);
  assert.deepEqual(recordsFrom(await restarted.snapshot()).map(record => record.sequence), [2]);
});

test('clear enumerates orphan chunks, propagates removal failure, and preserves unrelated data', async () => {
  const area = browserStorageArea({preference: {theme: 'dark'}});
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-CLEAR-ORPHANS',
    now: () => 100_000,
    sessionStore: memoryStore(),
    store: diagnosticStorageAdapter(area)
  });
  await journal.event({source: 'worker', type: 'WORKER_START'});
  const orphanKey = `${DIAGNOSTIC_STORAGE_KEY}.chunk.ATDS-ORPHAN.999`;
  await area.set({[orphanKey]: {raw: 'orphan'}});

  area.failNextRemove();
  await assert.rejects(journal.clear(), /simulated diagnostic removal failure/);
  assert.equal(recordsFrom(await journal.snapshot()).length, 1,
    'a failed clear must leave the in-memory history intact');
  assert.equal(Object.hasOwn(area.values(), orphanKey), true);

  assert.deepEqual(await journal.clear(), {cleared: true});
  assert.deepEqual(area.values(), {preference: {theme: 'dark'}});
});

test('hydrate salvages every valid referenced chunk and removes corrupt, missing, and orphan refs', async () => {
  const area = browserStorageArea({preference: {enabled: true}});
  const store = diagnosticStorageAdapter(area);
  const sessionStore = memoryStore();
  let clock = 110_000;
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-SALVAGE-SESSION',
    now: () => clock,
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  for (let index = 0; index < 200; index += 1) {
    clock += 1;
    await first.event({source: 'worker', type: 'WORKER_START'});
  }
  const before = area.values();
  const indexed = before[DIAGNOSTIC_STORAGE_KEY].sessions[0].chunks;
  assert.ok(indexed.length >= 4);
  const missingKey = indexed[1];
  const corruptKey = indexed[2];
  const validKeys = indexed.filter(key => key !== missingKey && key !== corruptKey);
  const expectedSequences = validKeys.flatMap(key => before[key].records.map(record => record.sequence));
  const orphanKey = `${DIAGNOSTIC_STORAGE_KEY}.chunk.ATDS-UNREFERENCED.777`;
  await area.remove(missingKey);
  await area.set({
    [corruptKey]: {raw: 'SECRET https://private.invalid/'},
    [orphanKey]: {raw: 'unreferenced'}
  });

  const restarted = createDiagnosticJournal(options);
  const salvaged = await restarted.snapshot();
  assert.deepEqual(recordsFrom(salvaged).map(record => record.sequence), expectedSequences);
  assert.doesNotMatch((await restarted.exportText({scope: 'all'})).text,
    /SECRET|private\.invalid|unreferenced/);
  const repaired = area.values();
  assert.deepEqual(repaired[DIAGNOSTIC_STORAGE_KEY].sessions[0].chunks, validKeys);
  assert.equal(Object.hasOwn(repaired, corruptKey), false);
  assert.equal(Object.hasOwn(repaired, missingKey), false);
  assert.equal(Object.hasOwn(repaired, orphanKey), false);
  assert.deepEqual(repaired.preference, {enabled: true});
});

test('durable clear checkpoints session high-water so worker restart continues the sequence', async () => {
  const area = browserStorageArea();
  const store = diagnosticStorageAdapter(area);
  const sessionStore = memoryStore();
  let clock = 120_000;
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-CLEAR-RESTART',
    now: () => clock,
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  for (let index = 0; index < 3; index += 1) {
    clock += 1;
    await first.event({source: 'worker', type: 'WORKER_START'});
  }
  await first.clear();
  assert.deepEqual(area.values(), {});

  const restarted = createDiagnosticJournal({
    ...options,
    createSessionId: () => { throw Error('must retain the browser-session identity'); }
  });
  assert.equal((await restarted.browserSession()).sequence, 3);
  clock += 1;
  assert.equal((await restarted.event({source: 'worker', type: 'WORKER_START'})).sequence, 4);
});

test('pruning the final durable record checkpoints session high-water before restart', async () => {
  const area = browserStorageArea();
  const store = diagnosticStorageAdapter(area);
  const sessionStore = memoryStore();
  const options = {
    ...runtime,
    createSessionId: () => 'ATDS-PRUNE-RESTART',
    maxEvents: 0,
    now: () => 130_000,
    sessionStore,
    store
  };
  const first = createDiagnosticJournal(options);
  assert.equal((await first.event({source: 'worker', type: 'WORKER_START'})).sequence, 1);
  assert.equal(recordsFrom(await first.snapshot()).length, 0);

  const restarted = createDiagnosticJournal(options);
  assert.equal((await restarted.browserSession()).sequence, 1);
  assert.equal((await restarted.event({source: 'worker', type: 'WORKER_START'})).sequence, 2);
});

test('a transient durable hydrate failure is retried within the same worker', async () => {
  const base = memoryStore();
  let reads = 0;
  const store = {
    ...base,
    async read() {
      reads += 1;
      if (reads === 1) throw Error('transient durable read failure');
      return base.read();
    }
  };
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-RETRY-DURABLE',
    now: () => 140_000,
    sessionStore: memoryStore(),
    store
  });
  assert.equal(await journal.event({source: 'worker', type: 'WORKER_START'}), undefined);
  const recovered = await journal.event({source: 'worker', type: 'WORKER_START'});
  assert.equal(recovered?.sequence, 1);
  assert.equal(reads, 2);
  assert.equal(recordsFrom(await journal.snapshot()).length, 1);
});

test('a transient browser-session hydrate failure is retried within the same worker', async () => {
  const base = memoryStore();
  let reads = 0;
  const sessionStore = {
    ...base,
    async read() {
      reads += 1;
      if (reads === 1) throw Error('transient session read failure');
      return base.read();
    }
  };
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-RETRY-SESSION',
    now: () => 150_000,
    sessionStore,
    store: memoryStore()
  });
  assert.equal(await journal.event({source: 'worker', type: 'WORKER_START'}), undefined);
  const recovered = await journal.event({source: 'worker', type: 'WORKER_START'});
  assert.equal(recovered?.sequence, 1);
  assert.equal(reads, 2);
  assert.equal(recordsFrom(await journal.snapshot()).length, 1);
});

test('span API preserves a validated page correlation across the worker action timeline', async () => {
  const journal = createDiagnosticJournal({
    ...runtime,
    createCorrelationId: () => 'ATDC-ZYXWVUTSRQPONMLK',
    createSessionId: () => 'ATDS-SPAN-ONE',
    now: () => 60_000,
    sessionStore: memoryStore(),
    store: memoryStore()
  });
  const span = journal.start({
    action: 'discard-window',
    correlation: 'ATDC-ABCDEFGHIJKLMNOP',
    origin: 'context-menu'
  });
  await span.ready;
  await span.stage({phase: 'scope-query'});
  await span.retry({attempt: 2, code: 'RETRY_SCHEDULED'});
  await span.timeout({code: 'DEADLINE_EXCEEDED', phase: 'native-discard'});
  await span.finish({
    counts: {failed: 1, total: 1},
    outcome: 'FAILED',
    reasonCode: 'ACTION_FAILED'
  });
  const records = recordsFrom(await journal.snapshot());
  assert.deepEqual(records.map(record => record.type), [
    'ACTION_START', 'ACTION_STAGE', 'ACTION_RETRY', 'ACTION_TIMEOUT', 'ACTION_END'
  ]);
  assert.equal(span.token, 'ATDC-ABCDEFGHIJKLMNOP');
  assert.equal(records.every(record => record.correlation === span.token), true);
  assert.doesNotMatch(JSON.stringify(records), /ZYXWVUTSRQPONMLK/);
  assert.deepEqual(records.map(record => record.sequence), [1, 2, 3, 4, 5]);
});

test('best-effort event ingestion resolves undefined within a bounded session-store deadline', async () => {
  const hung = {get() {}, remove() {}, set() {}};
  const journal = createDiagnosticJournal({
    ...runtime,
    sessionStore: diagnosticSessionStorageAdapter(hung, undefined, {timeoutMs: 10}),
    store: memoryStore()
  });
  const started = Date.now();
  assert.equal(await journal.event({source: 'worker', type: 'WORKER_START'}), undefined);
  assert.ok(Date.now() - started < 500);
});

test('clearing durable history keeps the current browser-session identity and sequence', async () => {
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-CLEAR-SESSION',
    now: () => 70_000,
    sessionStore: memoryStore(),
    store: memoryStore()
  });
  await journal.event({source: 'worker', type: 'WORKER_START'});
  const before = await journal.browserSession();
  await journal.clear();
  await journal.event({source: 'worker', type: 'WORKER_START'});
  const after = await journal.browserSession();
  assert.equal(after.id, before.id);
  assert.equal(after.sequence, before.sequence + 1);
  assert.deepEqual(recordsFrom(await journal.snapshot()).map(record => record.sequence), [2]);
});

test('storage-change invalidation prevents an out-of-band clear from resurrecting cached history', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({
    ...runtime,
    createSessionId: () => 'ATDS-INVALIDATE-ONE',
    now: () => 80_000,
    sessionStore: memoryStore(),
    store
  });
  await journal.record(popupSnapshot({id: 'ATD-BEFORE-CLEAR', startedAt: 80_000}));
  await store.remove();
  void journal.invalidate({durable: true});
  await journal.record(popupSnapshot({id: 'ATD-AFTER-CLEAR', startedAt: 80_100}));
  assert.deepEqual(incidentsFrom(store.value()).map(incident => incident.id), ['ATD-AFTER-CLEAR']);
});

test('storage invalidation serializes behind an in-flight append without dropping prior history',
  async () => {
    const store = memoryStore();
    const journal = createDiagnosticJournal({
      ...runtime,
      createSessionId: () => 'ATDS-INVALIDATE-RACE',
      now: () => 81_000,
      sessionStore: memoryStore(),
      store
    });
    await journal.event({source: 'worker', type: 'WORKER_START'});
    const second = journal.event({source: 'worker', type: 'WORKER_START'});
    queueMicrotask(() => void journal.invalidate({durable: true}));
    await second;
    await journal.flush();
    assert.deepEqual(recordsFrom(await journal.snapshot()).map(record => record.sequence), [1, 2]);
  });

test('Chrome dual callback storage keeps every indexed chunk live across own changes and reload',
  async () => {
    let listener = () => {};
    const area = chromeDualStorageArea({}, (...args) => listener(...args));
    const store = diagnosticStorageAdapter(area);
    const sessionStore = memoryStore();
    let clock = 90_000;
    const options = {
      ...runtime,
      createSessionId: () => 'ATDS-CHROME-CALLBACK',
      now: () => clock++,
      sessionStore,
      store
    };
    const journal = createDiagnosticJournal(options);
    listener = createDiagnosticStorageChangeListener(journal);
    const payloads = [{
      action: 'COMMAND_CONTROL', code: 'CONTROL_ACTIVATED', outcome: 'STARTED',
      phase: 'CLICK', source: 'popup', type: 'UI_ACTION'
    }, {
      code: 'REQUEST_SENT', command: 'discard-window', outcome: 'STARTED',
      phase: 'SEND', source: 'popup', type: 'REQUEST'
    }, {
      code: 'SCAN_STARTED', command: 'discard-window', outcome: 'PROGRESS',
      phase: 'eligibility', source: 'worker', type: 'ACTION_STAGE'
    }];
    for (let index = 0; index < 120; index += 1) {
      await journal.event(payloads[index % payloads.length]);
    }
    const incidentId = 'ATD-CHROME-CALLBACK-INCIDENT';
    await journal.record(popupSnapshot({id: incidentId, startedAt: clock}));
    await journal.flush();

    const beforeReload = area.values();
    const index = beforeReload[DIAGNOSTIC_STORAGE_KEY];
    const referenced = index.sessions.flatMap(session => session.chunks);
    assert.ok(referenced.length > 1, 'the regression must cross a chunk boundary');
    assert.equal(referenced.every(key => Object.hasOwn(beforeReload, key)), true,
      'an own storage notification must never orphan a referenced chunk');
    assert.equal(referenced.flatMap(key => beforeReload[key].records).length, 121);

    const restarted = createDiagnosticJournal(options);
    listener = createDiagnosticStorageChangeListener(restarted);
    assert.equal(recordsFrom(await restarted.snapshot()).length, 121);
    const latest = await restarted.latest(incidentId);
    assert.equal(latest.id, incidentId);
    assert.deepEqual(latest.summary, {failed: 47, skipped: 19, success: 0});
    const exported = await restarted.exportText(incidentId);
    assert.equal(exported.incident.id, incidentId);
    assert.match(exported.text, /TAB_UNSUPPORTED|TAB_PROTECTED/);
    assert.doesNotMatch(exported.text, /SECRET|secret\.example|Users|window:/i);
    const afterReload = area.values();
    assert.equal(referenced.every(key => Object.hasOwn(afterReload, key)), true);
  });

test('worker wires terminal projection and all internal diagnostic endpoints without new permissions', async () => {
  const [menu, manifest, progress] = await Promise.all([
    readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/core/popup-progress.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(menu, /import \{diagnosticJournal\} from '\.\/core\/diagnostic-journal\.mjs'/);
  assert.match(menu, /recordDiagnostic:\s*snapshot => diagnosticJournal\.record\(snapshot\)/);
  for (const endpoint of [
    'diagnostics-latest', 'diagnostics-export', 'diagnostics-snapshot', 'diagnostics-clear'
  ]) {
    assert.match(menu, new RegExp(`request\\.method === '${endpoint}'`));
  }
  assert.match(menu,
    /request\.method === 'diagnostics-latest'[\s\S]*?diagnosticJournal\.latest\([\s\S]*?await diagnosticAccess\(request, sender\)/);
  assert.match(menu,
    /request\.method === 'diagnostics-export'[\s\S]*?diagnosticJournal\.exportText\([\s\S]*?await diagnosticAccess\(request, sender\)/);
  assert.match(menu,
    /request\.method === 'diagnostics-snapshot'[\s\S]*?diagnosticJournal\.snapshot\([\s\S]*?await diagnosticAccess\(request, sender\)/);
  assert.match(menu,
    /request\.method === 'diagnostics-clear'[\s\S]*?diagnosticJournal\.clear\([\s\S]*?await diagnosticAccess\(request, sender\)/);
  assert.match(progress, /if \(terminalStates\.has\(snapshot\.state\)\) \{[\s\S]*recordTerminalDiagnostic/);
  assert.match(progress, /setTimeout\(finish,[\s\S]*DEFAULT_DIAGNOSTIC_TIMEOUT/);
  assert.doesNotMatch(manifest, /"downloads"|"clipboardWrite"/);
});
