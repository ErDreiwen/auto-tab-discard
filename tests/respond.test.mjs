import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeDiagnosticAccess,
  authorizeOptionsPageRequest,
  authorizePopupNavigationRequest,
  authorizePopupPageRequest,
  authorizePopupRequest,
  dispatchPopup,
  filterPopupTakeoverSnapshot,
  respondAsync,
  validatePopupTargetIds
} from '../v3/worker/core/respond.mjs';

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
    assert.deepEqual(options, {active: true, currentWindow: true, windowType: 'normal'});
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
    assert.deepEqual(options, {active: true, windowId: 7, windowType: 'normal'});
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

test('popup dispatch forwards only the worker-created diagnostic capability', async () => {
  const pageDiagnostic = {stage: () => assert.fail('page capability must not run')};
  const workerDiagnostic = {stage: async () => undefined};
  const tab = {id: 42, windowId: 7};
  await dispatchPopup({
    cmd: 'discard-tab',
    diagnostic: pageDiagnostic,
    tabId: 42,
    windowId: 7
  }, async () => [tab], async (info, selected) => {
    assert.equal(info.diagnostic, workerDiagnostic);
    assert.notEqual(info.diagnostic, pageDiagnostic);
    assert.equal(selected, tab);
  }, workerDiagnostic);
});

test('popup page authorization rejects non-popup senders and preserves worker-owned privacy', async () => {
  const options = {
    expectedExtensionId: 'extension-id',
    expectedPopupUrl: 'chrome-extension://extension-id/data/popup/index.html',
    query: async () => [{id: 42, incognito: true, windowId: 7}]
  };
  await assert.rejects(() => authorizePopupPageRequest({
    method: 'move-next',
    tabId: 42,
    windowId: 7
  }, {
    id: 'extension-id',
    url: 'https://example.invalid/'
  }, options), /sender is not authorized/);
  const authorized = await authorizePopupPageRequest({
    incognito: false,
    tabId: 42,
    windowId: 7
  }, {
    id: 'extension-id',
    url: options.expectedPopupUrl
  }, options);
  assert.equal(authorized.tab.incognito, true);
  assert.equal(authorized.request.incognito, true,
    'the request privacy bit is replaced by the browser-owned active tab');
});

test('popup navigation requires an exact sender and pinned active target', async () => {
  const expectedExtensionId = 'extension-id';
  const expectedPopupUrl = 'chrome-extension://extension-id/data/popup/index.html';
  const options = {
    expectedExtensionId,
    expectedPopupUrl,
    query: async queryOptions => {
      assert.deepEqual(queryOptions, {active: true, windowId: 7, windowType: 'normal'});
      return [{id: 42, incognito: true, windowId: 7}];
    }
  };
  const request = {method: 'move-next', tabId: 42, windowId: 7};
  await assert.rejects(() => authorizePopupNavigationRequest(request, {
    id: expectedExtensionId,
    url: 'chrome-extension://extension-id/data/options/index.html'
  }, options), /sender is not authorized/);
  assert.throws(() => authorizePopupNavigationRequest({method: 'move-next'}, {
    id: expectedExtensionId,
    url: expectedPopupUrl
  }, options), /navigation context is incomplete/);
  const authorized = await authorizePopupNavigationRequest(request, {
    id: expectedExtensionId,
    url: expectedPopupUrl
  }, options);
  assert.equal(authorized.tab.incognito, true);
  assert.equal(authorized.request.tabId, 42);
  assert.equal(authorized.request.windowId, 7);
});

test('Options authorization rejects popup reset authority and uses browser-owned privacy', () => {
  const expectedExtensionId = 'extension-id';
  const expectedOptionsUrl = 'chrome-extension://extension-id/data/options/index.html';
  const options = {expectedExtensionId, expectedOptionsUrl};
  assert.throws(() => authorizeOptionsPageRequest({
    id: expectedExtensionId,
    tab: {incognito: false},
    url: 'chrome-extension://extension-id/data/popup/index.html'
  }, options), /Options sender is not authorized/);
  assert.deepEqual(authorizeOptionsPageRequest({
    id: expectedExtensionId,
    tab: {incognito: false},
    url: expectedOptionsUrl
  }, options), {
    clearDurable: true,
    clearPrivate: false,
    includeDurable: true,
    includePrivate: false
  });
  assert.deepEqual(authorizeOptionsPageRequest({
    id: expectedExtensionId,
    tab: {incognito: true},
    url: expectedOptionsUrl
  }, options), {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  });
  assert.throws(() => authorizeOptionsPageRequest({
    id: expectedExtensionId,
    url: expectedOptionsUrl
  }, options), /Options context is incomplete/);
});

