import test from 'node:test';
import assert from 'node:assert/strict';

import {validateRuleList} from '../v3/worker/core/rules.mjs';
import {
  commitSettingsImport,
  MAX_BACKUP_BYTES,
  parseSettingsBackup,
  PLUGIN_KEYS,
  RAW_BACKUP_LABEL,
  serializeRawSettingsBackup,
  SettingsBackupError,
  SettingsImportTransactionError,
  validateSettingsRecord
} from '../v3/data/options/core/settings-backup.mjs';
import {
  serializeSupportBundle,
  SUPPORT_BUNDLE_LABEL,
  SUPPORT_BUNDLE_VERSION,
  SUPPORT_OMISSION_POLICY
} from '../v3/data/options/core/support-bundle.mjs';
import {
  createSettingsImportTransaction,
  MAX_SETTINGS_IMPORT_TRANSACTION_BYTES,
  recoverSettingsImport,
  recoverSettingsImportStorage,
  SETTINGS_IMPORT_FENCE_KEY,
  SETTINGS_IMPORT_LOCK_NAME,
  SETTINGS_IMPORT_PHASES,
  SETTINGS_IMPORT_TRANSACTION_KEY,
  SettingsImportRecoveryError,
  settingsImportTransactionPhase,
  withSettingsImportLock
} from '../v3/worker/core/settings-import-transaction.mjs';

const rules = (values, {format}) => validateRuleList(values, {format});

