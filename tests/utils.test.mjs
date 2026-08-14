import test from 'node:test';
import assert from 'node:assert/strict';

test('tab query rejects runtime errors instead of returning false empty success', async () => {
  globalThis.chrome = {
    runtime: {lastError: null},
    notifications: {create() {}},
    storage: {
      managed: {get(defaults, callback) { callback(defaults); }},
      local: {get(defaults, callback) { callback(defaults); }},
      session: {get(defaults, callback) { callback(defaults); }},
      onChanged: {addListener() {}}
    },
    tabs: {
      query(options, callback) {
        chrome.runtime.lastError = {message: `query denied for ${JSON.stringify(options)}`};
        callback();
        chrome.runtime.lastError = null;
      }
    }
  };

  try {
    const {match, query} = await import('../v3/worker/core/utils.mjs');
    await assert.rejects(query({active: false}), /query denied/);
    chrome.tabs.query = (options, callback) => callback(undefined, {
      code: 'QUERY_DENIED_BY_COMPATIBILITY',
      message: 'compatibility query denied'
    });
    await assert.rejects(query({active: false}), error =>
      error.code === 'QUERY_DENIED_BY_COMPATIBILITY' &&
      /compatibility query denied/.test(error.message));
    chrome.tabs.query = (options, callback) => callback({not: 'an array'});
    await assert.rejects(query({active: false}), /malformed tab data/);
    assert.equal(match(['plain.example'], 'plain.example', 'https://plain.example/'), true);
    assert.equal(match(['re:^https://safe\\.example/'], 'other.example',
      'https://safe.example/one'), true);
    const rejected = match(['re:(a+)+$'], 'other.example', 'https://other.example/');
    assert.equal(rejected.rejected, true);
    assert.notEqual(rejected, true,
      'URL-based allow lists must fail closed when callers require exact true');
  }
  finally {
    delete globalThis.chrome;
  }
});
