import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionCounts,
  cancelPopupProgressWithDiagnostics,
  createActionDiagnostics,
  createDiagnosticCapabilityCache,
  projectActionEvent,
  runConflictScanEndpoint,
  terminalDiagnosticResponse,
  terminalProjection
} from '../v3/worker/core/action-diagnostics.mjs';
import {FAILURE_CAUSES} from '../v3/worker/core/failure-causes.mjs';

const recorder = ({failMethods = false} = {}) => {
  const calls = [];
  const invoke = (method, payload) => {
    calls.push({method, payload: structuredClone(payload)});
    return failMethods ? Promise.reject(Error('diagnostic storage unavailable')) :
      Promise.resolve({method});
  };
  return {
    calls,
    journal: {
      event(payload, access) {
        calls.push({access: structuredClone(access), method: 'event', payload: structuredClone(payload)});
        return failMethods ? Promise.reject(Error('diagnostic event unavailable')) : Promise.resolve(payload);
      },
      start(payload, access) {
        calls.push({access: structuredClone(access), method: 'start', payload: structuredClone(payload)});
        if (failMethods) throw Error('diagnostic start unavailable');
        return {
          finish: payload => invoke('finish', payload),
          ready: Promise.resolve(),
          retry: payload => invoke('retry', payload),
          stage: payload => invoke('stage', payload),
          timeout: payload => invoke('timeout', payload),
          token: 'opaque-test-token'
        };
      }
    }
  };
};

test('action summary de-duplicates tab identities transiently and emits counts only', () => {
  const result = {
    alreadyOwned: [{id: 2, title: 'SECRET skipped title'}],
    failed: [{reason: 'SECRET raw browser error', tab: {id: 3, url: 'https://secret.invalid/'}}],
    physicalOnly: [{reason: 'SECRET marker reason', tab: {id: 1}}],
    protected: [{tab: {id: 4}}],
    succeeded: [{tab: {id: 1}}, {tab: {id: 2}}],
    unsupported: [{tab: {id: 5}}]
  };

  const counts = actionCounts(result);
  assert.deepEqual(counts, {
    failed: 2,
    protected: 1,
    skipped: 2,
    success: 1,
    total: 5,
    unsupported: 1
  });
  const serialized = JSON.stringify(counts);
  assert.doesNotMatch(serialized, /SECRET|secret\.invalid|\b[1-5]\b.*(?:id|tab)/i);
});

test('direct popup summary is accepted without retaining outcomes or identifiers', () => {
  const result = {
    outcomes: {
      717171: {code: 'TAB_FAILED', reason: 'SECRET-CANARY'}
    },
    summary: {failed: 47, skipped: 19, success: 0},
    total: 66,
    windowId: 818181
  };
  assert.deepEqual(actionCounts(result), {failed: 47, skipped: 19, success: 0, total: 66});
  assert.deepEqual(terminalProjection(result), {
    counts: {failed: 47, skipped: 19, success: 0, total: 66},
    outcome: 'failed',
    phase: 'completion'
  });
});

test('a navigation no-op is terminally skipped instead of reported as success', () => {
  assert.deepEqual(terminalProjection({code: 'NO_CHANGE'}), {
    code: 'NO_CHANGE',
    counts: {failed: 0, skipped: 0, success: 0, total: 0},
    outcome: 'skipped',
    phase: 'completion'
  });
});

test('instrumented actions record fixed stages, retries, timeout, and terminal aggregates', async () => {
  const observed = recorder();
  const diagnostics = createActionDiagnostics(observed.journal);
  const value = await diagnostics.run({
    command: 'discard-window',
    correlation: 'ATDC-0123456789ABCDEF',
    privateContext: true,
    source: 'popup'
  }, async action => {
    await action.stage({phase: 'scope-query'});
    await action.retry({attempt: 2, phase: 'takeover'});
    await action.timeout({
      attempt: 2,
      code: FAILURE_CAUSES.NATIVE_TIMEOUT,
      counts: {attempted: 4, timedOut: 1},
      phase: 'native-discard'
    });
    return {
      failed: [{tab: {id: 91}}],
      protected: [{tab: {id: 92}}],
      succeeded: [{tab: {id: 93}}]
    };
  });

  assert.equal(value.succeeded.length, 1);
  assert.deepEqual(observed.calls[0], {
    access: {privateContext: true},
    method: 'start',
    payload: {
      command: 'discard-window',
      correlation: 'ATDC-0123456789ABCDEF',
      source: 'popup'
    }
  });
  assert.deepEqual(observed.calls.map(call => call.method), [
    'start', 'stage', 'stage', 'retry', 'timeout', 'finish'
  ]);
  assert.deepEqual(observed.calls.at(-1).payload, {
    counts: {failed: 1, protected: 1, skipped: 1, success: 1, total: 3},
    outcome: 'partial',
    phase: 'completion'
  });
  assert.doesNotMatch(JSON.stringify(observed.calls), /91|92|93|secret\.invalid|title|raw browser error/i);
});

