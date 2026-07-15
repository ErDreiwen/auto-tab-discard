import {number} from './modes/number.mjs';
import {storage, prefs} from './core/prefs.mjs';
import {navigate} from './core/navigate.mjs';
import {discard, inprogress} from './core/discard.mjs';
import {query, notify, match} from './core/utils.mjs';
import {starters} from './core/startup.mjs';
import {actionCommand} from './core/action.mjs';
import {tabsForGroupCommand} from './core/group.mjs';
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
      contexts,
      documentUrlPatterns: ['*://*/*']
    },
    {
      id: 'discard-tree',
      title: chrome.i18n.getMessage('menu_discard_tree'),
      contexts,
      documentUrlPatterns: ['*://*/*']
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

  const onClicked = async (info, tab) => {
    if (typeof interrupts !== 'undefined') {
      // wait for plug-in to be ready
      await interrupts['before-action']();
      // wait for plug-in manipulations
      await interrupts['before-menu-click'](info, tab);
    }
    else {
      console.warn('plugins module is not loaded');
    }
    //
    const {menuItemId, shiftKey, checked} = info;

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
        windowId: tab.windowId
      });

      const htabs = []; // these are tabs that will be discarded
      // discard-tree for Tree Style Tab
      if (menuItemId === 'discard-tree' && info.viewType === 'sidebar') {
        htabs.push(tab);
        await new Promise(resolve => chrome.runtime.sendMessage('treestyletab@piro.sakura.ne.jp', {
          type: 'get-tree',
          tab: tab.id
        }, tab => {
          const add = tab => {
            htabs.push(...tab.children);
            tab.children.filter(t => t.children).forEach(add);
          };
          add(tab);
          resolve();
        }));
      }
      // Chromium/Edge native tab groups. Group membership is the only selector:
      // highlighted tabs outside this group must never be included.
      else if (menuItemId === 'discard-tree') {
        htabs.push(...tabsForGroupCommand(tabs, tab));
      }
      else {
        htabs.push(tab);
      }
      if (htabs.filter(t => t.active).length) {
        // ids to be discarded
        const ids = htabs.map(t => t.id);

        const otab = tabs
          .filter(t => {
            return t.discarded === false && t.highlighted === false && t.status !== 'unloaded' &&
              ids.indexOf(t.id) === -1 &&
              inprogress.has(t.id) === false;
          })
          .sort((a, b) => Math.abs(a.index - tab.index) - Math.abs(b.index - tab.index))
          .shift();

        if (otab) {
          await chrome.tabs.update(otab.id, {
            active: true
          });
          // At the time we recorded htabs, one tab was active. Mark it inactive before discarding.
          htabs.forEach(t => t.active = false);
          await Promise.all(htabs.map(discard));
        }
        else {
          notify(chrome.i18n.getMessage('menu_msg3'));
        }
      }
      else {
        await Promise.all(htabs.map(discard));
      }
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
      const info = {
        url: '*://*/*',
        discarded: menuItemId.startsWith('release'),
        active: false
      };
      if (
        ['discard-window', 'discard-rights', 'discard-lefts', 'release-window', 'release-rights', 'release-lefts']
          .some(k => k === menuItemId)
      ) {
        info.currentWindow = true;
      }
      else if (menuItemId === 'discard-other-windows' || menuItemId === 'release-other-windows') {
        info.currentWindow = false;
      }
      let tabs = await query(info);

      if (menuItemId.endsWith('rights') || menuItemId.endsWith('lefts')) {
        if (menuItemId.endsWith('lefts')) {
          tabs = tabs.filter(t => t.index < tab.index);
        }
        else {
          tabs = tabs.filter(t => t.index > tab.index);
        }
      }
      if (menuItemId.startsWith('discard')) {
        if (shiftKey) {
          await Promise.all(tabs.map(discard));
        }
        else {
          // make sure to only discard possible tabs not all of them
          await number.check(tabs, number.IGNORE, 'menu/2');
        }
      }
      // release
      else {
        await Promise.all(tabs.map(tab => chrome.tabs.reload(tab.id, {
            bypassCache: shiftKey ? true : false
        })));
      }
    }
  };
  chrome.contextMenus.onClicked.addListener(onClicked);
  chrome.action.onClicked.addListener(async tab => {
    const menuItemId = await actionCommand(storage);
    if (menuItemId === 'popup') {
      await chrome.action.setPopup({popup: 'data/popup/index.html'});
      if (chrome.action.openPopup) {
        await chrome.action.openPopup();
      }
    }
    else {
      await onClicked({menuItemId}, tab);
    }
  });
  // commands
  chrome.commands.onCommand.addListener(async command => {
    if (command.startsWith('move-') || command === 'close') {
      await navigate(command);
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
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.method === 'popup') {
      return respondAsync(() => dispatchPopup(request, query, onClicked), sendResponse);
    }
    else if (request.method === 'simulate') {
      return respondAsync(() => onClicked({
        menuItemId: request.cmd
      }, sender.tab), sendResponse);
    }
    else if (request.method === 'build-context') {
      return respondAsync(() => onStartup(), sendResponse);
    }
    else if (request.method === 'run-check-on-action') {
      const tabs = request.ids.map(id => ({id}));
      return respondAsync(() => number.check(tabs, {
        'exclude-active': false,
        'icon-update': true
      }, 'menu/3'), sendResponse);
    }
  });
}
