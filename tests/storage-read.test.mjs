import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIREFOX_MANAGED_MANIFEST_MISSING,
  readManagedStorageArea,
  readStorageArea
} from '../v3/worker/core/storage-read.mjs';

test('policy storage reads reject every browser failure channel instead of returning defaults', async t => {
  await t.test('missing API', async () => {
    await assert.rejects(readStorageArea(undefined, {pinned: true}), /unavailable/);
    await assert.rejects(readStorageArea({}, {pinned: true}), /unavailable/);
  });

  await t.test('runtime.lastError', async () => {
    globalThis.chrome = {runtime: {lastError: {message: 'runtime storage failure'}}};
    try {
      await assert.rejects(readStorageArea({
        get(query, callback) {
          callback({pinned: true});
        }
      }, {pinned: false}), /runtime storage failure/);
    }
    finally {
      delete globalThis.chrome;
    }
  });

  await t.test('callback compatibility error', async () => {
    await assert.rejects(readStorageArea({
      get(query, callback) {
        callback({pinned: true}, Error('callback storage failure'));
      }
    }, {pinned: false}), /callback storage failure/);
  });

  await t.test('Promise rejection', async () => {
    await assert.rejects(readStorageArea({
      get() {
        return Promise.reject(Error('promise storage failure'));
      }
    }, {pinned: false}), /promise storage failure/);
  });

  await t.test('bounded non-settlement', async () => {
    const started = Date.now();
    await assert.rejects(readStorageArea({
      get() {}
    }, {pinned: false}, {timeoutMs: 10}), /timed out/);
    assert.ok(Date.now() - started < 500, 'hung policy storage read was not bounded');
  });
});

test('successful empty managed storage remains distinct from a failed read', async () => {
  assert.deepEqual(await readStorageArea({
    get(query, callback) {
      callback({});
    }
  }, ['pinned']), {});
});

test('only Firefox exact missing managed manifest is an empty policy layer', async () => {
  const missing = {
    get(query, callback) {
      callback(undefined, Error(FIREFOX_MANAGED_MANIFEST_MISSING));
    }
  };
  assert.deepEqual(await readManagedStorageArea(missing, ['pinned'], {firefox: true}), {});
  await assert.rejects(
    readManagedStorageArea(missing, ['pinned'], {firefox: false}),
    /Managed storage manifest not found/
  );
  await assert.rejects(readManagedStorageArea({
    get(query, callback) {
      callback(undefined, Error('managed policy backend failed'));
    }
  }, ['pinned'], {firefox: true}), /managed policy backend failed/);
});

test('preference layering rejects unknown managed and local policy state', async t => {
  const local = {
    get(query, callback) {
      callback(Array.isArray(query) ? {} : {...query});
    }
  };
  const managed = {
    get(query, callback) {
      callback({});
    }
  };
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local,
      managed,
      session: local,
      onChanged: {addListener() {}}
    }
  };
  t.after(() => delete globalThis.chrome);

  const {storage} = await import(`../v3/worker/core/prefs.mjs?fail-closed=${Date.now()}`);
  assert.deepEqual(await storage({pinned: false}), {pinned: false});

  globalThis.chrome.storage.managed = {
    get(query, callback) {
      callback({}, Error('managed layer unavailable'));
    }
  };
  await assert.rejects(storage({pinned: false}), /managed layer unavailable/);

  globalThis.chrome.storage.managed = managed;
  globalThis.chrome.storage.local = {
    get() {
      return Promise.reject(Error('local layer unavailable'));
    }
  };
  await assert.rejects(storage({pinned: false}), /local layer unavailable/);
});
