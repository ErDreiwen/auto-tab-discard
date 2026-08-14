import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  flattenTreeStyleTabResponse,
  requestTreeStyleTab,
  resolveTreeStyleTabTargets,
  TREE_STYLE_TAB_ID
} from '../v3/worker/core/tree-style-tab.mjs';

const menuSource = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');

const tabs = [
  {id: 1, title: 'root', windowId: 10},
  {id: 2, title: 'child', windowId: 10},
  {id: 3, title: 'descendant', windowId: 10}
];

test('Tree Style Tab response is recursively validated and deduplicated against live scope', () => {
  const tree = {
    children: [{
      children: [{children: [], id: 3}],
      id: 2
    }, {
      children: [],
      id: 3
    }],
    id: 1
  };
  const result = flattenTreeStyleTabResponse(tree, tabs, tabs[0]);
  assert.deepEqual(result.map(tab => tab.id), [1, 2, 3]);
  assert.equal(result[1], tabs[1], 'external response objects must not become command targets');
});

test('Tree Style Tab response fails closed for malformed, cyclic, or out-of-scope nodes', () => {
  assert.throws(() => flattenTreeStyleTabResponse({children: {}, id: 1}, tabs, tabs[0]),
    /malformed child/);
  assert.throws(() => flattenTreeStyleTabResponse({
    children: [{children: [], id: 99}],
    id: 1
  }, tabs, tabs[0]), /outside the current window/);
  const cyclic = {children: [], id: 1};
  cyclic.children.push(cyclic);
  assert.throws(() => flattenTreeStyleTabResponse(cyclic, tabs, tabs[0]), /cyclic tree/);
  assert.throws(() => flattenTreeStyleTabResponse({children: [], id: 2}, tabs, tabs[0]),
    /invalid root/);
});

test('Tree Style Tab request supports callbacks and validates the external request envelope', async () => {
  const calls = [];
  const runtime = {
    lastError: undefined,
    sendMessage(extensionId, request, callback) {
      calls.push({extensionId, request});
      queueMicrotask(() => callback({children: [], id: 1}));
    }
  };
  assert.deepEqual(await requestTreeStyleTab(runtime, 1), {children: [], id: 1});
  assert.deepEqual(calls, [{
    extensionId: TREE_STYLE_TAB_ID,
    request: {tab: 1, type: 'get-tree'}
  }]);
});

test('Tree Style Tab request always settles on runtime error, Promise rejection, throw, and timeout', async () => {
  const callbackRuntime = {
    lastError: undefined,
    sendMessage(extensionId, request, callback) {
      callbackRuntime.lastError = {code: 'NO_RECEIVER', message: 'receiver unavailable'};
      callback(undefined);
      callbackRuntime.lastError = undefined;
    }
  };
  await assert.rejects(requestTreeStyleTab(callbackRuntime, 1), error =>
    error.code === 'NO_RECEIVER' && /receiver unavailable/.test(error.message));
  await assert.rejects(requestTreeStyleTab({
    sendMessage() {
      return Promise.reject(Error('external rejection'));
    }
  }, 1), /external rejection/);
  await assert.rejects(requestTreeStyleTab({
    sendMessage() {
      throw Error('external throw');
    }
  }, 1), /external throw/);
  await assert.rejects(requestTreeStyleTab({sendMessage() {}}, 1, {timeoutMs: 5}), error =>
    error.code === 'TREE_STYLE_TAB_TIMEOUT');
});

test('Tree Style Tab resolver returns only validated live tab records', async () => {
  const runtime = {
    sendMessage(extensionId, request) {
      assert.equal(extensionId, TREE_STYLE_TAB_ID);
      assert.deepEqual(request, {tab: 1, type: 'get-tree'});
      return Promise.resolve({
        children: [{children: [], id: 2}],
        id: 1
      });
    }
  };
  const result = await resolveTreeStyleTabTargets({
    runtime,
    selectedTab: tabs[0],
    tabs,
    timeoutMs: 20
  });
  assert.deepEqual(result, tabs.slice(0, 2));
});

test('sidebar discard production path delegates only to the bounded validator', () => {
  assert.match(menuSource,
    /import \{resolveTreeStyleTabTargets\} from '\.\/core\/tree-style-tab\.mjs'/);
  assert.match(menuSource,
    /info\.viewType === 'sidebar'[\s\S]*?resolveTreeStyleTabTargets\(\{[\s\S]*?selectedTab,[\s\S]*?tabs/);
  assert.doesNotMatch(menuSource,
    /sendMessage\('treestyletab@piro\.sakura\.ne\.jp'/);
});