const settings = (extra = {}) => ({
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

const backupText = value => JSON.stringify({
  exportedAt: '2026-08-12T12:00:00.000Z',
  format: 'auto-tab-discard-settings',
  label: RAW_BACKUP_LABEL,
  settings: value,
  version: 1
});

test('raw export is versioned, explicitly labeled, normalized, and strips internal state', () => {
  const text = serializeRawSettingsBackup(settings({
    '__blankHelperRegistry': {tab: 4},
    '__discardOwnership': {4: {title: 'private'}},
    [SETTINGS_IMPORT_TRANSACTION_KEY]: {phase: SETTINGS_IMPORT_PHASES.PREPARED},
    'last-update': 123,
    prepends: '  e\u0301\u202e   marker  ',
    'tmp_disable': 12,
    whitelist: ['example.test']
  }), {
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    validateRules: rules
  });
  const document = JSON.parse(text);

  assert.equal(document.version, 1);
  assert.equal(document.label, RAW_BACKUP_LABEL);
  assert.equal(document.settings.prepends, 'é marker'.normalize('NFC'));
  assert.deepEqual(document.settings.whitelist, ['example.test']);
  assert.equal('__discardOwnership' in document.settings, false);
  assert.equal('__blankHelperRegistry' in document.settings, false);
  assert.equal(SETTINGS_IMPORT_TRANSACTION_KEY in document.settings, false);
  assert.equal('last-update' in document.settings, false);
  assert.equal('tmp_disable' in document.settings, false);
});

test('raw backup round-trips the external extension pairing allowlist', () => {
  const ids = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'trusted-addon@example.test'
  ];
  const text = serializeRawSettingsBackup(settings({
    'external.trusted-ids': ids
  }), {
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    validateRules: rules
  });
  const parsed = parseSettingsBackup(text, {validateRules: rules});
  assert.deepEqual(parsed.document.settings['external.trusted-ids'], ids);

  for (const invalid of [
    ['duplicate', ids[0], ids[0]],
    ['contains whitespace', 'not trusted'],
    ['']
  ]) {
    assert.throws(
      () => serializeRawSettingsBackup(settings({'external.trusted-ids': invalid})),
      error => error instanceof SettingsBackupError
    );
  }
});

test('current legacy backup shape migrates historical fields and drops local/internal state', () => {
  const legacy = JSON.stringify({
    'chrome.storage.local': {
      '__discardOwnership': {'1': {source: 'self'}},
      audio: true,
      'lifecycle-feedback': true,
      'release-next-tab': true,
      'trash.enabled': true,
      whitelist: ['example.test']
    },
    localStorage: {
      click: 'discard-tab',
      'explore-count': '12'
    }
  });
  const result = parseSettingsBackup(legacy, {validateRules: rules});

  assert.equal(result.migratedFrom, 'legacy-v0');
  assert.equal(result.document.settings.click, 'click.discard-tab');
  assert.equal(result.document.settings['./plugins/next/core.js'], true);
  assert.equal(result.document.settings['./plugins/trash/core.js'], true);
  assert.equal(result.document.settings['lifecycle-feedback'], true);
  assert.equal('__discardOwnership' in result.document.settings, false);
  assert.equal('release-next-tab' in result.document.settings, false);
  assert.equal('trash.enabled' in result.document.settings, false);
});

test('legacy v3 click.discard value migrates to the current discard-tab action', () => {
  const result = parseSettingsBackup(JSON.stringify({
    'chrome.storage.local': {click: 'click.discard', 'use-cache': true},
    localStorage: {}
  }), {validateRules: rules});
  assert.equal(result.document.settings.click, 'click.discard-tab');
  assert.equal(result.document.settings['use-cache'], true);
});

test('versioned export normalizes a historical click value before serialization', () => {
  const document = JSON.parse(serializeRawSettingsBackup(settings({
    click: 'click.discard'
  }), {validateRules: rules}));
  assert.equal(document.settings.click, 'click.discard-tab');
});

test('deprecated dummy plugin values are accepted only as migration input and dropped', () => {
  const deprecated = './plugins/dummy/core.js';
  const parsed = parseSettingsBackup(backupText(settings({
    [deprecated]: true
  })), {validateRules: rules});
  const exported = JSON.parse(serializeRawSettingsBackup(settings({
    [deprecated]: false
  }), {validateRules: rules}));

  assert.equal(deprecated in parsed.document.settings, false);
  assert.equal(deprecated in exported.settings, false);
  assert.equal(PLUGIN_KEYS.includes(deprecated), false);
  assert.throws(
    () => parseSettingsBackup(backupText(settings({[deprecated]: 'true'}))),
    error => error instanceof SettingsBackupError && error.code === 'invalid-type'
  );
});

test('backup size is capped before parsing', () => {
  assert.throws(
    () => parseSettingsBackup(' '.repeat(MAX_BACKUP_BYTES + 1)),
    error => error instanceof SettingsBackupError && error.code === 'size-limit'
  );
});

test('schema rejects unknown, hostile, mistyped, out-of-range, and unknown plug-in keys', async t => {
  const cases = [
    ['unknown setting', settings({surprise: true}), 'unknown-key'],
    ['unknown plug-in', settings({'./plugins/hostile/core.js': true}), 'unknown-plugin'],
    ['mistyped setting', settings({audio: 'true'}), 'invalid-type'],
    ['out-of-range setting', settings({period: -1}), 'range']
  ];
  for (const [name, value, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseSettingsBackup(backupText(value), {validateRules: rules}),
        error => error instanceof SettingsBackupError && error.code === code
      );
    });
  }

  await t.test('prototype pollution key', () => {
    const hostile = backupText(settings()).replace(
      '"settings":{',
      '"settings":{"constructor":{"prototype":{"polluted":true}},'
    );
    assert.throws(
      () => parseSettingsBackup(hostile, {validateRules: rules}),
      error => error instanceof SettingsBackupError && error.code === 'prototype-pollution'
    );
    assert.equal({}.polluted, undefined);
  });
});

test('unsafe rule rejection includes the preference and reason before mutation', () => {
  assert.throws(
    () => validateSettingsRecord(settings({
      whitelist: ['re:(a+)+']
    }), {validateRules: rules}),
    error => error instanceof SettingsBackupError &&
      error.code === 'invalid-rule' &&
      error.path === '$.settings.whitelist[0]' &&
      /nested quantifiers/i.test(error.message)
  );
});