test('diagnostic start/storage failures never change action authority', async () => {
  const diagnostics = createActionDiagnostics(recorder({failMethods: true}).journal);
  assert.equal(await diagnostics.run({
    command: 'automatic-scan',
    source: 'automatic-alarm'
  }, async () => 42), 42);

  const authority = Error('authoritative browser failure');
  authority.failureCause = FAILURE_CAUSES.NATIVE_REJECTED;
  await assert.rejects(
    diagnostics.run({command: 'discard-tab', source: 'keyboard'}, async () => {
      throw authority;
    }),
    error => error === authority
  );
});

test('event ingestion projection drops unknown fields, getters, identifiers, and free-form data', async () => {
  const observed = recorder();
  const diagnostics = createActionDiagnostics(observed.journal);
  const input = {
    type: 'action-stage',
    source: 'settings',
    command: 'settings-import',
    phase: 'settings',
    outcome: 'success',
    counts: {attempted: 1, unknown: 717171},
    privateContext: false,
    tabId: 818181,
    url: 'https://secret.invalid/',
    rawError: 'SECRET-CANARY'
  };
  Object.defineProperty(input, 'title', {
    enumerable: true,
    get() {
      throw Error('getter must never execute');
    }
  });

  await diagnostics.event(input);
  assert.deepEqual(observed.calls, [{
    access: {privateContext: false},
    method: 'event',
    payload: {
      command: 'settings-import',
      counts: {attempted: 1},
      outcome: 'success',
      phase: 'settings',
      source: 'settings',
      type: 'action-stage'
    }
  }]);
  assert.doesNotMatch(JSON.stringify(observed.calls), /717171|818181|SECRET|secret\.invalid|rawError|title/);
});

test('page event projection accepts only fixed UI fields and strict opaque correlation', () => {
  assert.deepEqual(projectActionEvent({
    action: 'RUN_CONFLICT_SCAN',
    code: 'CONFLICT_SCAN_COMPLETED',
    correlation: 'ATDC-0123456789ABCDEF',
    counts: {conflicts: 2, disabled: 1, duplicates: 1, enabled: 4},
    outcome: 'SUCCEEDED',
    phase: 'SCAN',
    source: 'options',
    type: 'RESPONSE',
    url: 'https://secret.invalid/'
  }), {
    action: 'RUN_CONFLICT_SCAN',
    code: 'CONFLICT_SCAN_COMPLETED',
    correlation: 'ATDC-0123456789ABCDEF',
    counts: {conflicts: 2, disabled: 1, duplicates: 1, enabled: 4},
    outcome: 'SUCCEEDED',
    phase: 'SCAN',
    source: 'options',
    type: 'RESPONSE'
  });
  assert.equal(projectActionEvent({
    correlation: 'attacker-controlled',
    source: 'popup',
    type: 'REQUEST'
  }), undefined);
  assert.equal(projectActionEvent({
    action: 'FREE_FORM_CONTROL',
    source: 'popup',
    type: 'UI_ACTION'
  }), undefined);
});

test('popup correlation capabilities are bounded, expire, preserve access, and end on terminal response', () => {
  let now = 1000;
  const cache = createDiagnosticCapabilityCache({maxEntries: 2, now: () => now, ttlMs: 50});
  const regular = {
    includeDurable: true,
    includePrivate: false
  };
  const privateAccess = {
    includeDurable: false,
    includePrivate: true
  };
  const first = 'ATDC-0000000000000001';
  const second = 'ATDC-0000000000000002';
  const third = 'ATDC-0000000000000003';

  assert.equal(cache.remember(first, regular), true);
  assert.equal(cache.remember(second, privateAccess), true);
  assert.deepEqual(cache.resolve(second), {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  });
  assert.equal(cache.remember(third, regular), true);
  assert.equal(cache.size(), 2);
  assert.equal(cache.resolve(first), undefined, 'oldest capability is evicted at the fixed limit');
  now += 51;
  assert.equal(cache.resolve(second), undefined, 'capabilities expire on their bounded TTL');
  assert.equal(terminalDiagnosticResponse({type: 'RESPONSE', outcome: 'PROGRESS'}), false);
  assert.equal(terminalDiagnosticResponse({type: 'RESPONSE', outcome: 'COMPLETED'}), true);
});