test('popup target IDs must remain unique and inside the live authorized scope', () => {
  const tabs = [
    {id: 4, incognito: false, windowId: 7},
    {id: 5, incognito: false, windowId: 7}
  ];
  assert.deepEqual(validatePopupTargetIds([5, 4], tabs), [tabs[1], tabs[0]]);
  assert.throws(() => validatePopupTargetIds([4, 4], tabs), /scope changed/);
  assert.throws(() => validatePopupTargetIds([4, 6], tabs), /scope changed/);
  assert.throws(() => validatePopupTargetIds([], tabs), /scope is invalid/);
});

test('worker authorization overrides a spoofed spanning-incognito bit', async () => {
  const {request, tab} = await authorizePopupRequest({
    cmd: 'discard-window',
    incognito: false,
    tabId: 91,
    windowId: 12
  }, async options => {
    assert.deepEqual(options, {active: true, windowId: 12, windowType: 'normal'});
    return [{id: 91, incognito: true, windowId: 12}];
  });

  assert.equal(tab.incognito, true);
  assert.equal(request.incognito, true);
  assert.equal(request.tabId, 91);
  assert.equal(request.windowId, 12);
});

test('diagnostic access is partitioned by an exact worker-authorized popup context', async () => {
  const expectedExtensionId = 'extension-id';
  const expectedOptionsUrl = 'chrome-extension://extension-id/data/options/index.html';
  const expectedPopupUrl = 'chrome-extension://extension-id/data/popup/index.html';
  let queries = 0;
  const access = (request, sender, incognito = false) => authorizeDiagnosticAccess(
    request,
    sender,
    {
      expectedExtensionId,
      expectedOptionsUrl,
      expectedPopupUrl,
      query: async options => {
        queries += 1;
        assert.deepEqual(options, {active: true, windowId: 12, windowType: 'normal'});
        return [{id: 91, incognito, windowId: 12}];
      },
      resolveWindowScopedTab: async tab => ({...tab, windowType: 'normal'})
    }
  );
  const popup = {id: expectedExtensionId, url: expectedPopupUrl};
  const regularOptions = {
    id: expectedExtensionId,
    tab: {incognito: false},
    url: expectedOptionsUrl
  };
  const privateOptions = {
    id: expectedExtensionId,
    tab: {incognito: true},
    url: expectedOptionsUrl
  };

  assert.deepEqual(await access({tabId: 91, windowId: 12}, popup), {
    clearDurable: true,
    clearPrivate: false,
    includeDurable: true,
    includePrivate: false
  });
  assert.deepEqual(await access({tabId: 91, windowId: 12}, popup, true), {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  });
  assert.equal(queries, 2);

  assert.deepEqual(await access({}, regularOptions), {
    clearDurable: true,
    clearPrivate: false,
    includeDurable: true,
    includePrivate: false
  });
  assert.deepEqual(await access({}, privateOptions), {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  });
  await assert.rejects(() => access({}, {
    id: expectedExtensionId,
    url: expectedOptionsUrl
  }), /Options context is incomplete/);
  await assert.rejects(() => access({tabId: 91, windowId: 12}, {
    id: expectedExtensionId,
    url: 'https://example.invalid/data/popup/index.html'
  }), /sender is not authorized/,
  'a matching pathname outside the extension is not a diagnostic authority');
  assert.equal(queries, 2);
  await assert.rejects(() => access({}, popup), /context is incomplete/,
    'an authentic spanning popup without tab identity must not fall back across privacy contexts');
});

test('diagnostic popup authorization has a hard deadline', async () => {
  await assert.rejects(() => authorizeDiagnosticAccess({tabId: 91, windowId: 12}, {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/data/popup/index.html'
  }, {
    expectedExtensionId: 'extension-id',
    expectedPopupUrl: 'chrome-extension://extension-id/data/popup/index.html',
    query: () => new Promise(() => {}),
    resolveWindowScopedTab: async tab => tab,
    timeoutMs: 10
  }), /authorization timed out/);
});

test('worker snapshot projection never returns opposite-private or incomplete jobs', () => {
  const selected = {id: 91, incognito: true, windowId: 12, windowType: 'normal'};
  const visible = {id: 1, tab: {id: 1, incognito: true, windowId: 14, windowType: 'normal'}};
  const opposite = {id: 2, tab: {id: 2, incognito: false, windowId: 15, windowType: 'normal'}};
  const incomplete = {id: 3, tab: {id: 3, incognito: true, windowId: 16}};
  const popupValue = filterPopupTakeoverSnapshot([visible, opposite, incomplete], selected);

  assert.deepEqual(popupValue, [visible]);
  assert.doesNotMatch(JSON.stringify(popupValue), /"id":2|"id":3|"windowId":15|"windowId":16/);
});