const transaction = ({failure} = {}) => {
  const original = {
    local: {click: 'discard-tab', 'explore-count': '4', secret: 'exact-local-snapshot'},
    storage: {
      '__diagnosticJournal': {entries: [{stage: 'old'}]},
      '__discardOwnership': {version: 4, records: {7: {state: 'owned'}}},
      audio: false,
      nested: {preserved: true}
    }
  };
  const state = structuredClone(original);
  let localCalls = 0;
  let removeCalls = 0;
  let writeCalls = 0;
  const failed = new Set();
  const failOnce = (name, message) => {
    if (failure === name && !failed.has(name)) {
      failed.add(name);
      throw new Error(message);
    }
  };
  const adapter = {
    async readLocalStorage() {
      return structuredClone(state.local);
    },
    async readStorage() {
      return structuredClone(state.storage);
    },
    async readTransaction() {
      return SETTINGS_IMPORT_TRANSACTION_KEY in state.storage ? {
        [SETTINGS_IMPORT_FENCE_KEY]: structuredClone(
          state.storage[SETTINGS_IMPORT_FENCE_KEY]
        ),
        [SETTINGS_IMPORT_TRANSACTION_KEY]: structuredClone(
          state.storage[SETTINGS_IMPORT_TRANSACTION_KEY]
        )
      } : {};
    },
    async removeStorage(keys) {
      removeCalls += 1;
      for (const key of keys) {
        delete state.storage[key];
      }
      const removesUserData = keys.some(key => !key.startsWith('__'));
      if (removesUserData) {
        failOnce('remove', 'storage removal failed');
      }
      if (keys.includes(SETTINGS_IMPORT_TRANSACTION_KEY)) {
        failOnce('finalize', 'transaction cleanup failed');
      }
    },
    async replaceLocalStorage(value) {
      localCalls += 1;
      state.local = {};
      failOnce('local', 'local replacement failed');
      state.local = structuredClone(value);
    },
    async writeStorage(value) {
      writeCalls += 1;
      Object.assign(state.storage, structuredClone(value));
      if (!(SETTINGS_IMPORT_TRANSACTION_KEY in value)) {
        failOnce('write', 'storage write failed');
      }
    }
  };
  return {adapter, original, state, calls: {get local() { return localCalls; }, get remove() {
    return removeCalls;
  }, get write() { return writeCalls; }}};
};

const assertTerminal = (fixture, phase) => {
  const marker = fixture.state.storage[SETTINGS_IMPORT_TRANSACTION_KEY];
  assert.equal(marker.phase, phase);
  assert.equal(fixture.state.storage[SETTINGS_IMPORT_FENCE_KEY], marker.fence);
};

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
};

const exclusiveLockManager = () => {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  return {
    get maxActive() {
      return maxActive;
    },
    request(name, options, callback) {
      assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
      assert.equal(options.mode, 'exclusive');
      const previous = tail;
      const gate = deferred();
      tail = gate.promise;
      return previous.then(async () => {
        if (options.signal.aborted) {
          gate.resolve();
          throw options.signal.reason;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await callback({mode: 'exclusive', name});
        }
        finally {
          active -= 1;
          gate.resolve();
        }
      });
    }
  };
};

test('every mutation failure rolls storage and localStorage back byte-for-byte', async t => {
  for (const failure of ['write', 'remove', 'local']) {
    await t.test(failure, async () => {
      const fixture = transaction({failure});
      await assert.rejects(
        commitSettingsImport({audio: true}, fixture.adapter),
        SettingsImportTransactionError
      );
      assert.deepEqual(fixture.state, fixture.original);
    });
  }
});

test('fence loss immediately after each destructive mutation rejects and restores exact state', async t => {
  for (const mutation of ['write', 'remove', 'local']) {
    await t.test(mutation, async () => {
      const fixture = transaction();
      let fenced = false;
      const fenceAfter = async task => {
        await task();
        if (!fenced) {
          fenced = true;
          fixture.state.storage[SETTINGS_IMPORT_FENCE_KEY] = `foreign-${mutation}`;
        }
      };
      if (mutation === 'write') {
        const write = fixture.adapter.writeStorage;
        fixture.adapter.writeStorage = values =>
          SETTINGS_IMPORT_TRANSACTION_KEY in values ? write(values) : fenceAfter(() => write(values));
      }
      else if (mutation === 'remove') {
        const remove = fixture.adapter.removeStorage;
        fixture.adapter.removeStorage = keys => keys.some(key => !key.startsWith('__')) ?
          fenceAfter(() => remove(keys)) : remove(keys);
      }
      else {
        const replace = fixture.adapter.replaceLocalStorage;
        fixture.adapter.replaceLocalStorage = values => fenceAfter(() => replace(values));
      }

      await assert.rejects(
        commitSettingsImport(settings(), fixture.adapter, {validateRules: rules}),
        SettingsImportTransactionError
      );
      assert.deepEqual(fixture.state, fixture.original);
    });
  }
});

