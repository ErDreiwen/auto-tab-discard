import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  createDiagnosticJournal,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_STORAGE_KEY,
  DIAGNOSTIC_VERSION,
  diagnosticStorageAdapter,
  formatDiagnosticLog,
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

test('projects every allowlisted generic failure cause without changing journal v1 shape', () => {
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
  assert.equal(DIAGNOSTIC_VERSION, 1);
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
  assert.equal(saved.incidents.length, 3);
  assert.deepEqual(saved.incidents.map(incident => incident.id),
    ['ATD-BOUND-6', 'ATD-BOUND-7', 'ATD-BOUND-8']);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).byteLength <= 5_000);
  assert.equal(store.writes(), 8);

  current += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await journal.snapshot()).incidents.length, 0);
  assert.equal(store.value().incidents.length, 0,
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
  assert.equal((await journal.snapshot()).incidents.length, 0);
  const privateAccess = {includeDurable: false, includePrivate: true};
  assert.equal(await journal.latest('ATD-PRIVATE-1'), undefined);
  assert.equal((await journal.latest('ATD-PRIVATE-1', privateAccess)).id, 'ATD-PRIVATE-1');
  assert.match((await journal.exportText('ATD-PRIVATE-1', privateAccess)).text, /ATD-PRIVATE-1/);
});

test('private snapshot access cannot project durable regular incidents', async () => {
  const store = memoryStore();
  const journal = createDiagnosticJournal({...runtime, now: () => 1_800_000_010_000, store});
  await journal.record(popupSnapshot({id: 'ATD-REGULAR-1'}));

  assert.deepEqual((await journal.snapshot()).incidents.map(incident => incident.id),
    ['ATD-REGULAR-1']);
  assert.deepEqual((await journal.snapshot({includeDurable: false})).incidents, []);
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
  assert.deepEqual(await journal.exportText('ATD-PRIVATE-2', regularAccess), {
    incident: null,
    text: ''
  });
  assert.deepEqual((await journal.snapshot(regularAccess)).incidents.map(incident => incident.id),
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

test('worker wires terminal projection and all internal diagnostic endpoints without new permissions', async () => {
  const [menu, manifest, progress] = await Promise.all([
    readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/core/popup-progress.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(menu, /createDiagnosticJournal\(\)/);
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
