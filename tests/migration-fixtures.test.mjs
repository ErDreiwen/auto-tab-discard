import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const fixture = async name => JSON.parse(await readFile(
  new URL(`fixtures/migrations/${name}`, import.meta.url),
  'utf8'
));

test('supported legacy preference fixtures survive the current storage adapter', async t => {
  const fixtures = await Promise.all([
    fixture('settings-v2-0.5.0.json'),
    fixture('settings-v3-0.6.9.1.json')
  ]);
  t.after(() => delete globalThis.chrome);

  for (const [index, item] of fixtures.entries()) {
    await t.test(item.id, async () => {
      globalThis.chrome = {
        runtime: {lastError: null},
        storage: {
          managed: {
            get(defaults, callback) {
              callback({...defaults});
            }
          },
          local: {
            get(defaults, callback) {
              callback({...defaults, ...item.input});
            }
          },
          session: {
            get(defaults, callback) {
              callback({...defaults});
            }
          },
          onChanged: {addListener() {}}
        }
      };
      const {prefs, storage} = await import(`../v3/worker/core/prefs.mjs?migration=${index}`);
      const loaded = await storage(prefs);
      for (const [key, value] of Object.entries(item.expected)) {
        assert.deepEqual(loaded[key], value, `${item.id}: ${key}`);
      }
    });
  }
});

test('legacy ownership shapes reconcile through the current worker contract', async t => {
  const data = await fixture('ownership-legacy.json');
  t.after(() => delete globalThis.chrome);

  for (const [index, item] of data.cases.entries()) {
    await t.test(item.id, async () => {
      const sessionState = {
        [data.storageKey]: {[item.tab.id]: structuredClone(item.marker)}
      };
      globalThis.chrome = {
        runtime: {lastError: null},
        storage: {
          session: {
            get(defaults, callback) {
              callback({...defaults, ...sessionState});
            },
            set(values, callback) {
              Object.assign(sessionState, structuredClone(values));
              callback();
            },
            remove(key, callback) {
              delete sessionState[key];
              callback();
            }
          },
          local: {}
        },
        tabs: {
          query(options, callback) {
            callback([structuredClone(item.tab)]);
          },
          get(id, callback) {
            callback(id === item.tab.id ? structuredClone(item.tab) : undefined);
          }
        }
      };
      const {ownership} = await import(`../v3/worker/core/ownership.mjs?migration=${index}`);
      await ownership.reconcile();
      const marker = (await ownership.snapshot())[item.tab.id];
      if (item.expected === null) {
        assert.equal(marker, undefined);
      }
      else {
        for (const [key, value] of Object.entries(item.expected)) {
          assert.deepEqual(marker?.[key], value, `${item.id}: ${key}`);
        }
      }
    });
  }
});