test('successful import replaces both stores and leaves no historical localStorage', async () => {
  const fixture = transaction({});
  const imported = settings({audio: true});
  await commitSettingsImport(imported, fixture.adapter, {validateRules: rules});
  assert.deepEqual(fixture.state.local, {});
  assert.deepEqual(fixture.state.storage, {
    '__diagnosticJournal': fixture.original.storage.__diagnosticJournal,
    '__discardOwnership': fixture.original.storage.__discardOwnership,
    ...imported
  });
  assert.equal(SETTINGS_IMPORT_TRANSACTION_KEY in fixture.state.storage, false);
  assert.equal(SETTINGS_IMPORT_FENCE_KEY in fixture.state.storage, false);
});

test('restart after every durable import checkpoint deterministically rolls back or completes', async t => {
  const checkpoints = [
    'prepared',
    'storage-write-pending',
    'storage-written',
    'storage-remove-pending',
    'storage-removed',
    'local-replace-pending',
    'local-replaced',
    'committed',
    'finalized'
  ];
  const imported = settings({audio: true, period: 1200});

  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async () => {
      const fixture = transaction();
      let reached;
      const paused = new Promise(resolve => {
        reached = resolve;
      });
      const terminated = new Promise(() => {});
      void commitSettingsImport(imported, fixture.adapter, {
        checkpoint: phase => {
          if (phase === checkpoint) {
            reached();
            return terminated;
          }
        },
        now: () => 1_800_000_000_000,
        lockHeld: true,
        transactionId: `restart-${checkpoint}`,
        validateRules: rules
      });
      await paused;

      const recovery = await recoverSettingsImport(fixture.adapter, {
        now: () => 1_800_000_010_000
      });
      if (checkpoint === 'committed' || checkpoint === 'finalized') {
        assert.ok(['completed', 'none'].includes(recovery.status), checkpoint);
        assert.deepEqual(fixture.state.local, {}, checkpoint);
        assert.deepEqual(fixture.state.storage, {
          '__diagnosticJournal': fixture.original.storage.__diagnosticJournal,
          '__discardOwnership': fixture.original.storage.__discardOwnership,
          ...imported
        }, checkpoint);
      }
      else {
        assert.equal(recovery.status, 'rolled-back', checkpoint);
        assert.deepEqual(fixture.state, fixture.original, checkpoint);
      }
      assert.equal(SETTINGS_IMPORT_TRANSACTION_KEY in fixture.state.storage, false, checkpoint);
      assert.equal(SETTINGS_IMPORT_FENCE_KEY in fixture.state.storage, false, checkpoint);
    });
  }
});

test('worker-only recovery preserves a localStorage rollback marker until Options can finish', async () => {
  const fixture = transaction();
  let reached;
  const paused = new Promise(resolve => {
    reached = resolve;
  });
  void commitSettingsImport(settings({audio: true}), fixture.adapter, {
    checkpoint: phase => {
      if (phase === 'local-replaced') {
        reached();
        return new Promise(() => {});
      }
    },
    now: () => 1_800_000_000_000,
    lockHeld: true,
    transactionId: 'worker-local-rollback',
    validateRules: rules
  });
  await paused;

  const storageOnly = {
    readStorage: fixture.adapter.readStorage,
    readTransaction: fixture.adapter.readTransaction,
    removeStorage: fixture.adapter.removeStorage,
    writeStorage: fixture.adapter.writeStorage
  };
  const workerRecovery = await recoverSettingsImport(storageOnly, {
    now: () => 1_800_000_010_000,
    storageOnly: true
  });
  assert.deepEqual(workerRecovery, {pendingLocalStorage: true, status: 'rolled-back-storage'});
  assert.deepEqual(fixture.state.local, {}, 'a worker cannot access DOM localStorage');
  assert.deepEqual(fixture.state.storage[SETTINGS_IMPORT_TRANSACTION_KEY].phase,
    SETTINGS_IMPORT_PHASES.LOCAL_ROLLBACK_PENDING);
  assert.deepEqual(
    Object.fromEntries(Object.entries(fixture.state.storage).filter(([key]) => !key.startsWith('__'))),
    {audio: false, nested: {preserved: true}}
  );

  const mutationCalls = {
    remove: fixture.calls.remove,
    write: fixture.calls.write
  };
  assert.deepEqual(await recoverSettingsImport(storageOnly, {storageOnly: true}),
    {pendingLocalStorage: true, status: 'rolled-back-storage'});
  assert.deepEqual({remove: fixture.calls.remove, write: fixture.calls.write}, mutationCalls,
    'an already-correct pending rollback must not amplify writes on every preference read');

  assert.deepEqual(await recoverSettingsImport(fixture.adapter), {status: 'rolled-back'});
  assert.deepEqual(fixture.state, fixture.original,
    'the next Options startup restores localStorage from the durable marker');
});

