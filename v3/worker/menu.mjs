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
import {diagnosticJournal} from './core/diagnostic-journal.mjs';
import {
  cancelPopupProgressWithDiagnostics,
  createActionDiagnostics,
  createDiagnosticCapabilityCache,
  projectActionEvent,
  runConflictScanEndpoint,
  terminalDiagnosticResponse
} from './core/action-diagnostics.mjs';
import {
  callApi as callConflictApi,
  createConflictScanner,
  SIGNALS as CONFLICT_SIGNALS
} from './core/conflict-scan.mjs';
import {FAILURE_CAUSES, safeFailureCause} from './core/failure-causes.mjs';
import {releaseTab} from './core/release.mjs';
import {ownership} from './core/ownership.mjs';
import {SUSPENDED_POLICY_DEFAULTS} from './core/suspended-protection.mjs';
import {attachWindowScope, createWindowScope} from './core/window-scope.mjs';
import {
  authorizeDiagnosticAccess,
  authorizePopupNavigationRequest,
  authorizePopupPageRequest,
  dispatchPopup,
  filterPopupTakeoverSnapshot,
  respondAsync,
  validatePopupTargetIds
} from './core/respond.mjs';
import {resolveTreeStyleTabTargets} from './core/tree-style-tab.mjs';
import {interrupts} from './plugins/loader.mjs';

