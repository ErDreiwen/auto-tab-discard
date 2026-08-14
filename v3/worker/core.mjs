import {log} from './core/utils.mjs';
import {prefs, storage} from './core/prefs.mjs';
import {starters} from './core/startup.mjs';
import {actionPopup} from './core/action.mjs';
import {respondAsync} from './core/respond.mjs';
import {resetExtensionState} from './core/reset.mjs';
import {releaseTab} from './core/release.mjs';
import {discard} from './core/discard.mjs';
import {ownership} from './core/ownership.mjs';
import {createLifecycleNavigation} from './core/lifecycle.mjs';
import {installExternalDiscardApi} from './core/external-api.mjs';
import {number} from './modes/number.mjs';
import './menu.mjs';

// External extension control is opt-in, ID-allowlisted, schema-bound, and uses
// the same ownership/protection pipeline as the popup and context-menu rows.
installExternalDiscardApi();

chrome.runtime.onMessage.addListener((request, sender, resposne) => {
  log('onMessage request received', request);
  const {method} = request;
  if (method === 'discard.on.load') { // for links after initial load
    discard(sender.tab);
  }
  else if (method === 'reset') {
    return respondAsync(() => resetExtensionState(
      ownership,
      chrome.storage.local,
      discard.cancelTakeovers,
      releaseTab,
      discard.beginReset
    ), resposne);
  }
  else if (method === 'storage') {
    Promise.all([
      storage(request.managed || {}, 'managed'),
      storage(request.session || {}, 'session')
    ]).then(a => Object.assign(...a)).then(resposne);

    return true;
  }
});

// left-click action
const popup = () => chrome.action.setPopup({
  popup: actionPopup(prefs.click)
});
starters.push(() => popup());
storage.on('click', () => popup());

// Reconcile persisted markers and finish only a takeover this worker had
// already woken. Existing external discards are left asleep until an explicit
// scoped command targets them, avoiding a reload sweep on every MV3 restart.
starters.push(async () => {
  await ownership.start();
  await discard.recoverInterruptedPulse();
  await discard.recoverOrdinaryDiscards({
    revalidate: tabs => number.revalidateOrdinaryIntents(tabs)
  });
  return discard.recoverTakeovers();
});

// idle timeout
starters.push(() => {
  chrome.idle.setDetectionInterval(prefs['idle-timeout']);
});
storage.on('idle-timeout', () => {
  chrome.idle.setDetectionInterval(prefs['idle-timeout']);
});

// badge
starters.push(() => chrome.action.setBadgeBackgroundColor({
  color: '#666'
}));

/* Optional release notes and feedback. Disabled by default in this fork. */
if (navigator.webdriver !== true) {
  const getSelf = () => new Promise((resolve, reject) => chrome.management.getSelf(info => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message || String(error))) : resolve(info);
  }));
  const lifecycle = createLifecycleNavigation({
    getPreferences: defaults => storage(defaults),
    getSelf,
    runtime: chrome.runtime,
    tabs: chrome.tabs
  });
  chrome.runtime.onInstalled.addListener(details => lifecycle.installed(details).then(result => {
    if (result.opened) {
      chrome.storage.local.set({'last-update': Date.now()});
    }
  }).catch(error => log('lifecycle navigation failed', error)));
  starters.push(() => lifecycle.configureUninstall().catch(error =>
    log('lifecycle uninstall preference failed', error)));
  storage.on('lifecycle-feedback', () => lifecycle.configureUninstall().catch(error =>
    log('lifecycle uninstall preference failed', error)));
}
