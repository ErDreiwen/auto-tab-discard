import test from 'node:test';
import assert from 'node:assert/strict';

import {dispatchPopup, respondAsync} from '../v3/worker/core/respond.mjs';

test('keeps the message channel open until an action completes', async () => {
  let complete;
  const task = new Promise(resolve => complete = resolve);
  const response = new Promise(resolve => {
    assert.equal(respondAsync(() => task, resolve), true);
  });

  complete('discarded');

  assert.deepEqual(await response, {
    ok: true,
    value: 'discarded'
  });
});

test('returns action failures over the still-open message channel', async () => {
  const response = new Promise(resolve => {
    respondAsync(() => Promise.reject(Error('discard failed')), resolve);
  });

  assert.deepEqual(await response, {
    ok: false,
    error: 'discard failed'
  });
});

test('waits for the popup command and passes its active tab through', async () => {
  let finish;
  const tab = {id: 42};
  const request = {cmd: 'discard-tabs', shiftKey: false};
  const query = async options => {
    assert.deepEqual(options, {active: true, currentWindow: true});
    return [tab];
  };
  const onClicked = (info, selected) => new Promise(resolve => {
    assert.equal(info.menuItemId, 'discard-tabs');
    assert.equal(selected, tab);
    finish = resolve;
  });

  const dispatched = dispatchPopup(request, query, onClicked);
  while (!finish) {
    await new Promise(resolve => setTimeout(resolve));
  }
  let settled = false;
  dispatched.then(() => settled = true);
  await Promise.resolve();
  assert.equal(settled, false);

  finish();
  assert.equal(await dispatched, true);
});

test('pins popup dispatch to the tab and window that the popup displayed', async () => {
  const tab = {id: 42, windowId: 7};
  const selected = await dispatchPopup({
    cmd: 'discard-tree',
    tabId: 42,
    windowId: 7
  }, async options => {
    assert.deepEqual(options, {active: true, windowId: 7});
    return [tab];
  }, async (info, target) => {
    assert.equal(info.menuItemId, 'discard-tree');
    assert.equal(target, tab);
  });
  assert.equal(selected, true);

  await assert.rejects(() => dispatchPopup({
    cmd: 'discard-tree',
    tabId: 42,
    windowId: 7
  }, async () => [{id: 43, windowId: 7}], async () => {}),
  /target changed/);
});
