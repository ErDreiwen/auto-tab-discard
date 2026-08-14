import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_DUMMY_PLUGIN_KEY,
  LEGACY_PLUGIN_PREFERENCE_KEYS,
  overlayPreferenceLayers,
  planLocalPreferenceMigration
} from '../v3/worker/core/preference-migrations.mjs';
import {
  PLUGIN_IDS,
  PLUGIN_POLICY_ALIASES
} from '../v3/worker/core/plugin-catalog.mjs';
import {createPluginPreferenceGate} from '../v3/worker/core/plugin-preferences.mjs';
import {
  createSettingsImportTransaction,
  SETTINGS_IMPORT_FENCE_KEY,
  SETTINGS_IMPORT_PHASES,
  SETTINGS_IMPORT_TRANSACTION_KEY,
  settingsImportTransactionPhase,
  withSettingsImportLock
} from '../v3/worker/core/settings-import-transaction.mjs';

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve));
  }
  assert.fail('timed out waiting for preference refresh');
};

test('preference layers canonicalize legacy click values and overlay managed values last', () => {
  const effective = overlayPreferenceLayers({
    click: 'click.popup',
    pinned: false
  }, {
    click: 'click.discard',
    pinned: true,
    [LEGACY_DUMMY_PLUGIN_KEY]: true
  }, {
    pinned: false
  });

  assert.deepEqual(effective, {
    click: 'click.discard-tab',
    pinned: false
  });
});

test('managed legacy aliases enable and disable canonical plug-ins with managed precedence', () => {
  const effective = overlayPreferenceLayers({
    [PLUGIN_IDS.trash]: false,
    [PLUGIN_IDS.next]: false
  }, {
    [PLUGIN_IDS.trash]: true,
    [PLUGIN_IDS.next]: false
  }, {
    'trash.enabled': false,
    'release-next-tab': true
  });

  assert.deepEqual(effective, {
    [PLUGIN_IDS.trash]: false,
    [PLUGIN_IDS.next]: true
  });
  for (const alias of Object.keys(PLUGIN_POLICY_ALIASES)) {
    assert.equal(alias in effective, false, `${alias} must not survive as an inert setting`);
  }

  const calls = {trash: [], next: []};
  const plugin = callsForPlugin => ({
    disable: () => callsForPlugin.push('disable'),
    enable: () => callsForPlugin.push('enable')
  });
  const gate = createPluginPreferenceGate({
    [PLUGIN_IDS.trash]: plugin(calls.trash),
    [PLUGIN_IDS.next]: plugin(calls.next)
  });
  gate.applyChange(PLUGIN_IDS.trash, effective[PLUGIN_IDS.trash]);
  gate.applyChange(PLUGIN_IDS.next, effective[PLUGIN_IDS.next]);

  assert.deepEqual(calls, {trash: ['disable'], next: ['enable']});
});

test('local aliases migrate without overwriting canonical values or promoting invalid data', () => {
  const plan = planLocalPreferenceMigration({
    [PLUGIN_IDS.trash]: false,
    'trash.enabled': true,
    'release-next-tab': true,
    [LEGACY_DUMMY_PLUGIN_KEY]: true
  });

  assert.deepEqual(plan.set, {[PLUGIN_IDS.next]: true});
  assert.deepEqual(new Set(plan.remove), new Set([
    ...LEGACY_PLUGIN_PREFERENCE_KEYS,
    LEGACY_DUMMY_PLUGIN_KEY
  ]));

  const invalid = planLocalPreferenceMigration({'trash.enabled': 'true'});
  assert.deepEqual(invalid.set, {});
  assert.deepEqual(invalid.remove, ['trash.enabled']);
});

test('worker preference reads recover stale imports before exposing the local layer', async () => {
  const beforeStorage = {audio: false, pinned: true};
  const afterStorage = {audio: true, pinned: false};
  const marker = settingsImportTransactionPhase(createSettingsImportTransaction({
    afterStorage,
    beforeLocalStorage: {click: 'discard-tab'},
    beforeStorage,
    id: 'worker-preference-recovery',
    now: () => 0
  }), SETTINGS_IMPORT_PHASES.STORAGE_REMOVE_PENDING, () => 0);
  const state = {
    local: {
      '__discardOwnership': {records: {9: {state: 'owned'}}, version: 4},
      ...afterStorage,
      [SETTINGS_IMPORT_FENCE_KEY]: marker.fence,
      [SETTINGS_IMPORT_TRANSACTION_KEY]: marker
    },
    managed: {}
  };
  let changedListener;
  const area = name => ({
    get(query, callback) {
      const source = state[name];
      if (query === null) {
        callback(structuredClone(source));
      }
      else if (Array.isArray(query)) {
        callback(Object.fromEntries(query.filter(key => key in source)
          .map(key => [key, structuredClone(source[key])])));
      }
      else {
        callback({...query, ...Object.fromEntries(Object.keys(query)
          .filter(key => key in source)
          .map(key => [key, structuredClone(source[key])]))});
      }
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state[name][key];
      }
      callback();
    },
    set(values, callback) {
      Object.assign(state[name], structuredClone(values));
      callback();
    }
  });
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area('local'),
      managed: area('managed'),
      session: area('local'),
      onChanged: {
        addListener(listener) {
          changedListener = listener;
        }
      }
    }
  };

  try {
    const {storage} = await import(`../v3/worker/core/prefs.mjs?recovery=${Date.now()}`);
    const effective = await storage({audio: false, pinned: false});
    assert.deepEqual(effective, beforeStorage);
    assert.equal(SETTINGS_IMPORT_TRANSACTION_KEY in state.local, false);
    assert.equal(SETTINGS_IMPORT_FENCE_KEY in state.local, false);
    assert.deepEqual(state.local.__discardOwnership,
      {records: {9: {state: 'owned'}}, version: 4}, 'internal state must survive recovery');
    assert.equal(typeof changedListener, 'function');
  }
  finally {
    delete globalThis.chrome;
  }
});

