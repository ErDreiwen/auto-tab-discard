import {number} from './modes/number.mjs';
import {storage, prefs} from './core/prefs.mjs';
import {navigate} from './core/navigate.mjs';
import {discard, inprogress} from './core/discard.mjs';
import {query, notify, match} from './core/utils.mjs';
import {starters} from './core/startup.mjs';
import {actionCommand} from './core/action.mjs';
import {isNativeGroup, tabsForGroupCommand} from './core/group.mjs';
import {runEntryCommand} from './core/entry.mjs';
import {
  filterScopeTabs,
  runDirectDiscardCommand,
  runScopedCommand
} from './core/command-scope.mjs';
import {
  createPopupProgressManager,
  POPUP_CODES,
  trackPopupTabTask as trackTabTask
} from './core/popup-progress.mjs';
import {releaseTab} from './core/release.mjs';
import {ownership} from './core/ownership.mjs';
import {SUSPENDED_POLICY_DEFAULTS} from './core/suspended-protection.mjs';
import {attachWindowScope, createWindowScope} from './core/window-scope.mjs';
import {dispatchPopup, respondAsync} from './core/respond.mjs';
import {interrupts} from './plugins/loader.mjs';

// Context Menu
{
  const onStartup = () => {
    const contexts = ['action'];
    if (chrome.contextMenus.ContextType.TAB && prefs['tab.context']) {
      contexts.push('tab');
    }
    if (prefs['page.context']) {
      contexts.push('page');
    }
    const create = arr => {
      chrome.contextMenus.removeAll(() => {
        arr.forEach(o => chrome.contextMenus.create(o));
      });
    };

    create([{
      id: 'discard-tab',
      title: chrome.i18n.getMessage('menu_discard_tab'),
      contexts
    },
    {
      id: 'discard-tree',
      title: chrome.i18n.getMessage('menu_discard_tree'),
      contexts
    },
    {
      id: 'discard-other-windows',
      title: chrome.i18n.getMessage('menu_discard_other_windows'),
      contexts
    },
    {
      id: 'discard-sub-menu',
      title: chrome.i18n.getMessage('menu_discard_menu'),
      contexts
    },
    {
      id: 'discard-tabs',
      title: chrome.i18n.getMessage('menu_discard_tabs'),
      contexts
    },
    {
      id: 'discard-window',
      title: chrome.i18n.getMessage('menu_discard_window'),
      contexts,
      parentId: 'discard-sub-menu'
    },
    {
      id: 'discard-rights',
      title: chrome.i18n.getMessage('menu_discard_rights'),
      contexts,
      parentId: 'discard-sub-menu'
    },
    {
      id: 'discard-lefts',
      title: chrome.i18n.getMessage('menu_discard_lefts'),
      contexts,
      parentId: 'discard-sub-menu'
    },
    {
      id: 'extra',
      title: chrome.i18n.getMessage('menu_extra'),
      contexts,
      documentUrlPatterns: ['*://*/*']
    },
    {
      id: 'auto-discardable',
      title: chrome.i18n.getMessage('popup_allowed'),
      contexts,
      documentUrlPatterns: ['*://*/*'],
      parentId: 'extra'
    },
    {
      id: 'whitelist-domain',
      title: chrome.i18n.getMessage('menu_whitelist_domain'),
      contexts,
      documentUrlPatterns: ['*://*/*'],
      parentId: 'extra'
    },
    prefs['link.context'] ? {
      id: 'open-tab-then-discard',
      title: chrome.i18n.getMessage('menu_open_tab_then_discard'),
      contexts: ['link', 'bookmark'].filter(a => chrome.contextMenus.ContextType[a.toUpperCase()]),
      documentUrlPatterns: ['*://*/*']
    } : null].filter(o => o));
  };
  starters.push(onStartup);

  const setStorage = (area, values) => new Promise((resolve, reject) => area.set(values, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(Error(error.message));
    }
    else {
      resolve();
    }
  }));

  const suspendedPolicy = async () => Object.assign(
    await storage(SUSPENDED_POLICY_DEFAULTS),
    number.IGNORE,
    await storage({'whitelist.session': []}, 'session')
  );

  const scopedCommands = new Set([
    'discard-tab', 'discard-tree', 'discard-tabs', 'discard-window',
    'discard-other-windows', 'discard-lefts', 'discard-rights',
    'release-tabs', 'release-window', 'release-other-windows',
    'release-lefts', 'release-rights'
  ]);
  const publishPopupProgress = snapshot => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        method: 'popup-progress-update',
        snapshot
      }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    }
    catch (error) {
      resolve();
    }
  });
  const popupProgress = createPopupProgressManager({
    publish: publishPopupProgress,
    resolveId: ownership.resolveId
  });
  const trackCheck = (progress, task) => async tabs => {
    if (!progress) {
      return task(tabs);
    }
    await progress.addTargets(tabs);
    progress.throwIfCancelled();
    const result = await task(tabs);
    await progress.mergeCheckResult(result, tabs);
    return result;
  };
  const resolveWindowScopedTab = tab => new Promise((resolve, reject) => {
    chrome.windows.get(tab.windowId, windowInfo => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(Error(error.message));
        return;
      }
      try {
        resolve(attachWindowScope(tab, createWindowScope(tab, windowInfo)));
      }
      catch (error) {
        reject(error);
      }
    });
  });

  const onClicked = async (info, tab) => {
    const {menuItemId, shiftKey, checked, progress} = info;
    const selectedTab = scopedCommands.has(menuItemId) ? await resolveWindowScopedTab(tab) : tab;
    let pluginTransaction;
    if (typeof interrupts !== 'undefined') {
      // wait for plug-in to be ready
      await interrupts['before-action']();
      // wait for plug-in manipulations
      pluginTransaction = await interrupts['before-menu-click'](info, tab);
    }
    else {
      console.warn('plugins module is not loaded');
    }
    //
    const runCommandTransaction = async task => {
      try {
        const result = await task();
        await pluginTransaction?.commit?.(result);
        return result;
      }
      catch (error) {
        try {
          await pluginTransaction?.rollback?.(error);
        }
        catch (rollbackError) {
          console.warn('plugin transaction rollback failed', rollbackError);
        }
        throw error;
      }
    };

    if (menuItemId === 'whitelist-domain' || menuItemId === 'whitelist-session') {
      return storage(prefs).then(async prefs => {
        Object.assign(prefs, await storage({
          'whitelist.session': []
        }, 'session'));

        const d = menuItemId !== 'whitelist-session';

        const {hostname, protocol = ''} = new URL(tab.url);

        let rule;
        if (protocol.startsWith('http') || protocol.startsWith('ftp')) {
          let whitelist = prefs[d ? 'whitelist' : 'whitelist.session'];

          if (shiftKey) {
            rule = 're:^' + tab.url.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '$';
          }
          else {
            rule = hostname;
          }

          if (checked === false) {
            whitelist = whitelist.filter(rule => {
              const m = match([rule], hostname, tab.url);

              if (m) {
                // https://github.com/rNeomy/auto-tab-discard/issues/350
                // notify(`"${rule}" ${chrome.i18n.getMessage(d ? 'menu_msg5' : 'menu_msg6')}`);
                return false;
              }
              else {
                return true;
              }
            });
          }
          else {
            whitelist.push(rule);

            // https://github.com/rNeomy/auto-tab-discard/issues/350
            // notify(`"${rule}" ${chrome.i18n.getMessage(d ? 'menu_msg1' : 'menu_msg4')}`);
          }
          whitelist = whitelist.filter((h, i, l) => l.indexOf(h) === i);

          const check = () => number.check([], {
            'exclude-active': false,
            'icon-update': true
          }, 'menu/1');

          if (d) {
            await setStorage(chrome.storage.local, {whitelist});
          }
          else {
            await setStorage(chrome.storage.session, {
              'whitelist.session': whitelist
            });
          }
          await check();
        }
        else {
          notify(`"${protocol}" ${chrome.i18n.getMessage('menu_msg2')}`);
        }
      });
    }
    else if (menuItemId === 'discard-tab' || menuItemId === 'discard-tree') {
      // it is possible to have multiple highlighted tabs. Let's discard all of them
      const tabs = await query({
        windowId: selectedTab.windowId,
        windowType: 'normal'
      });

      const htabs = []; // these are tabs that will be discarded
      // discard-tree for Tree Style Tab
      if (menuItemId === 'discard-tree' && info.viewType === 'sidebar') {
        htabs.push(selectedTab);
        await new Promise(resolve => chrome.runtime.sendMessage('treestyletab@piro.sakura.ne.jp', {
          type: 'get-tree',
          tab: selectedTab.id
        }, tree => {
          const add = node => {
            htabs.push(...node.children);
            node.children.filter(child => child.children).forEach(add);
          };
          add(tree);
          resolve();
        }));
      }
      // Chromium/Edge native tab groups. Group membership is the only selector:
      // highlighted tabs outside this group must never be included.
      else if (menuItemId === 'discard-tree') {
        htabs.push(...tabsForGroupCommand(tabs, selectedTab));
      }
      else {
        htabs.push(selectedTab);
      }
      await progress?.addTargets(htabs);
      const groupScope = menuItemId === 'discard-tree' && info.viewType !== 'sidebar' &&
        isNativeGroup(selectedTab) ? {
          groupId: selectedTab.groupId,
          selectedId: selectedTab.id,
          targetIds: htabs.map(target => target.id),
          windowId: selectedTab.windowId
        } : undefined;
      return runCommandTransaction(() => runDirectDiscardCommand({
        activate: keeper => ownership.withNativeMutationGuard(() =>
          chrome.tabs.update(keeper.id, {active: true}),
        keeper.id),
        allTabs: tabs,
        command: menuItemId,
        commitScope: groupScope ? async () => {
          const selected = await new Promise(resolve => chrome.tabs.get(
            ownership.resolveId(groupScope.selectedId),
            current => resolve(chrome.runtime.lastError ? undefined : current)
          ));
          if (!selected || selected.active !== true || selected.windowId !== groupScope.windowId ||
              selected.groupId !== groupScope.groupId) {
            return {valid: false, reason: 'selected tab moved or changed group before discard'};
          }
          const allTabs = await query({windowId: groupScope.windowId, windowType: 'normal'});
          const targets = tabsForGroupCommand(allTabs, selected);
          const expected = groupScope.targetIds.map(id => ownership.resolveId(id)).sort((a, b) => a - b);
          const current = targets.map(target => target.id).sort((a, b) => a - b);
          if (expected.length !== current.length || expected.some((id, index) => id !== current[index])) {
            return {valid: false, reason: 'tab-group membership changed before discard'};
          }
          return {allTabs, selected, targets, valid: true};
        } : undefined,
        discard: trackTabTask(progress, discard, POPUP_CODES.TAB_DISCARDED),
        hasBlockingNativeIntent: ownership.hasBlockingNativeIntent,
        inProgress: id => inprogress.has(id),
        notifyNoKeeper: () => notify(chrome.i18n.getMessage('menu_msg3')),
        refresh: target => new Promise(resolve => chrome.tabs.get(ownership.resolveId(target.id), current => {
          const error = chrome.runtime.lastError;
          resolve(error ? undefined : current);
        })),
        resolveFresh: ownership.resolveFresh,
        selected: selectedTab,
        shiftKey,
        suspendedPolicy,
        takeover: trackTabTask(
          progress,
          target => discard.takeover(target, {manual: true}),
          POPUP_CODES.TAB_DISCARDED
        ),
        targets: htabs,
        waitForTakeover: discard.waitForTakeover
      }));
    }
    else if (menuItemId === 'open-tab-then-discard') {
      if (/Firefox/.test(navigator.userAgent)) {
        await chrome.tabs.create({
          active: false,
          url: info.linkUrl,
          discarded: true
        });
      }
      else {
        const created = await chrome.tabs.create({
          active: false,
          url: info.linkUrl
        });
        await chrome.scripting.executeScript({
          target: {tabId: created.id},
          func: () => window.stop()
        });
        await chrome.scripting.executeScript({
          target: {tabId: created.id},
          files: ['data/lazy.js']
        });
      }
    }
    else if (menuItemId === 'auto-discardable') {
      const autoDiscardable = info.value || false; // when called from page context menu, there is no value
      await chrome.tabs.update(tab.id, {
        autoDiscardable
      });
    }
    else if (menuItemId === 'toggle-allowed') {
      await chrome.tabs.update(tab.id, {
        autoDiscardable: tab.autoDiscardable === false
      });
    }
    // discard-tabs, discard-window, discard-other-windows, discard-rights, discard-lefts
    // release-tabs, release-window, release-other-windows, release-rights, release-lefts
    else {
      let initialScopeRead = true;
      const progressQuery = async options => {
        const tabs = await query(options);
        if (progress && initialScopeRead) {
          initialScopeRead = false;
          await progress.addTargets(filterScopeTabs(menuItemId, tabs, selectedTab));
        }
        return tabs;
      };
      return runCommandTransaction(() => runScopedCommand({
        cancelTakeover: tab => discard.cancelTakeover(tab.id),
        command: menuItemId,
        selected: selectedTab,
        shiftKey,
        suspendedPolicy,
        query: progressQuery,
        discard: trackTabTask(progress, discard, POPUP_CODES.TAB_DISCARDED),
        // Make sure normal clicks only discard eligible tabs; Shift remains forced.
        check: trackCheck(progress, tabs => number.check(tabs, number.IGNORE, 'menu/2')),
        reload: trackTabTask(
          progress,
          (tab, options) => chrome.tabs.reload(ownership.resolveId(tab.id), options),
          POPUP_CODES.TAB_RELEASED
        ),
        refresh: tab => new Promise(resolve => chrome.tabs.get(ownership.resolveId(tab.id), current => {
          const error = chrome.runtime.lastError;
          resolve(error ? undefined : current);
        })),
        release: trackTabTask(progress, releaseTab, POPUP_CODES.TAB_RELEASED),
        hasBlockingNativeIntent: ownership.hasBlockingNativeIntent,
        resolveFresh: ownership.resolveFresh,
        takeoverSnapshot: discard.takeoverSnapshot,
        takeover: trackTabTask(
          progress,
          target => discard.takeover(target, {manual: true}),
          POPUP_CODES.TAB_DISCARDED
        )
      }));
    }
  };

  const handleNavigation = async method => {
    if (method !== 'close') {
      return navigate(method);
    }

    const options = await storage({
      'discard-protected-on-close': false
    });
    if (options['discard-protected-on-close'] !== true) {
      return navigate(method);
    }

    const tabs = await query({
      active: true,
      currentWindow: true
    });
    const active = tabs[0];
    if (!active) {
      return false;
    }
    const protectedTab = active.pinned === true ||
      (Number.isInteger(active.groupId) && active.groupId !== -1);
    if (!protectedTab) {
      return navigate(method);
    }

    const result = await onClicked({menuItemId: 'discard-tab'}, active);
    if (result?.blocked === true) {
      throw Error('cannot discard the protected active tab without a safe keeper');
    }
    return result;
  };

  const runEntry = (command, task) => runEntryCommand(command, task, ({command, message}) => {
    notify(`${command}: ${message}`);
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void runEntry(info.menuItemId, () => onClicked(info, tab));
  });
  chrome.action.onClicked.addListener(async tab => {
    await runEntry('toolbar', async () => {
      const menuItemId = await actionCommand(storage);
      if (menuItemId === 'popup') {
        await chrome.action.setPopup({popup: '/data/popup/index.html'});
        if (chrome.action.openPopup) {
          await chrome.action.openPopup();
        }
      }
      else {
        await onClicked({menuItemId}, tab);
      }
    });
  });
  // commands
  chrome.commands.onCommand.addListener(async command => {
    await runEntry(command, async () => {
      if (command.startsWith('move-') || command === 'close') {
        await handleNavigation(command);
      }
      else {
        const tabs = await query({
          active: true,
          currentWindow: true
        });
        if (tabs.length) {
          await onClicked({
            menuItemId: command
          }, tabs[0]);
        }
      }
    });
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.method === 'popup') {
      return respondAsync(() => scopedCommands.has(request.cmd) ? popupProgress.run(
          request,
          progress => dispatchPopup({...request, progress}, query, onClicked),
          progress => Promise.all(progress.targetIds().map(id => discard.cancelTakeover(id)))
        ) : dispatchPopup(request, query, onClicked), sendResponse);
    }
    else if (request.method === 'popup-progress-snapshot') {
      return respondAsync(() => popupProgress.snapshot(request), sendResponse);
    }
    else if (request.method === 'popup-progress-cancel') {
      return respondAsync(() => popupProgress.cancel(request.jobId), sendResponse);
    }
    else if (request.method === 'simulate') {
      return respondAsync(() => onClicked({
        menuItemId: request.cmd
      }, sender.tab), sendResponse);
    }
    else if (request.method === 'build-context') {
      return respondAsync(() => onStartup(), sendResponse);
    }
    else if (request.method === 'takeover-snapshot') {
      return respondAsync(() => discard.takeoverSnapshot(), sendResponse);
    }
    else if (request.method === 'run-check-on-action') {
      const tabs = request.ids.map(id => ({id}));
      return respondAsync(() => number.check(tabs, {
        'exclude-active': false,
        'icon-update': true
      }, 'menu/3'), sendResponse);
    }
    else if (request.method === 'close' || request.method?.startsWith('move-')) {
      return respondAsync(() => handleNavigation(request.method), sendResponse);
    }
  });
}
