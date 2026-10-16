import {log} from './core/utils.mjs';
import {prefs, storage} from './core/prefs.mjs';
import {starters} from './core/startup.mjs';
import {actionPopup} from './core/action.mjs';
import {authorizeOptionsPageRequest, respondAsync} from './core/respond.mjs';
import {resetExtensionState} from './core/reset.mjs';
import {releaseTab} from './core/release.mjs';
import {discard} from './core/discard.mjs';
import {ownership} from './core/ownership.mjs';
import {createLifecycleNavigation} from './core/lifecycle.mjs';
import {installExternalDiscardApi} from './core/external-api.mjs';
import {diagnosticJournal} from './core/diagnostic-journal.mjs';
import {createActionDiagnostics} from './core/action-diagnostics.mjs';
import {number} from './modes/number.mjs';
import './menu.mjs';

const actionDiagnostics = createActionDiagnostics(diagnosticJournal);
void actionDiagnostics.event({
  code: 'WORKER_STARTED',
  command: 'worker-startup',
  outcome: 'started',
  phase: 'startup',
  source: 'worker',
  type: 'worker-start'
});

// External extension control is opt-in, ID-allowlisted, schema-bound, and uses
// the same ownership/protection pipeline as the popup and context-menu rows.
installExternalDiscardApi();

chrome.runtime.onMessage.addListener((request, sender, resposne) => {
  log('onMessage request received', request);
  const {method} = request;
  if (method === 'discard.on.load') { // for links after initial load
    void actionDiagnostics.run({
      command: 'automatic-discard',
      privateContext: sender.tab?.incognito === true,
      source: 'runtime'
    }, async diagnostic => {
      await diagnostic.stage({phase: 'native-discard'});
      return discard(sender.tab);
    }).catch(error => log('discard.on.load failed', error));
  }
  else if (method === 'reset') {
    return respondAsync(async () => {
      const correlation = request?.correlation;
      if (correlation !== undefined && (typeof correlation !== 'string' ||
          !/^ATDC-[A-Z0-9]{16,40}$/.test(correlation))) {
        throw Error('Reset diagnostic correlation is invalid');
      }
      const access = authorizeOptionsPageRequest(sender, {
        expectedExtensionId: chrome.runtime.id,
        expectedOptionsUrl: chrome.runtime.getURL('data/options/index.html')
      });
      const privateContext = access.includePrivate === true && access.includeDurable !== true;
      return actionDiagnostics.run({
        command: 'settings-reset',
        correlation,
        privateContext,
        source: 'reset'
      }, async diagnostic => {
        await actionDiagnostics.event({
          code: 'RESET_STARTED',
          command: 'settings-reset',
          ...(correlation !== undefined && {correlation}),
          outcome: 'started',
          phase: 'reset',
          privateContext,
          source: 'reset',
          type: 'reset-start'
        });
        await diagnostic.stage({phase: 'reset'});
        let result;
        let resetError;
        try {
          result = await resetExtensionState(
            ownership,
            chrome.storage.local,
            discard.cancelTakeovers,
            releaseTab,
            discard.beginReset
          );
        }
        catch (error) {
          resetError = error;
        }
        // resetExtensionState clears the backing storage directly. Synchronize
        // the journal's in-memory cache before writing the one safe terminal
        // reset event, otherwise an old hydrated session could be resurrected.
        await diagnosticJournal.clear({clearDurable: true, clearPrivate: true})
          .catch(() => undefined);
        await actionDiagnostics.event({
          code: resetError ? 'ACTION_FAILED' : 'RESET_COMPLETED',
          command: 'settings-reset',
          ...(correlation !== undefined && {correlation}),
          outcome: resetError ? 'failed' : 'complete',
          phase: 'reset',
          privateContext,
          source: 'reset',
          type: 'reset-end'
        });
        if (resetError) throw resetError;
        return result;
      });
    }, resposne);
  }
  else if (method === 'storage') {
    actionDiagnostics.run({source: 'settings'}, async diagnostic => {
      await diagnostic.stage({phase: 'storage'});
      return Promise.all([
        storage(request.managed || {}, 'managed'),
        storage(request.session || {}, 'session')
      ]).then(a => Object.assign(...a));
    }).then(resposne).catch(error => log('storage request failed', error));

    return true;
  }
});

// left-click action
const popup = () => chrome.action.setPopup({
  popup: actionPopup(prefs.click)
});
starters.push(() => actionDiagnostics.run({
  command: 'worker-startup',
  source: 'automatic-startup'
}, async diagnostic => {
  await diagnostic.stage({phase: 'settings'});
  return popup();
}));
storage.on('click', () => actionDiagnostics.run({source: 'settings'}, async diagnostic => {
  await diagnostic.stage({phase: 'settings'});
  return popup();
}).catch(error => log('action popup update failed', error)));

// Reconcile persisted markers and finish only a takeover this worker had
// already woken. Existing external discards are left asleep until an explicit
// scoped command targets them, avoiding a reload sweep on every MV3 restart.
starters.push(() => actionDiagnostics.run({
  command: 'startup-recovery',
  privateContext: true,
  source: 'recovery'
}, async diagnostic => {
  await diagnostic.stage({phase: 'ownership'});
  await ownership.start();
  await diagnostic.stage({phase: 'ownership-finalization'});
  await discard.recoverInterruptedPulse();
  await discard.recoverOrdinaryDiscards({
    revalidate: tabs => number.revalidateOrdinaryIntents(tabs, diagnostic)
  });
  return actionDiagnostics.run({
    command: 'takeover-recovery',
    privateContext: true,
    source: 'recovery'
  }, async takeoverDiagnostic => {
    await takeoverDiagnostic.stage({phase: 'takeover'});
    return discard.recoverTakeovers();
  });
}));

// idle timeout
starters.push(() => actionDiagnostics.run({
  command: 'worker-startup',
  source: 'automatic-startup'
}, async diagnostic => {
  await diagnostic.stage({phase: 'settings'});
  return chrome.idle.setDetectionInterval(prefs['idle-timeout']);
}));
storage.on('idle-timeout', () => {
  void actionDiagnostics.run({source: 'settings'}, async diagnostic => {
    await diagnostic.stage({phase: 'settings'});
    return chrome.idle.setDetectionInterval(prefs['idle-timeout']);
  }).catch(error => log('idle timeout update failed', error));
});

// badge
starters.push(() => actionDiagnostics.run({
  command: 'worker-startup',
  source: 'automatic-startup'
}, async diagnostic => {
  await diagnostic.stage({phase: 'startup'});
  return chrome.action.setBadgeBackgroundColor({color: '#666'});
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