test('popup cancellation records a cancelled response only after authoritative acceptance', async () => {
  const order = [];
  const response = {accepted: true, snapshot: {jobId: 'must-not-be-journaled', state: 'cancelling'}};
  const value = await cancelPopupProgressWithDiagnostics({
    actionDiagnostics: {event: async event => {
      order.push({event: structuredClone(event), operation: 'event'});
    }},
    cancel: async () => {
      order.push({operation: 'cancel'});
      return response;
    },
    command: 'discard-tabs',
    correlation: 'ATDC-0123456789ABCDEF',
    jobId: 'private-job-id',
    privateContext: true
  });

  assert.equal(value, response);
  assert.deepEqual(order, [{operation: 'cancel'}, {
    event: {
      code: 'ACTION_CANCELLED',
      command: 'discard-tabs',
      correlation: 'ATDC-0123456789ABCDEF',
      outcome: 'CANCELLED',
      phase: 'CANCEL',
      privateContext: true,
      source: 'popup',
      type: 'RESPONSE'
    },
    operation: 'event'
  }]);
  assert.doesNotMatch(JSON.stringify(order), /private-job-id|must-not-be-journaled/);
});

test('conflict endpoint deadline includes a slow journal and never starts the scan afterward', async () => {
  let releaseJournal;
  let scans = 0;
  const events = [];
  const journalGate = new Promise(resolve => releaseJournal = resolve);
  const pending = runConflictScanEndpoint({
    actionDiagnostics: {event: async event => {
      events.push(structuredClone(event));
      await journalGate;
    }},
    authorize: async () => ({
      correlation: 'ATDC-0123456789ABCDEF',
      privateContext: true
    }),
    checkPermission: async () => true,
    scan: async () => {
      scans += 1;
      return {counts: {}, signals: []};
    },
    timeoutMs: 10
  });

  await assert.rejects(pending, error => error.code === 'CONFLICT_SCAN_TIMEOUT');
  releaseJournal();
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(scans, 0);
  assert.deepEqual(events.map(event => event.code), ['CONFLICT_SCAN_STARTED']);
  assert.equal(events.some(event => event.code === 'CONFLICT_SCAN_COMPLETED'), false);
});

test('conflict endpoint does not emit signal or success records when a late scan settles', async () => {
  let releaseScan;
  const events = [];
  const scanGate = new Promise(resolve => releaseScan = resolve);
  const pending = runConflictScanEndpoint({
    actionDiagnostics: {event: async event => events.push(structuredClone(event))},
    authorize: async () => ({correlation: 'ATDC-FEDCBA9876543210'}),
    checkPermission: async () => true,
    scan: async () => scanGate,
    signalCodes: ['DUPLICATE_SELF_ENABLED'],
    timeoutMs: 10
  });

  await assert.rejects(pending, error => error.code === 'CONFLICT_SCAN_TIMEOUT');
  releaseScan({
    counts: {duplicateCopies: 1},
    signals: ['DUPLICATE_SELF_ENABLED']
  });
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(events.map(event => event.code), ['CONFLICT_SCAN_STARTED']);
  assert.equal(events.some(event => ['DUPLICATE_SELF_ENABLED', 'CONFLICT_SCAN_COMPLETED']
    .includes(event.code)), false);
});

test('conflict endpoint threads browser-owned privacy into the scan and every record', async () => {
  const events = [];
  let scanOptions;
  const result = await runConflictScanEndpoint({
    actionDiagnostics: {event: async event => events.push(structuredClone(event))},
    authorize: async () => ({
      correlation: 'ATDC-ABCDEF0123456789',
      privateContext: true
    }),
    checkPermission: async () => true,
    scan: async options => {
      scanOptions = structuredClone(options);
      return {counts: {externalSleepers: 1}, signals: ['EXTERNAL_SLEEPERS_PRESENT']};
    },
    signalCodes: ['EXTERNAL_SLEEPERS_PRESENT'],
    timeoutMs: 100
  });

  assert.deepEqual(scanOptions, {privateContext: true});
  assert.equal(result.counts.externalSleepers, 1);
  assert.deepEqual(events.map(event => event.code), [
    'CONFLICT_SCAN_STARTED',
    'EXTERNAL_SLEEPERS_PRESENT',
    'CONFLICT_SCAN_COMPLETED'
  ]);
  assert.equal(events.every(event => event.privateContext === true &&
    event.correlation === 'ATDC-ABCDEF0123456789'), true);
});