test('a worker fence prevents a stale Options owner from resuming at every checkpoint', async t => {
  const checkpoints = [
    'prepared',
    'storage-write-pending',
    'storage-written',
    'storage-remove-pending',
    'storage-removed',
    'local-replace-pending',
    'local-replaced',
    'committed',
    'finalized'
  ];
  const imported = settings({audio: true, period: 1800});

  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async () => {
      const fixture = transaction();
      const reached = deferred();
      const resume = deferred();
      const operation = commitSettingsImport(imported, fixture.adapter, {
        checkpoint: phase => {
          if (phase === checkpoint) {
            reached.resolve();
            return resume.promise;
          }
        },
        now: () => 1_800_000_000_000,
        lockHeld: true,
        transactionId: `fenced-${checkpoint}`,
        validateRules: rules
      });
      await reached.promise;

      const storageOnly = {
        readStorage: fixture.adapter.readStorage,
        readTransaction: fixture.adapter.readTransaction,
        removeStorage: fixture.adapter.removeStorage,
        writeStorage: fixture.adapter.writeStorage
      };
      const recovery = await recoverSettingsImport(storageOnly, {
        now: () => 1_800_000_010_000,
        storageOnly: true
      });
      resume.resolve();

      if (checkpoint === 'committed' || checkpoint === 'finalized') {
        await operation;
        assert.ok(['completed', 'none'].includes(recovery.status), checkpoint);
        assert.deepEqual(fixture.state.local, {}, checkpoint);
        assert.deepEqual(fixture.state.storage, {
          '__diagnosticJournal': fixture.original.storage.__diagnosticJournal,
          '__discardOwnership': fixture.original.storage.__discardOwnership,
          ...imported
        }, checkpoint);
      }
      else {
        await assert.rejects(operation, SettingsImportTransactionError, checkpoint);
        assert.deepEqual(fixture.state, fixture.original, checkpoint);
      }
      assert.equal(SETTINGS_IMPORT_TRANSACTION_KEY in fixture.state.storage, false, checkpoint);
      assert.equal(SETTINGS_IMPORT_FENCE_KEY in fixture.state.storage, false, checkpoint);
    });
  }
});

test('origin-wide lock serializes two Options imports and preserves the later complete image', async () => {
  const fixture = transaction();
  const locks = exclusiveLockManager();
  fixture.adapter.lockManager = locks;
  fixture.adapter.requireLock = true;
  const firstReached = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  const firstSettings = settings({audio: true, period: 1200});
  const secondSettings = settings({audio: false, period: 2400});

  const first = commitSettingsImport(firstSettings, fixture.adapter, {
    checkpoint: phase => {
      if (phase === 'prepared') {
        firstReached.resolve();
        return releaseFirst.promise;
      }
    },
    transactionId: 'two-options-first',
    validateRules: rules
  });
  await firstReached.promise;
  const second = commitSettingsImport(secondSettings, fixture.adapter, {
    checkpoint: phase => {
      if (phase === 'prepared') {
        secondEntered = true;
      }
    },
    transactionId: 'two-options-second',
    validateRules: rules
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondEntered, false, 'second Options context must wait outside the critical section');
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(locks.maxActive, 1);
  assert.equal(secondEntered, true);
  assert.deepEqual(fixture.state.local, {});
  assert.deepEqual(fixture.state.storage, {
    '__diagnosticJournal': fixture.original.storage.__diagnosticJournal,
    '__discardOwnership': fixture.original.storage.__discardOwnership,
    ...secondSettings
  });
});

test('lock wait aborts on deadline and an aborted callback cannot enter recovery later', async () => {
  let entered = false;
  let lateCallback;
  const locks = {
    request(name, options, callback) {
      assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
      lateCallback = callback;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
      });
    }
  };
  await assert.rejects(
    withSettingsImportLock(locks, () => {
      entered = true;
    }, {timeoutMs: 5}),
    error => error instanceof SettingsImportRecoveryError &&
      error.code === 'lock-timeout' && error.retryable === true
  );
  await assert.rejects(lateCallback({mode: 'exclusive', name: SETTINGS_IMPORT_LOCK_NAME}),
    error => error instanceof SettingsImportRecoveryError && error.code === 'lock-timeout');
  assert.equal(entered, false);
  await assert.rejects(
    withSettingsImportLock({}, () => {
      entered = true;
    }),
    error => error instanceof SettingsImportRecoveryError && error.code === 'lock-unavailable'
  );
  assert.equal(entered, false);
});

