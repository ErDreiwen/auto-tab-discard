import {match} from '../../worker/core/utils.mjs';
import {releaseAvailability, releaseCommands} from '../../worker/core/command-scope.mjs';

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  e[e.dataset.i18nValue || 'textContent'] = chrome.i18n.getMessage(e.dataset.i18n);
  if (e.dataset.i18nTitle) {
    e.title = chrome.i18n.getMessage(e.dataset.i18nTitle);
  }
});

let tab;

// works on all highlighted tabs in the current window
const allowed = document.getElementById('allowed');
allowed.addEventListener('change', () => chrome.tabs.query({
  currentWindow: true,
  highlighted: true
}, async tabs => {
  for (const tab of tabs) {
    await new Promise(resolve => chrome.tabs.update(tab.id, {
      autoDiscardable: allowed.checked === false
    }, resolve));
  }
  chrome.runtime.sendMessage({
    method: 'run-check-on-action',
    ids: tabs.map(t => t.id)
  });
}));

const whitelist = {
  always: document.querySelector('[data-cmd=whitelist-domain]'),
  session: document.querySelector('[data-cmd=whitelist-session]')
};

const queryTabs = options => new Promise(resolve => chrome.tabs.query(options, resolve));

const init = async () => {
  chrome.alarms.get('tmp.disable', a => {
    chrome.runtime.sendMessage({
      'method': 'storage',
      'managed': {
        'tmp_disable': 0
      }
    }, prefs => {
      document.getElementById('tmp_disable').value = a ? prefs['tmp_disable'] : 0;
    });
  });

  const activeTabs = await queryTabs({
    active: true,
    currentWindow: true
  });
  if (activeTabs.length) {
    tab = activeTabs[0];

    try {
      const {protocol = '', hostname} = new URL(tab.url);

      if (protocol.startsWith('http') || protocol.startsWith('ftp')) {
        chrome.runtime.sendMessage({
          'method': 'storage',
          'managed': {
            'whitelist': []
          },
          'session': {
            'whitelist.session': []
          }
        }, prefs => {
          whitelist.session.checked = match(prefs['whitelist.session'], hostname, tab.url) ? true : false;
          whitelist.always.checked = match(prefs['whitelist'], hostname, tab.url) ? true : false;
        });
        if (tab.autoDiscardable === false) {
          allowed.checked = true;
        }
        chrome.scripting.executeScript({
          target: {
            tabId: tab.id
          },
          func: () => document.title
        }).catch(e => {
          console.warn('Cannot access to this tab', e);
          allowed.parentElement.dataset.disabled = true;
        });
      }
      else {
        throw Error('no HTTP');
      }
    }
    catch (e) {
      // on navigation
      whitelist.session.closest('.mlt').dataset.disabled = true;
      allowed.parentElement.dataset.disabled = true;
    }
  }

  /* Disable release controls using the exact same scope as worker execution. */
  const toggle = (cmd, disabled) => document.querySelector(`[data-cmd=${cmd}]`).classList.toggle('disabled', disabled);
  const available = await releaseAvailability(queryTabs, tab);
  releaseCommands.forEach(command => toggle(command, available[command] === false));
};
init().catch(e => console.error('popup initialization failed', e));

document.addEventListener('click', e => {
  const target = e.target.closest('[data-cmd]');
  const cmd = target?.dataset.cmd;

  if (cmd === 'open-options') {
    chrome.runtime.openOptionsPage();
    window.close();
  }
  else if (cmd && (cmd.startsWith('move-') || cmd === 'close')) {
    chrome.runtime.sendMessage({
      method: cmd,
      cmd
    }, init);
  }
  else if (cmd) {
    chrome.runtime.sendMessage({
      method: 'popup',
      cmd,
      shiftKey: e.shiftKey,
      checked: target.checked
    }, response => {
      const error = chrome.runtime.lastError;
      if (error || response?.ok === false) {
        const message = error?.message || response?.error || 'Action failed';
        document.querySelector('header').textContent = message;
        console.error(message);
      }
      else if (['whitelist-session', 'whitelist-domain'].includes(cmd) === false) {
        window.close();
      }
    });
  }
});

document.getElementById('tmp_disable').addEventListener('change', e => {
  chrome.storage.local.set({
    'tmp_disable': Number(e.target.value)
  });
});