test('worker holds the import lock through the authoritative preference read', async () => {
  const state = {local: {audio: false}, managed: {}};
  const area = name => ({
    get(query, callback) {
      const source = state[name];
      const value = query === null ? structuredClone(source) : Array.isArray(query) ?
        Object.fromEntries(query.filter(key => key in source).map(key => [key, source[key]])) :
        {...query, ...Object.fromEntries(Object.keys(query).filter(key => key in source)
          .map(key => [key, source[key]]))};
      callback(structuredClone(value));
    },
    remove(keys, callback) {
      for (const key of keys) {
        delete state[name][key];
      }
      callback();
    },
    set(values, callback) {
      Object.assign(state[name], structuredClone(values));
      callback();
    }
  });
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area('local'),
      managed: area('managed'),
      session: area('local'),
      onChanged: {addListener() {}}
    }
  };
  let release;
  let entered;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const acquired = new Promise(resolve => {
    entered = resolve;
  });

  try {
    const {storage} = await import(`../v3/worker/core/prefs.mjs?locked-read=${Date.now()}`);
    const partialWriter = withSettingsImportLock(navigator.locks, async () => {
      state.local.audio = true;
      entered();
      await held;
      state.local.audio = false;
    });
    await acquired;
    let settled = false;
    const read = storage({audio: false}).then(value => {
      settled = true;
      return value;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the partial after-image must remain invisible while import owns lock');
    release();
    await partialWriter;
    assert.deepEqual(await read, {audio: false});
  }
  finally {
    delete globalThis.chrome;
  }
});

test('cold managed policy reads do not hold the settings-import lock', async () => {
  const state = {local: {audio: false}, managed: {}};
  let managedCallback;
  const local = {
    get(query, callback) {
      const source = state.local;
      const value = query === null ? structuredClone(source) : Array.isArray(query) ?
        Object.fromEntries(query.filter(key => key in source).map(key => [key, source[key]])) :
        {...query, ...Object.fromEntries(Object.keys(query).filter(key => key in source)
          .map(key => [key, source[key]]))};
      callback(structuredClone(value));
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state.local[key];
      }
      callback();
    },
    set(values, callback) {
      Object.assign(state.local, structuredClone(values));
      callback();
    }
  };
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local,
      managed: {
        get(query, callback) {
          assert.ok(Array.isArray(query));
          managedCallback = callback;
        }
      },
      session: local,
      onChanged: {addListener() {}}
    }
  };
  let releaseWriter;
  let writerEntered;
  const writerHeld = new Promise(resolve => {
    releaseWriter = resolve;
  });
  const writerAcquired = new Promise(resolve => {
    writerEntered = resolve;
  });

  try {
    const {storage} = await import(`../v3/worker/core/prefs.mjs?cold-managed=${Date.now()}`);
    let readSettled = false;
    const read = storage({audio: false}).then(value => {
      readSettled = true;
      return value;
    });
    await waitFor(() => typeof managedCallback === 'function');

    const writer = withSettingsImportLock(navigator.locks, async () => {
      state.local.audio = true;
      writerEntered();
      await writerHeld;
      state.local.audio = false;
    });
    await writerAcquired;
    assert.equal(readSettled, false,
      'managed policy is still pending while another import-lock owner can enter');

    managedCallback({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readSettled, false,
      'the final local snapshot must wait for the active import owner');
    releaseWriter();
    await writer;
    assert.deepEqual(await read, {audio: false});
  }
  finally {
    delete globalThis.chrome;
  }
});