test('production storage recovery supports callback-only and Promise-only browser semantics', async t => {
  for (const semantics of ['callback', 'promise']) {
    await t.test(semantics, async () => {
      const marker = settingsImportTransactionPhase(createSettingsImportTransaction({
        afterStorage: {audio: true},
        beforeLocalStorage: {},
        beforeStorage: {audio: false},
        id: `storage-${semantics}`,
        now: () => 0
      }), SETTINGS_IMPORT_PHASES.STORAGE_WRITE_PENDING, () => 0);
      const state = {
        '__discardOwnership': {preserved: true},
        [SETTINGS_IMPORT_FENCE_KEY]: marker.fence,
        [SETTINGS_IMPORT_TRANSACTION_KEY]: marker,
        audio: true
      };
      const resultFor = query => query === null ? structuredClone(state) :
        Object.fromEntries(query.filter(key => key in state)
          .map(key => [key, structuredClone(state[key])]));
      const complete = (callback, value) => {
        if (semantics === 'callback') {
          queueMicrotask(() => callback(value));
          return undefined;
        }
        return Promise.resolve(value);
      };
      const area = {
        get(query, callback) {
          return complete(callback, resultFor(query));
        },
        remove(keys, callback) {
          for (const key of keys) {
            delete state[key];
          }
          return complete(callback);
        },
        set(values, callback) {
          Object.assign(state, structuredClone(values));
          return complete(callback);
        }
      };
      const locks = {
        request(name, options, callback) {
          assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
          assert.equal(options.mode, 'exclusive');
          return Promise.resolve(callback({mode: 'exclusive', name}));
        }
      };
      const previousChrome = globalThis.chrome;
      globalThis.chrome = {runtime: {lastError: null}};
      try {
        assert.deepEqual(await recoverSettingsImportStorage(area, {
          lockManager: locks,
          now: () => 10_000,
          requireLock: true
        }), {status: 'rolled-back'});
      }
      finally {
        globalThis.chrome = previousChrome;
      }
      assert.deepEqual(state, {
        '__discardOwnership': {preserved: true},
        audio: false
      });
    });
  }
});

test('transaction markers are exact, bounded, and malformed storage fails closed', async () => {
  const marker = createSettingsImportTransaction({
    afterStorage: {audio: true},
    beforeLocalStorage: {click: 'discard-tab'},
    beforeStorage: {audio: false},
    id: 'strict-marker',
    now: () => 1000
  });
  assert.equal(marker.phase, SETTINGS_IMPORT_PHASES.PREPARED);
  assert.equal(JSON.stringify(marker).length < MAX_SETTINGS_IMPORT_TRANSACTION_BYTES, true);

  assert.throws(() => createSettingsImportTransaction({
    afterStorage: {audio: true},
    beforeLocalStorage: {oversized: 'x'.repeat(1024 * 1024 + 1)},
    beforeStorage: {audio: false},
    id: 'oversized-marker',
    now: () => 1000
  }), error => error instanceof SettingsImportRecoveryError && error.code === 'invalid-marker');
  assert.throws(() => createSettingsImportTransaction({
    afterStorage: {'__discardOwnership': {secret: true}},
    beforeLocalStorage: {},
    beforeStorage: {},
    id: 'internal-marker',
    now: () => 1000
  }), error => error instanceof SettingsImportRecoveryError && error.code === 'invalid-marker');

  const fixture = transaction();
  fixture.state.storage[SETTINGS_IMPORT_TRANSACTION_KEY] = {
    ...marker,
    unexpected: true
  };
  const before = structuredClone(fixture.state);
  await assert.rejects(
    recoverSettingsImport(fixture.adapter),
    error => error instanceof SettingsImportRecoveryError && error.code === 'invalid-marker'
  );
  assert.deepEqual(fixture.state, before, 'malformed markers must cause zero recovery mutations');

  await assert.rejects(recoverSettingsImport({
    async readTransaction() {
      throw Error('storage unavailable');
    }
  }), error => error instanceof SettingsImportRecoveryError && error.code === 'storage-error');
});