// Context Menu
{
  const actionDiagnostics = createActionDiagnostics(diagnosticJournal);
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
  starters.push(() => actionDiagnostics.run({
    command: 'worker-startup',
    source: 'automatic-startup'
  }, async diagnostic => {
    await diagnostic.stage({phase: 'settings'});
    return onStartup();
  }));

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
  const diagnosticCapabilities = createDiagnosticCapabilityCache();
  const conflictScanner = createConflictScanner({ownership});
  const popupProgress = createPopupProgressManager({
    publish: publishPopupProgress,
    recordDiagnostic: snapshot => diagnosticJournal.record(snapshot),
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
        reject(Object.assign(Error(error.message), {
          failureCause: FAILURE_CAUSES.SCOPE_QUERY_FAILED
        }));
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
  const diagnosticAccess = (request, sender) => authorizeDiagnosticAccess(request, sender, {
    expectedExtensionId: chrome.runtime.id,
    expectedOptionsUrl: chrome.runtime.getURL('data/options/index.html'),
    expectedPopupUrl: chrome.runtime.getURL('data/popup/index.html'),
    query,
    resolveWindowScopedTab
  });
  const ownData = (value, key) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const popupAuthorization = (request, sender) => authorizePopupPageRequest(request, sender, {
    expectedExtensionId: chrome.runtime.id,
    expectedPopupUrl: chrome.runtime.getURL('data/popup/index.html'),
    query
  });
  const popupNavigationAuthorization = (request, sender) => authorizePopupNavigationRequest(
    request,
    sender,
    {
      expectedExtensionId: chrome.runtime.id,
      expectedPopupUrl: chrome.runtime.getURL('data/popup/index.html'),
      query
    }
  );
  const diagnosticCorrelation = request => {
    const correlation = ownData(request, 'correlation');
    if (correlation !== undefined && (typeof correlation !== 'string' ||
        !/^ATDC-[A-Z0-9]{16,40}$/.test(correlation))) {
      throw Error('Popup diagnostic correlation is invalid');
    }
    return correlation;
  };
  const diagnosticAccessForPrivateContext = privateContext => privateContext ? {
    clearDurable: false,
    clearPrivate: true,
    includeDurable: false,
    includePrivate: true
  } : {
    clearDurable: true,
    clearPrivate: false,
    includeDurable: true,
    includePrivate: false
  };
  const ingestDiagnosticEvent = async (request, sender) => {
    const popupUrl = chrome.runtime.getURL('data/popup/index.html');
    const optionsUrl = chrome.runtime.getURL('data/options/index.html');
    const source = sender?.id === chrome.runtime.id && sender?.url === popupUrl ? 'popup' :
      sender?.id === chrome.runtime.id && sender?.url === optionsUrl ? 'options' : undefined;
    if (!source) throw Error('Diagnostic event sender is not authorized');

    const input = ownData(request, 'event');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw Error('Diagnostic event payload is invalid');
    }
    const candidate = {source};
    for (const key of [
      'type', 'action', 'command', 'phase', 'outcome', 'counts', 'code', 'attempt'
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) candidate[key] = descriptor.value;
    }
    const correlation = ownData(request, 'correlation');
    if (correlation !== undefined) candidate.correlation = correlation;
    const projected = projectActionEvent(candidate);
    if (!projected) throw Error('Diagnostic event payload is invalid');

    let access = source === 'popup' && correlation !== undefined ?
      diagnosticCapabilities.resolve(correlation) : undefined;
    let remembered = false;
    if (!access) {
      access = await diagnosticAccess(request, sender);
      if (source === 'popup' && correlation !== undefined) {
        remembered = diagnosticCapabilities.remember(correlation, access);
      }
    }
    if (access.includePrivate === true && access.includeDurable !== true) {
      projected.privateContext = true;
    }
    const committed = await actionDiagnostics.event(projected);
    if (!committed) {
      if (remembered) diagnosticCapabilities.remove(correlation);
      throw Error('Diagnostic event was not committed');
    }
    if (source === 'popup' && terminalDiagnosticResponse(projected)) {
      diagnosticCapabilities.remove(correlation);
    }
    return {accepted: true};
  };

  const onClicked = async (info, tab) => {
    const {menuItemId, shiftKey, checked, progress, diagnostic} = info;
    await diagnostic?.stage({phase: 'command'});
    if (scopedCommands.has(menuItemId)) {
      await diagnostic?.stage({phase: 'scope-query'});
    }
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
      await diagnostic?.stage({phase: 'settings'});
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
          }, 'menu/1', diagnostic);

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
      await diagnostic?.stage({phase: 'scope-query'});
      // it is possible to have multiple highlighted tabs. Let's discard all of them
      let tabs;
      try {
        tabs = await query({
          windowId: selectedTab.windowId,
          windowType: 'normal'
        });
      }
      catch (error) {
        if (error && typeof error === 'object' && !safeFailureCause(error.failureCause)) {
          error.failureCause = FAILURE_CAUSES.SCOPE_QUERY_FAILED;
        }
        throw error;
      }

      const htabs = []; // these are tabs that will be discarded
      // discard-tree for Tree Style Tab
      if (menuItemId === 'discard-tree' && info.viewType === 'sidebar') {
        htabs.push(...await resolveTreeStyleTabTargets({
          runtime: chrome.runtime,
          selectedTab,
          tabs
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
      await diagnostic?.stage({
        counts: {attempted: htabs.length, total: htabs.length},
        phase: 'keeper'
      });
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
          POPUP_CODES.TAB_DISCARDED,
          FAILURE_CAUSES.TAKEOVER_FAILED
        ),
        targets: htabs,
        waitForTakeover: discard.waitForTakeover
      }));
    }
    else if (menuItemId === 'open-tab-then-discard') {
      await diagnostic?.stage({phase: 'tab-operation'});
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
      await diagnostic?.stage({phase: 'settings'});
      const autoDiscardable = info.value || false; // when called from page context menu, there is no value
      await chrome.tabs.update(tab.id, {
        autoDiscardable
      });
    }
    else if (menuItemId === 'toggle-allowed') {
      await diagnostic?.stage({phase: 'settings'});
      await chrome.tabs.update(tab.id, {
        autoDiscardable: tab.autoDiscardable === false
      });
    }
    // discard-tabs, discard-window, discard-other-windows, discard-rights, discard-lefts
    // release-tabs, release-window, release-other-windows, release-rights, release-lefts
    else {
      await diagnostic?.stage({
        phase: typeof menuItemId === 'string' && menuItemId.startsWith('release-') ?
          'release' : 'eligibility'
      });
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
        check: trackCheck(progress, tabs => number.check(tabs, number.IGNORE, 'menu/2', diagnostic)),
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
          POPUP_CODES.TAB_DISCARDED,
          FAILURE_CAUSES.TAKEOVER_FAILED
        )
      }));
    }
  };

  const activeNavigationTarget = async target => {
    const pinned = Number.isInteger(target?.tabId) && Number.isInteger(target?.windowId);
    const tabs = await query(pinned ? {
      active: true,
      windowId: target.windowId,
      windowType: 'normal'
    } : {
      active: true,
      currentWindow: true,
      windowType: 'normal'
    });
    const active = tabs[0];
    if (pinned && (!active || active.id !== target.tabId || active.windowId !== target.windowId ||
        (typeof target.incognito === 'boolean' && active.incognito !== target.incognito))) {
      throw Error('The navigation target changed before the command could run');
    }
    return active;
  };
  const handleNavigation = async (method, diagnostic, target) => {
    await diagnostic?.stage({phase: 'tab-operation'});
    if (method !== 'close') {
      return navigate(method, false, target);
    }

    const options = await storage({
      'discard-protected-on-close': false
    });
    if (options['discard-protected-on-close'] !== true) {
      return navigate(method, false, target);
    }

    const active = await activeNavigationTarget(target);
    if (!active) {
      return false;
    }
    const protectedTab = active.pinned === true ||
      (Number.isInteger(active.groupId) && active.groupId !== -1);
    if (!protectedTab) {
      return navigate(method, false, target);
    }

    const current = await activeNavigationTarget(target);
    const result = await onClicked({diagnostic, menuItemId: 'discard-tab'}, current);
    if (result?.blocked === true) {
      throw Error('cannot discard the protected active tab without a safe keeper');
    }
    return result;
  };
  const runNavigationAction = async (details, task) => {
    let result;
    await actionDiagnostics.run(details, async diagnostic => {
      result = await task(diagnostic);
      // Keep the runtime response backward compatible while making the journal
      // terminal truthful: a navigation with no candidate changed nothing.
      return result === false ? {code: 'NO_CHANGE'} : result;
    });
    return result;
  };

  const runEntry = (command, task) => runEntryCommand(command, task, ({command, message}) => {
    notify(`${command}: ${message}`);
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void runEntry(info.menuItemId, () => actionDiagnostics.run({
      command: info.menuItemId,
      privateContext: tab?.incognito === true,
      source: 'context-menu'
    }, diagnostic => onClicked({...info, diagnostic}, tab)));
  });
  chrome.action.onClicked.addListener(async tab => {
    return await runEntry('toolbar', async () => {
      let menuItemId;
      try {
        menuItemId = await actionCommand(storage);
      }
      catch (error) {
        return actionDiagnostics.run({
          privateContext: tab?.incognito === true,
          source: 'toolbar'
        }, async () => {
          throw error;
        });
      }
      return actionDiagnostics.run({
        command: menuItemId,
        privateContext: tab?.incognito === true,
        source: 'toolbar'
      }, async diagnostic => {
        await diagnostic.stage({phase: 'settings'});
      if (menuItemId === 'popup') {
        await chrome.action.setPopup({popup: '/data/popup/index.html'});
        if (chrome.action.openPopup) {
          await chrome.action.openPopup();
        }
      }
      else {
          return onClicked({diagnostic, menuItemId}, tab);
      }
      });
    });
  });
  // commands
  chrome.commands.onCommand.addListener(async command => {
    return await runEntry(command, async () => {
      let tabs;
      try {
        tabs = await query({active: true, currentWindow: true});
      }
      catch (error) {
        return actionDiagnostics.run({
          command,
          privateContext: true,
          source: 'keyboard'
        }, async () => {
          throw error;
        });
      }
      const details = {
        command,
        privateContext: tabs[0]?.incognito === true,
        source: 'keyboard'
      };
      if (command.startsWith('move-') || command === 'close') {
        const active = tabs[0];
        return runNavigationAction(details, diagnostic => active ? handleNavigation(
          command,
          diagnostic,
          {
            incognito: active?.incognito === true,
            tabId: active?.id,
            windowId: active?.windowId
          }
        ) : false);
      }
      return actionDiagnostics.run(details, async diagnostic => {
        if (tabs.length) {
          return onClicked({diagnostic, menuItemId: command}, tabs[0]);
        }
      });
    });
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.method === 'popup') {
      return respondAsync(async () => {
        let authorized;
        const correlation = diagnosticCorrelation(request);
        try {
          ({request: authorized} = await popupAuthorization(request, sender));
        }
        catch (error) {
          if (sender?.id === chrome.runtime.id &&
              sender?.url === chrome.runtime.getURL('data/popup/index.html')) {
            await actionDiagnostics.event({
              code: 'REQUEST_DENIED',
              outcome: 'denied',
              phase: 'admission',
              privateContext: true,
              source: 'popup',
              type: 'RESPONSE'
            });
          }
          throw error;
        }
        if (correlation !== undefined) {
          diagnosticCapabilities.remember(
            correlation,
            diagnosticAccessForPrivateContext(authorized.incognito === true)
          );
        }
        return actionDiagnostics.run({
          command: authorized.cmd,
          correlation,
          privateContext: authorized.incognito === true,
          source: 'popup'
        }, diagnostic => scopedCommands.has(authorized.cmd) ? popupProgress.run(
            authorized,
            progress => dispatchPopup({...authorized, progress}, query, onClicked, diagnostic),
            progress => Promise.all(progress.targetIds().map(id => discard.cancelTakeover(id)))
          ) : dispatchPopup(authorized, query, onClicked, diagnostic));
      }, sendResponse);
    }
    else if (request.method === 'popup-progress-snapshot') {
      return respondAsync(async () => {
        const {request: authorized} = await popupAuthorization(request, sender);
        return popupProgress.snapshot(authorized);
      }, sendResponse);
    }
    else if (request.method === 'popup-progress-cancel') {
      return respondAsync(async () => {
        const correlation = diagnosticCorrelation(request);
        // A running command may activate a keeper (discard-tree, for one), so
        // the tab the popup opened on is no longer active. Cancellation is
        // bound to the job's window and privacy context, not to that tab.
        const {request: authorized, tab} = await popupAuthorization({...request, tabId: undefined}, sender);
        const job = await popupProgress.snapshot(authorized);
        if (!job || job.jobId !== request.jobId ||
            !['running', 'cancelling'].includes(job.state) ||
            job.windowId !== authorized.windowId ||
            job.privateContext !== (tab.incognito === true)) {
          throw Error('Popup cancellation target is not authorized');
        }
        if (correlation !== undefined) {
          diagnosticCapabilities.remember(
            correlation,
            diagnosticAccessForPrivateContext(tab.incognito === true)
          );
        }
        return cancelPopupProgressWithDiagnostics({
          actionDiagnostics,
          cancel: jobId => popupProgress.cancel(jobId),
          command: job.command,
          correlation,
          jobId: request.jobId,
          privateContext: tab.incognito === true,
          source: 'popup'
        });
      }, sendResponse);
    }
    else if (request.method === 'diagnostic-event') {
      return respondAsync(() => ingestDiagnosticEvent(request, sender), sendResponse);
    }
    else if (request.method === 'diagnostics-latest') {
      return respondAsync(async () => diagnosticJournal.latest(
        request.incidentId,
        await diagnosticAccess(request, sender)
      ), sendResponse);
    }
    else if (request.method === 'diagnostics-export') {
      return respondAsync(async () => diagnosticJournal.exportText(
        request.selector ?? request.incidentId,
        await diagnosticAccess(request, sender)
      ), sendResponse);
    }
    else if (request.method === 'diagnostics-snapshot') {
      return respondAsync(async () => diagnosticJournal.snapshot(
        await diagnosticAccess(request, sender)
      ), sendResponse);
    }
    else if (request.method === 'diagnostics-clear') {
      return respondAsync(async () => diagnosticJournal.clear(
        await diagnosticAccess(request, sender)
      ), sendResponse);
    }
    else if (request.method === 'conflict-scan') {
      return respondAsync(() => runConflictScanEndpoint({
        actionDiagnostics,
        authorize: async () => {
          const optionsUrl = chrome.runtime.getURL('data/options/index.html');
          if (sender?.id !== chrome.runtime.id || sender?.url !== optionsUrl) {
            throw Error('Conflict scan is restricted to the Options page');
          }
          const correlation = ownData(request, 'correlation');
          if (correlation !== undefined && (typeof correlation !== 'string' ||
              !/^ATDC-[A-Z0-9]{16,40}$/.test(correlation))) {
            throw Error('Conflict scan diagnostic correlation is invalid');
          }
          const access = await diagnosticAccess(request, sender);
          return {
            correlation,
            privateContext: access.includePrivate === true && access.includeDurable !== true
          };
        },
        checkPermission: () => callConflictApi(
            chrome.permissions,
            'contains',
            [{permissions: ['management']}]
          ),
        scan: ({privateContext}) => conflictScanner.scan({privateContext}),
        signalCodes: Object.values(CONFLICT_SIGNALS)
      }), sendResponse);
    }
    else if (request.method === 'simulate') {
      return respondAsync(() => actionDiagnostics.run({
        command: request.cmd,
        privateContext: sender.tab?.incognito === true,
        source: 'runtime'
      }, diagnostic => onClicked({diagnostic, menuItemId: request.cmd}, sender.tab)), sendResponse);
    }
    else if (request.method === 'build-context') {
      return respondAsync(() => actionDiagnostics.run({
        source: 'settings'
      }, async diagnostic => {
        await diagnostic.stage({phase: 'settings'});
        return onStartup();
      }), sendResponse);
    }
    else if (request.method === 'takeover-snapshot') {
      return respondAsync(async () => {
        const {tab} = await popupAuthorization(request, sender);
        const selected = await resolveWindowScopedTab(tab);
        return filterPopupTakeoverSnapshot(discard.takeoverSnapshot(), selected);
      }, sendResponse);
    }
    else if (request.method === 'run-check-on-action') {
      return respondAsync(async () => {
        const correlation = diagnosticCorrelation(request);
        const {request: authorized, tab} = await popupAuthorization(request, sender);
        const highlighted = await query({
          highlighted: true,
          windowId: authorized.windowId,
          windowType: 'normal'
        });
        const tabs = validatePopupTargetIds(request.ids, highlighted);
        if (tabs.some(target => (target.incognito === true) !== (tab.incognito === true))) {
          throw Error('Popup target privacy changed');
        }
        if (correlation !== undefined) {
          diagnosticCapabilities.remember(
            correlation,
            diagnosticAccessForPrivateContext(tab.incognito === true)
          );
        }
        return actionDiagnostics.run({
          command: 'automatic-scan',
          correlation,
          privateContext: tab.incognito === true,
          source: 'popup'
        }, diagnostic => number.check(tabs, {
          'exclude-active': false,
          'icon-update': true
        }, 'menu/3', diagnostic));
      }, sendResponse);
    }
    else if (['close', 'move-next', 'move-previous'].includes(request.method)) {
      return respondAsync(async () => {
        const correlation = diagnosticCorrelation(request);
        const {request: authorized, tab} = await popupNavigationAuthorization(request, sender);
        if (correlation !== undefined) {
          diagnosticCapabilities.remember(
            correlation,
            diagnosticAccessForPrivateContext(tab.incognito === true)
          );
        }
        return runNavigationAction({
          command: authorized.method,
          correlation,
          privateContext: tab.incognito === true,
          source: 'popup'
        }, diagnostic => handleNavigation(authorized.method, diagnostic, {
          incognito: tab.incognito === true,
          tabId: authorized.tabId,
          windowId: authorized.windowId
        }));
      }, sendResponse);
    }
  });
}
