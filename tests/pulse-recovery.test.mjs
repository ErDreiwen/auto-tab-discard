import test from 'node:test';
import assert from 'node:assert/strict';

import {createPulseRecovery, KEY} from '../v3/worker/core/pulse-recovery.mjs';

const fixture = ({activeId = 1, now = 1000} = {}) => {
  const stored = {};
  const tabs = new Map([
    [1, {id: 1, windowId: 7, active: activeId === 1, discarded: false, frozen: false}],
    [2, {id: 2, windowId: 7, active: activeId === 2, discarded: false, frozen: false}],
    [3, {id: 3, windowId: 7, active: activeId === 3, discarded: false, frozen: false}]
  ]);
  globalThis.chrome = {runtime: {lastError: null}};
  const area = {
    get(defaults, callback) {
      callback({...defaults, ...structuredClone(stored)});
    },
    remove(key, callback) {
      delete stored[key];
      callback();
    },
    set(values, callback) {
      Object.assign(stored, structuredClone(values));
      callback();
    }
  };
  const api = {
    get(id, callback) {
      callback(tabs.get(id) && {...tabs.get(id)});
    },
    query({windowId}, callback) {
      callback([...tabs.values()].filter(tab => tab.windowId === windowId && tab.active).map(tab => ({...tab})));
    },
    update(id, changes, callback) {
      updates.push({changes: {...changes}, id});
      if (changes.active) {
        for (const tab of tabs.values()) {
          if (tab.windowId === tabs.get(id).windowId) tab.active = false;
        }
        tabs.get(id).active = true;
      }
      callback({...tabs.get(id)});
    }
  };
  const updates = [];
  return {
    pulse: createPulseRecovery({area, now: () => now, tabs: api}),
    stored,
    tabs,
    updates
  };
};

test('persists versioned target and keeper phases', async () => {
  const {pulse, stored} = fixture();
  await pulse.arm({targetId: 1, keeperId: 2, windowId: 7});
  assert.equal(stored[KEY].phase, 'activating-target');
  assert.equal(stored[KEY].version, 1);
  await pulse.phase(1, 'restoring-keeper');
  assert.equal(stored[KEY].phase, 'restoring-keeper');
});

test('forced termination at either phase preserves the active target and never activates', async () => {
  for (const phase of ['activating-target', 'restoring-keeper']) {
    const {pulse, stored, tabs, updates} = fixture({activeId: 1});
    await pulse.arm({targetId: 1, keeperId: 2, windowId: 7, phase});
    const result = await pulse.recover();
    assert.equal(result.status, 'target-preserved');
    assert.equal(tabs.get(1).active, true);
    assert.equal(tabs.get(2).active, false);
    assert.deepEqual(updates, []);
    assert.equal(stored[KEY], undefined);
    assert.equal((await pulse.recover()).status, 'empty');
  }
});

test('unknown active-tab read defers until expiry and then clears without activation', async () => {
  const {pulse, stored, updates} = fixture({activeId: null, now: 100_000});
  await pulse.arm({targetId: 1, keeperId: 2, windowId: 7});
  assert.equal((await pulse.recover()).status, 'deferred');
  assert.ok(stored[KEY]);
  stored[KEY].expiresAt = 1;
  assert.equal((await pulse.recover()).status, 'expired-unsafe');
  assert.deepEqual(updates, []);
  assert.equal(stored[KEY], undefined);
});

test('user activation wins and malformed or future records expire', async () => {
  const {pulse, stored, tabs} = fixture({activeId: 3});
  await pulse.arm({targetId: 1, keeperId: 2, windowId: 7});
  assert.equal((await pulse.recover()).status, 'user-intervened');
  assert.equal(tabs.get(3).active, true);
  stored[KEY] = {version: 99, phase: 'future'};
  assert.equal((await pulse.read()), undefined);
  assert.equal(stored[KEY], undefined);
});

test('expired pulse also preserves the active target without restoring its keeper', async () => {
  const {pulse, stored, tabs, updates} = fixture({activeId: 1, now: 100_000});
  await pulse.arm({targetId: 1, keeperId: 2, windowId: 7});
  stored[KEY].expiresAt = 1;
  assert.equal((await pulse.recover()).status, 'target-preserved');
  assert.equal(tabs.get(1).active, true);
  assert.equal(tabs.get(2).active, false);
  assert.deepEqual(updates, []);
  assert.equal(stored[KEY], undefined);
});