test('a fresh incomplete transaction remains a fail-closed preference barrier', async () => {
  const marker = settingsImportTransactionPhase(createSettingsImportTransaction({
    afterStorage: {audio: true},
    beforeLocalStorage: {},
    beforeStorage: {audio: false},
    id: 'active-marker',
    now: () => 5000
  }), SETTINGS_IMPORT_PHASES.STORAGE_WRITE_PENDING, () => 5000);
  const state = {[SETTINGS_IMPORT_TRANSACTION_KEY]: marker, audio: true};
  const adapter = {
    async readTransaction() {
      return {[SETTINGS_IMPORT_TRANSACTION_KEY]: structuredClone(marker)};
    },
    async removeStorage(keys) {
      keys.forEach(key => delete state[key]);
    },
    async writeStorage(values) {
      Object.assign(state, values);
    }
  };
  await assert.rejects(recoverSettingsImport(adapter, {
    activeGrace: 2000,
    now: () => 5500,
    respectActiveGrace: true,
    storageOnly: true
  }), error => error instanceof SettingsImportRecoveryError &&
    error.code === 'transaction-active' && error.retryable === true);
  assert.deepEqual(state, {[SETTINGS_IMPORT_TRANSACTION_KEY]: marker, audio: true});
});

test('parse and validation failures happen before transaction methods can run', async () => {
  let calls = 0;
  const adapter = new Proxy({}, {
    get() {
      return async () => {
        calls += 1;
      };
    }
  });

  assert.throws(
    () => parseSettingsBackup('{broken', {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-json'
  );
  assert.throws(
    () => parseSettingsBackup(backupText(settings({audio: 'yes'})), {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-type'
  );
  await assert.rejects(
    commitSettingsImport(settings({audio: 'yes'}), adapter, {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-type'
  );
  await assert.rejects(
    commitSettingsImport(settings({whitelist: ['re:(a+)+']}), adapter, {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-rule'
  );
  assert.equal(calls, 0);
});

test('sanitized support bundle excludes URL, title, rule, marker, local, ownership, and unknown secrets', () => {
  const canary = 'SECRET-CANARY-7c2a188e';
  const text = serializeSupportBundle({
    '__discardOwnership': {'1': {title: canary, url: `https://${canary}.invalid/`}},
    audio: true,
    click: 'click.discard-tab',
    'force.hostnames': [canary],
    'lifecycle-feedback': false,
    mystery: {title: canary},
    prepends: canary,
    'trash.keys': {[`https://${canary}.invalid/`]: [1, 2]},
    'trash.whitelist-url': [canary],
    whitelist: [canary],
    'whitelist-url': [`re:${canary}`]
  }, {
    manifest: {manifest_version: 3, name: canary, version: '0.6.9.2'},
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    userAgent: `Mozilla/5.0 ${canary} Edg/151.0`
  });
  const bundle = JSON.parse(text);

  assert.equal(bundle.label, SUPPORT_BUNDLE_LABEL);
  assert.equal(bundle.version, SUPPORT_BUNDLE_VERSION);
  assert.equal(bundle.version, 2);
  assert.equal(bundle.environment.browserFamily, 'Edge');
  assert.equal(bundle.diagnostics.preferences.audio, true);
  assert.equal(bundle.diagnostics.preferences['lifecycle-feedback'], false);
  assert.deepEqual(bundle.diagnostics.omissionPolicy, SUPPORT_OMISSION_POLICY);
  assert.equal(bundle.diagnostics.journal.available, false);
  assert.equal('omittedValueCount' in bundle.diagnostics, false);
  assert.equal(bundle.extension.version, '0.6.9.2');
  assert.equal(text.includes(canary), false);
  assert.equal(/https?:\/\//i.test(text), false);
  assert.equal(/whitelist|ownership|title|prepends/i.test(text), false);
});

test('support bundle v2 includes only the strict sanitized diagnostic incident schema', () => {
  const canary = 'SECRET-CANARY-diagnostic-92f4';
  const text = serializeSupportBundle({audio: true}, {
    journal: {
      format: 'auto-tab-discard-diagnostic-journal',
      incidents: [{
        command: 'discard-window',
        durationMs: 1_500_000,
        endedAt: '2026-08-14T04:00:01.482Z',
        error: {message: canary, stack: `https://${canary}.invalid/`},
        forced: false,
        groups: [{
          code: 'TAB_FAILED',
          count: 47,
          message: canary,
          reasonCode: 'NATIVE_TIMEOUT',
          stage: 'native-discard',
          status: 'failed',
          tabId: 91
        }, {
          code: 'TAB_PROTECTED',
          count: 19,
          reasonCode: 'PROTECTION_RULE',
          stage: 'eligibility',
          status: 'skipped',
          windowId: 7
        }, {
          code: 'TAB_FAILED',
          count: 1,
          reasonCode: 'NATIVE_TIMEOUT',
          stage: 'release',
          status: 'failed'
        }],
        id: 'ATD-MABC-1',
        runtime: {
          browserFamily: 'Edge',
          extensionVersion: '0.6.9.2',
          userAgent: canary
        },
        startedAt: '2026-08-14T04:00:00.000Z',
        state: 'failed',
        summary: {failed: 47, skipped: 19, success: 0},
        title: canary,
        total: 67,
        url: `https://${canary}.invalid/`,
        windowId: 7
      }, {
        command: 'discard-window',
        durationMs: 1,
        endedAt: '2026-08-14T04:00:01.000Z',
        forced: false,
        groups: [],
        id: canary,
        runtime: {browserFamily: 'Edge', extensionVersion: '0.6.9.2'},
        startedAt: '2026-08-14T04:00:00.000Z',
        state: 'failed',
        summary: {failed: 1, skipped: 0, success: 0},
        total: 1
      }],
      updatedAt: '2026-08-14T04:00:01.482Z',
      version: 1
    },
    manifest: {manifest_version: 3, version: '0.6.9.2'},
    now: () => new Date('2026-08-14T05:00:00.000Z'),
    userAgent: 'Mozilla/5.0 Edg/152.0'
  });
  const bundle = JSON.parse(text);
  const journal = bundle.diagnostics.journal;

  assert.equal(journal.available, true);
  assert.equal(journal.format, 'auto-tab-discard-diagnostic-journal');
  assert.equal(journal.version, 1);
  assert.equal(journal.updatedAt, '2026-08-14T04:00:01.482Z');
  assert.equal(journal.incidents.length, 1, 'invalid incident identifiers must be omitted');
  assert.deepEqual(journal.incidents[0], {
    command: 'discard-window',
    durationMs: 1_500_000,
    endedAt: '2026-08-14T04:00:01.482Z',
    forced: false,
    groups: [{
      code: 'TAB_FAILED',
      count: 47,
      reasonCode: 'NATIVE_TIMEOUT',
      stage: 'native-discard',
      status: 'failed'
    }, {
      code: 'TAB_PROTECTED',
      count: 19,
      reasonCode: 'PROTECTION_RULE',
      stage: 'eligibility',
      status: 'skipped'
    }],
    id: 'ATD-MABC-1',
    runtime: {browserFamily: 'Edge', extensionVersion: '0.6.9.2'},
    startedAt: '2026-08-14T04:00:00.000Z',
    state: 'failed',
    summary: {failed: 47, skipped: 19, success: 0},
    total: 67
  });
  assert.equal(text.includes(canary), false);
  assert.equal(/https?:\/\//i.test(text), false);
  assert.equal(/"(?:url|title|message|stack|tabId|windowId|userAgent)"/.test(text), false);
});

test('support bundle rejects a diagnostic envelope with the wrong format or version', () => {
  for (const journal of [
    {format: 'foreign-journal', incidents: [], version: 1},
    {format: 'auto-tab-discard-diagnostic-journal', incidents: [], version: 2}
  ]) {
    const bundle = JSON.parse(serializeSupportBundle({}, {journal}));
    assert.deepEqual(bundle.diagnostics.journal, {
      available: false,
      format: 'auto-tab-discard-diagnostic-journal',
      incidents: [],
      version: 1
    });
  }
});
