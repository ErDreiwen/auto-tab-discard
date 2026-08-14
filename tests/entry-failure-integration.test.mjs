import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {runEntryCommand} from '../v3/worker/core/entry.mjs';

const menuSource = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');
const utilsSource = await readFile(new URL('../v3/worker/core/utils.mjs', import.meta.url), 'utf8');

const event = () => {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...arguments_) {
      return listeners.map(listener => listener(...arguments_));
    }
  };
};

test('context menu, toolbar, and shortcut failures share visible settled reporting with no rejection leak', async () => {
  const contextClicked = event();
  const toolbarClicked = event();
  const shortcutInvoked = event();
  const notifications = [];
  const settlements = [];
  const unhandled = [];
  const rejectionListener = reason => unhandled.push(reason);
  process.on('unhandledRejection', rejectionListener);
  try {
    const report = ({command, message}) => {
      notifications.push({command, message});
    };
    const runEntry = (command, task) => runEntryCommand(command, task, report);
    const injectedFailure = (command, tabId) => async () => {
      const error = Error(`injected ${command} native failure`);
      error.result = {
        failed: [{reason: `injected ${command} native failure`, tab: {id: tabId}}]
      };
      throw error;
    };

    // These are the three exact listener settlement shapes in worker/menu.mjs:
    // context menu deliberately detaches a fully-catching runner, while toolbar
    // and keyboard commands await the same runner.
    contextClicked.addListener(info => {
      const settlement = runEntry(info.menuItemId, injectedFailure('context-menu', 41));
      settlements.push(settlement);
      void settlement;
    });
    toolbarClicked.addListener(async () => {
      const settlement = runEntry('toolbar', injectedFailure('toolbar', 42));
      settlements.push(settlement);
      return settlement;
    });
    shortcutInvoked.addListener(async command => {
      const settlement = runEntry(command, injectedFailure('shortcut', 43));
      settlements.push(settlement);
      return settlement;
    });

    const [contextReturn] = contextClicked.emit({menuItemId: 'discard-window'});
    assert.equal(contextReturn, undefined, 'detached context-menu listener keeps the browser event return shape');
    const [toolbarResult] = await Promise.all(toolbarClicked.emit({id: 1}));
    const [shortcutResult] = await Promise.all(shortcutInvoked.emit('discard-tabs'));
    const settled = await Promise.all(settlements);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(toolbarResult.ok, false);
    assert.equal(shortcutResult.ok, false);
    assert.equal(settled.length, 3);
    assert.equal(settled.every(result => result.ok === false && result.reasons?.length === 1), true,
      'all entry points must settle through the same bounded target-reason contract');
    assert.deepEqual(notifications.map(entry => entry.command), [
      'discard-window',
      'toolbar',
      'discard-tabs'
    ]);
    assert.match(notifications[0].message, /tab 41: injected context-menu native failure/);
    assert.match(notifications[1].message, /tab 42: injected toolbar native failure/);
    assert.match(notifications[2].message, /tab 43: injected shortcut native failure/);
    assert.deepEqual(unhandled, []);
  }
  finally {
    process.off('unhandledRejection', rejectionListener);
  }
});

test('production listeners use the shared runner and its reporter uses a browser notification', () => {
  assert.match(menuSource,
    /const runEntry = \(command, task\) => runEntryCommand\(command, task,[\s\S]*?notify\(`\$\{command\}: \$\{message\}`\)/);
  assert.match(menuSource,
    /chrome\.contextMenus\.onClicked\.addListener\([\s\S]*?void runEntry\(info\.menuItemId,/);
  assert.match(menuSource,
    /chrome\.action\.onClicked\.addListener\(async tab => \{[\s\S]*?return await runEntry\('toolbar',[\s\S]*?return onClicked\(\{menuItemId\}, tab\)/);
  assert.match(menuSource,
    /chrome\.commands\.onCommand\.addListener\(async command => \{[\s\S]*?return await runEntry\(command,[\s\S]*?return handleNavigation\(command\)[\s\S]*?return onClicked\(\{/);
  assert.match(utilsSource, /const notify = e => chrome\.notifications\.create\(/);
  assert.match(utilsSource, /message: e\.message \|\| e/);
});

test('toolbar and shortcut tasks return structured partial failures to the shared reporter', async () => {
  const notifications = [];
  const report = entry => notifications.push(entry);
  const partial = tabId => ({
    failed: [{reason: 'native discard did not settle', tab: {id: tabId}}],
    succeeded: []
  });
  const onClicked = async (info, tab) => partial(tab.id);
  const handleNavigation = async () => partial(53);
  const runEntry = (command, task) => runEntryCommand(command, task, report);

  const toolbar = await runEntry('toolbar', async () => {
    return onClicked({menuItemId: 'discard-tab'}, {id: 51});
  });
  const shortcut = await runEntry('discard-tabs', async () => {
    return onClicked({menuItemId: 'discard-tabs'}, {id: 52});
  });
  const navigation = await runEntry('close', async () => {
    return handleNavigation('close');
  });

  for (const settlement of [toolbar, shortcut, navigation]) {
    assert.equal(settlement.ok, true);
    assert.equal(settlement.partial, true);
    assert.equal(settlement.reasons.length, 1);
  }
  assert.deepEqual(notifications.map(({command}) => command), [
    'toolbar',
    'discard-tabs',
    'close'
  ]);
  assert.match(notifications[0].message, /tab 51: native discard did not settle/);
  assert.match(notifications[1].message, /tab 52: native discard did not settle/);
  assert.match(notifications[2].message, /tab 53: native discard did not settle/);
});
