import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {
  createDiagnosticJournal,
  diagnosticSessionStorageAdapter,
  diagnosticStorageAdapter
} from '../v3/worker/core/diagnostic-journal.mjs';
import {createHelperMetadataStore} from '../v3/worker/core/helper-metadata.mjs';

// Chromium drops object-form keys whose default is undefined, so
// get({key: undefined}) resolves to {} even when the key is stored.
const chromiumArea = () => {
  const values = {};
  const pick = keys => {
    if (keys === null || keys === undefined) return structuredClone(values);
    const list = typeof keys === 'string' ? [keys] : keys;
    if (Array.isArray(list)) {
      return Object.fromEntries(list.filter(key => Object.hasOwn(values, key))
        .map(key => [key, structuredClone(values[key])]));
    }
    return Object.fromEntries(Object.entries(list).filter(([, fallback]) => fallback !== undefined)
      .map(([key, fallback]) => [key, structuredClone(Object.hasOwn(values, key) ? values[key] : fallback)]));
  };
  return {
    values,
    get(keys, callback) {
      callback(pick(keys));
    },
    remove(keys, callback) {
      for (const key of [].concat(keys)) delete values[key];
      callback();
    },
    set(items, callback) {
      Object.assign(values, structuredClone(items));
      callback();
    }
  };
};

const sourceFiles = async directory => (await readdir(directory, {recursive: true, withFileTypes: true}))
  .filter(entry => entry.isFile() && /\.(?:m?js)$/.test(entry.name))
  .map(entry => path.join(entry.parentPath, entry.name));

test('no extension storage read passes an undefined default that Chromium drops', async () => {
  for (const file of await sourceFiles(path.resolve('v3'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\]:\s*undefined\s*\}/, `${path.relative(process.cwd(), file)} reads storage with an undefined default`);
  }
});

test('diagnostic storage adapters read stored values from Chromium storage', async () => {
  const local = chromiumArea();
  const session = chromiumArea();
  await diagnosticStorageAdapter(local).write({stored: true});
  await diagnosticSessionStorageAdapter(session).write({stored: 'session'});
  assert.deepEqual(await diagnosticStorageAdapter(local).read(), {stored: true});
  assert.deepEqual(await diagnosticSessionStorageAdapter(session).read(), {stored: 'session'});
});

test('diagnostic history survives an MV3 worker restart in the same browser session', async () => {
  const local = chromiumArea();
  const session = chromiumArea();
  const startWorker = () => createDiagnosticJournal({
    manifest: {version: '0.6.9.2'},
    sessionStore: diagnosticSessionStorageAdapter(session),
    store: diagnosticStorageAdapter(local),
    userAgent: 'Mozilla/5.0 Edg/155.0.0.0'
  });
  const startup = {
    code: 'WORKER_STARTED',
    command: 'worker-startup',
    outcome: 'STARTED',
    phase: 'startup',
    source: 'worker',
    type: 'worker-start'
  };
  await startWorker().event(startup);
  // The next worker instance must append to the same session, not wipe it.
  await startWorker().event(startup);

  const index = local.values.__diagnosticJournal;
  assert.equal(index.sessions.length, 1, 'a worker restart must not start a new browser session');
  const records = index.sessions[0].chunks.flatMap(key => local.values[key].records);
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
});

test('blank helper metadata can be read back from Chromium storage', async () => {
  const area = chromiumArea();
  const store = createHelperMetadataStore({area: () => area, nonce: () => 'helper-metadata-nonce-0001'});
  const id = await store.put({favicon: 'https://example.com/favicon.ico', title: 'Example'});
  assert.deepEqual(await store.take(id), {favicon: 'https://example.com/favicon.ico', title: 'Example'});
});
