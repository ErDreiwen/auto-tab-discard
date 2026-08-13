import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  createHelperMetadataStore,
  KEY_PREFIX
} from '../v3/worker/core/helper-metadata.mjs';

const area = state => ({
  get(query, callback) {
    callback(query === null ? {...state} : Object.fromEntries(Object.entries(query)
      .map(([key, fallback]) => [key, Object.hasOwn(state, key) ? state[key] : fallback])));
  },
  remove(keys, callback) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete state[key];
    }
    callback();
  },
  set(values, callback) {
    Object.assign(state, values);
    callback();
  }
});

test('blank helper metadata is nonce-keyed, bounded, one-shot, and expires', async () => {
  const state = {};
  let clock = 1_000;
  let sequence = 0;
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const store = createHelperMetadataStore({
      area: () => area(state),
      nonce: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      now: () => clock,
      ttl: 100
    });
    const first = await store.put({
      favicon: 'https://secret.example/icon.png?token=private',
      title: 'private title'
    });
    assert.equal(Object.keys(state)[0], `${KEY_PREFIX}${first}`);
    assert.deepEqual(await store.take(first), {
      favicon: 'https://secret.example/icon.png?token=private',
      title: 'private title'
    });
    assert.equal(await store.take(first), undefined, 'metadata must be consumed exactly once');

    await store.put({favicon: 'javascript:alert(1)', title: 'x'.repeat(1000)});
    const second = Object.keys(state)[0].slice(KEY_PREFIX.length);
    const bounded = await store.take(second);
    assert.equal(bounded.favicon, '');
    assert.equal(bounded.title.length, 512);

    const expired = await store.put({title: 'expired secret'});
    clock += 101;
    assert.equal(await store.cleanup(), 1);
    assert.equal(state[`${KEY_PREFIX}${expired}`], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('blank helper URLs carry only a nonce and no browser opener metadata', async () => {
  const core = await readFile(new URL('../v3/worker/plugins/blank/core.mjs', import.meta.url), 'utf8');
  const page = await readFile(new URL('../v3/worker/plugins/blank/blank.js', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /URLSearchParams|openerTabId:\s*tab\.id,|\?['"`+]/);
  assert.match(core, /blank\.html#\$\{nonce\}/);
  assert.match(page, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.doesNotMatch(page, /location\.search|URLSearchParams/);
  assert.match(page, /helperMetadata\.take\(nonce\)/);
});