test('worker policy wins local writes and policy removal restores the local value', async () => {
  const state = {
    local: {
      click: 'click.discard',
      pinned: true,
      [PLUGIN_IDS.trash]: false,
      'trash.enabled': true,
      'release-next-tab': true,
      [LEGACY_DUMMY_PLUGIN_KEY]: true
    },
    managed: {
      pinned: false,
      'trash.enabled': true,
      'release-next-tab': false
    }
  };
  const reads = {local: [], managed: []};
  const mutations = [];
  let changedListener;
  const area = name => ({
    get(query, callback) {
      reads[name].push(query);
      const source = state[name];
      if (Array.isArray(query)) {
        callback(Object.fromEntries(query.filter(key => key in source).map(key => [key, source[key]])));
      }
      else {
        callback({...query, ...Object.fromEntries(
          Object.keys(query).filter(key => key in source).map(key => [key, source[key]])
        )});
      }
    },
    remove(keys, callback) {
      mutations.push({method: 'remove', keys: [...(Array.isArray(keys) ? keys : [keys])]});
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state[name][key];
      }
      callback();
    },
    set(values, callback) {
      mutations.push({method: 'set', values: {...values}});
      Object.assign(state[name], values);
      callback();
    }
  });

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area('local'),
      managed: area('managed'),
      session: area('local'),
      onChanged: {
        addListener(listener) {
          changedListener = listener;
        }
      }
    }
  };

  try {
    const {prefs, storage} = await import(`../v3/worker/core/prefs.mjs?managed=${Date.now()}`);
    const effective = await storage({
      click: 'click.popup',
      pinned: false,
      [PLUGIN_IDS.trash]: false,
      [PLUGIN_IDS.next]: false
    });

    assert.deepEqual(effective, {
      click: 'click.discard-tab',
      pinned: false,
      [PLUGIN_IDS.trash]: true,
      [PLUGIN_IDS.next]: false
    });
    assert.equal(state.local.click, 'click.discard-tab', 'legacy click is persisted canonically');
    assert.equal(state.local[PLUGIN_IDS.trash], false,
      'legacy local alias cannot overwrite an existing canonical value');
    assert.equal(state.local[PLUGIN_IDS.next], true, 'legacy local alias is persisted canonically');
    assert.equal('trash.enabled' in state.local, false);
    assert.equal('release-next-tab' in state.local, false);
    assert.equal(LEGACY_DUMMY_PLUGIN_KEY in state.local, false, 'inert plugin key is removed');
    assert.deepEqual(mutations.map(mutation => mutation.method), ['set', 'remove'],
      'canonical values must be persisted before legacy aliases are removed');
    assert.ok(reads.managed.every(Array.isArray), 'managed reads must never receive local defaults');
    assert.ok(reads.managed.some(query => query.includes('trash.enabled') &&
      query.includes('release-next-tab')), 'managed reads must include legacy policy aliases');
    assert.ok(reads.local.some(query => !Array.isArray(query)), 'local defaults are read separately');

    let notifications = 0;
    storage.on('pinned', () => notifications += 1);

    // A user save can update the shadowed local value, but not the effective
    // policy-controlled value.
    state.local.pinned = false;
    changedListener({pinned: {oldValue: true, newValue: false}}, 'local');
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(prefs.pinned, false);
    assert.equal(notifications, 0);

    state.local.pinned = true;
    changedListener({pinned: {oldValue: false, newValue: true}}, 'local');
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(prefs.pinned, false, 'managed false still wins local true');
    assert.equal(notifications, 0);

    delete state.managed.pinned;
    changedListener({pinned: {oldValue: false}}, 'managed');
    await waitFor(() => prefs.pinned === true);
    assert.equal(notifications, 1, 'removing policy reveals and publishes the local value');
  }
  finally {
    delete globalThis.chrome;
  }
});

test('one bulk storage change performs one authoritative preference refresh', async () => {
  const state = {
    local: {audio: false, pinned: false},
    managed: {}
  };
  const reads = {local: [], managed: []};
  let changedListener;
  const area = name => ({
    get(query, callback) {
      reads[name].push(query);
      const source = state[name];
      if (query === null) {
        callback(structuredClone(source));
      }
      else if (Array.isArray(query)) {
        callback(Object.fromEntries(query.filter(key => key in source)
          .map(key => [key, source[key]])));
      }
      else {
        callback({...query, ...Object.fromEntries(Object.keys(query)
          .filter(key => key in source).map(key => [key, source[key]]))});
      }
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state[name][key];
      }
      callback();
    },
    set(values, callback) {
      Object.assign(state[name], structuredClone(values));
      callback();
    }
  });
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area('local'),
      managed: area('managed'),
      session: area('local'),
      onChanged: {
        addListener(listener) {
          changedListener = listener;
        }
      }
    }
  };

  try {
    const {prefs, storage} = await import(`../v3/worker/core/prefs.mjs?bulk=${Date.now()}`);
    await storage({audio: true, pinned: false});
    storage.on('audio', () => {});
    storage.on('pinned', () => {});
    reads.local.length = 0;
    reads.managed.length = 0;

    Object.assign(state.local, {audio: true, pinned: true});
    changedListener({
      audio: {newValue: true, oldValue: false},
      pinned: {newValue: true, oldValue: false}
    }, 'local');
    await waitFor(() => prefs.audio === true && prefs.pinned === true);

    const localPreferenceReads = reads.local.filter(query =>
      query !== null && !Array.isArray(query)
    );
    assert.equal(localPreferenceReads.length, 1,
      'one change event must use one authoritative local-layer read');
    assert.equal(reads.managed.length, 1,
      'one change event must use one authoritative managed-layer read');
    assert.deepEqual(new Set(Object.keys(localPreferenceReads[0])), new Set(['audio', 'pinned']));
  }
  finally {
    delete globalThis.chrome;
  }
});
