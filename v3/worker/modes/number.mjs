import {storage} from '../core/prefs.mjs';
import {log, query, match} from '../core/utils.mjs';
import {discard} from '../core/discard.mjs';
import {ownership} from '../core/ownership.mjs';
import {starters} from '../core/startup.mjs';
import {
  createFrameMetadataCollector,
  createOptionalFrameEnumerator
} from '../core/frame-metadata.mjs';
import {createAlarmCatchUp} from '../core/alarm-catch-up.mjs';
import {markerFallback} from '../core/marker-fallback.mjs';
import {FAILURE_CAUSES, failureCauseFrom} from '../core/failure-causes.mjs';
import {
  createSingleFlightQueue,
  METADATA_SCAN_CONCURRENCY,
  METADATA_SCAN_TIMEOUT,
  loadedDiscardOutcomes,
  metadataFlightKey,
  partitionFrozenTabs,
  runBoundedScan,
  runDiscardCandidates,
  selectOldest
} from '../core/metadata-scan.mjs';
import {interrupts} from '../plugins/loader.mjs';

const number = {
  IGNORE: Object.freeze({ // ignore defaults
    'idle': false,
    'battery': false,
    'online': false,
    'number': 0,
    'period': 0,
    'max.single.discard': Infinity,
    'ignore.meta.data': true
  })
};
const pluginFilters = {}; // this object adds custom filters to the number-based discarding
const frameMetadata = createFrameMetadataCollector({
  enumerateFrames: createOptionalFrameEnumerator(chrome),
  execute: details => ownership.withNativeMutationGuard(() =>
    chrome.scripting.executeScript(details),
  details?.target?.tabId
  ),
  scripting: chrome.scripting
});
chrome.tabs.onRemoved.addListener(tabId => frameMetadata.forget(tabId));

number.install = async period => {
  // checking period is between 1 minute to 20 minutes
  period = Math.min(20 * 60, Math.max(60, period / 3));
  const periodInMinutes = period / 60;
  const alarm = await new Promise(resolve => chrome.alarms.get('number.check', resolve));

  // Do not postpone the next check whenever an unrelated event wakes the worker.
  if (
    !alarm ||
    typeof alarm.periodInMinutes !== 'number' ||
    Math.abs(alarm.periodInMinutes - periodInMinutes) > 1e-6
  ) {
    chrome.alarms.create('number.check', {
      when: Date.now() + period * 1000,
      periodInMinutes
    });
  }
};
number.remove = () => {
  return chrome.alarms.clear('number.check');
};
// filterTabsFrom is a list of tab that if provided, discarding only happens on them
// ops is the preference object overwrite
const runCheck = async (filterTabsFrom, ops = {}, reason, recoveryIds = undefined) => {
  // A nonempty explicit list is a command contract, not merely a hint for the
  // automatic scanner. Keep one terminal reason for every intended tab even
  // when Chromium omits its URL scheme from a renderer-only tabs.query filter.
  const targetedInputs = Array.isArray(filterTabsFrom) && filterTabsFrom.length ?
    [...new Map(filterTabsFrom
      .filter(tab => Number.isInteger(tab?.id))
      .map(tab => [tab.id, tab])).values()] : [];
  const targeted = targetedInputs.length !== 0;
  const intended = new Map(targetedInputs.map(tab => [tab.id, tab]));
  const classifications = new Map();
  const classify = (kind, tab, outcomeReason) => {
    if (targeted && Number.isInteger(tab?.id) && intended.has(tab.id) &&
        classifications.has(tab.id) === false) {
      classifications.set(tab.id, {
        kind,
        value: {tab, reason: outcomeReason}
      });
    }
  };
  const resultId = value => Number.isInteger(value?.tab?.id) ? value.tab.id :
    Number.isInteger(value?.id) ? value.id : undefined;
  const finalizeTargeted = result => {
    if (!targeted) {
      return result;
    }
    result ||= {};
    result.failed ||= [];
    result.protected ||= [];
    result.succeeded ||= [];
    result.unsupported ||= [];
    const accounted = new Set([
      ...result.failed,
      ...result.protected,
      ...result.succeeded,
      ...result.unsupported
    ].map(resultId).filter(Number.isInteger));
    for (const [id, entry] of classifications) {
      if (!accounted.has(id)) {
        result[entry.kind].push(entry.value);
        accounted.add(id);
      }
    }
    // This is a fail-closed invariant guard, not a normal classification path.
    // Focused tests exercise every intended boundary with a more precise reason.
    for (const [id, tab] of intended) {
      if (!accounted.has(id)) {
        result.unsupported.push({
          tab,
          reason: 'targeted discard ended without an authoritative tab classification'
        });
      }
    }
    return result;
  };
  const emptyResult = () => ({
    candidates: 0,
    discarded: [],
    failed: [],
    forced: [],
    frozen: {
      eligible: [],
      protected: [],
      attempted: [],
      failed: []
    },
    protected: [],
    scan: {
      completed: 0,
      failed: [],
      skipped: [],
      timedOut: false,
      total: 0
    },
    succeeded: [],
    unsupported: []
  });
  const protectAll = outcomeReason => {
    for (const tab of targetedInputs) {
      classify('protected', tab, outcomeReason);
    }
    return finalizeTargeted(emptyResult());
  };

  if (typeof interrupts !== 'undefined') {
    // wait for plug-ins to be ready
    await interrupts['before-action']();
  }
  else {
    console.warn('plugins module is not loaded');
  }

  log('number.check is called', reason);
  const prefs = await storage({
    'mode': 'time-based',
    'number': 6,
    'max.single.discard': 50, // max number of tabs to discard
    'period': 10 * 60, // in seconds
    'audio': true, // audio = true => do not discard if audio is playing
    'paused': false, // paused = true => do not discard if there is a paused media player
    'pinned': false, // pinned = true => do not discard if tab is pinned
    'split-view': true, // split-view = true => do not discard split tabs if either tab of the split is focused
    'battery': false, // battery = true => only discard if power is disconnected
    'online': false, // online = true => do not discard if there is no INTERNET connection
    'form': true, // form = true => do not discard if form data is changed
    'whitelist': [],
    'notification.permission': false,
    'whitelist-url': [],
    'memory-enabled': false,
    'memory-value': 60,
    'idle': false,
    'idle-timeout': 5 * 60, // in seconds
    'exclude-active': true,
    'icon-update': false
  });

  Object.assign(prefs, await storage({
    'whitelist.session': []
  }, 'session'));

  Object.assign(prefs, ops);

  // only check if idle
  if (prefs.idle) {
    const state = await new Promise(resolve => chrome.idle.queryState(prefs['idle-timeout'], resolve));
    if (state !== chrome.idle.IdleState.IDLE) {
      log('discarding is skipped', 'not in the idle state');
      return targeted ? protectAll('targeted discard requires the configured idle state') : undefined;
    }
  }
  // only check if on battery
  if (prefs.battery && navigator.getBattery) {
    const charging = await navigator.getBattery().then(b => b.charging === true || b.chargingTime !== Infinity);
    if (charging) {
      log('discarding is skipped', 'Power is plugged-in');
      return targeted ? protectAll('targeted discard is disabled while external power is connected') : undefined;
    }
  }
  // only check if INTERNET is connected
  if (prefs.online && navigator.onLine === false) {
    log('discarding is skipped', 'No INTERNET connection detected');
    return targeted ? protectAll('targeted discard is disabled while the browser is offline') : undefined;
  }

  // get the total number of active tabs
  const options = {
    url: '*://*/*',
    discarded: false,
    windowType: 'normal'
    // we need to update the icon for not-discardable tabs. So do not exclude them
    // autoDiscardable: true
  };
  // we may run "number.check" to update the icon of the active tab. The active tab is ignored anyway
  if (prefs['exclude-active']) {
    options.active = false;
  }
  if (prefs.pinned) {
    options.pinned = false;
  }
  if (prefs.audio) {
    options.audible = false;
  }
  let tbs;
  if (targeted) {
    try {
      // `url: '*://*/*'` is an automatic renderer scan optimization. It is
      // not a valid explicit-command scope: Chromium silently omits file,
      // data, internal, extension, and other restricted targets from it.
      const live = await query({});
      const byId = new Map(live.map(tab => [tab.id, tab]));
      tbs = targetedInputs.flatMap(original => {
        const current = byId.get(original.id);
        if (!current) {
          classify('unsupported', original, 'target tab is no longer available');
          return [];
        }
        // Preserve caller-visible fields when Chrome withholds a restricted
        // URL, while preferring every authoritative field it did return.
        return [{...original, ...current}];
      });
    }
    catch (error) {
      const failure = `targeted tab query failed: ${error?.message || String(error)}`;
      for (const tab of targetedInputs) {
        classify('unsupported', tab, failure);
      }
      return finalizeTargeted(emptyResult());
    }

    tbs = tbs.filter(tab => {
      if (tab.discarded === true) {
        classify('protected', tab, 'tab is already discarded');
        return false;
      }
      if (prefs['exclude-active'] && tab.active === true) {
        classify('protected', tab, 'active-tab protection is enabled');
        return false;
      }
      if (prefs.pinned && tab.pinned === true) {
        classify('protected', tab, 'pinned-tab protection is enabled');
        return false;
      }
      if (prefs.audio && tab.audible === true) {
        classify('protected', tab, 'tab is audible');
        return false;
      }
      const fallback = markerFallback(tab);
      if (fallback.kind === 'physical-only') {
        classify('protected', tab,
          `${fallback.reason}; normal targeted metadata discard requires a renderer`);
        return false;
      }
      if (fallback.kind === 'unsupported') {
        classify('unsupported', tab, fallback.reason);
        return false;
      }
      return true;
    });
  }
  else {
    tbs = await query(options);
  }

  const icon = (tb, title) => {
    chrome.action.setTitle({
      tabId: tb.id,
      title
    }, () => chrome.runtime.lastError);
    chrome.action.setIcon({
      tabId: tb.id,
      path: {
        '16': '/data/icons/disabled/16.png',
        '32': '/data/icons/disabled/32.png'
      }
    });
  };
  icon.reset = tb => {
    chrome.action.setTitle({
      tabId: tb.id,
      title: chrome.runtime.getManifest().name
    }, () => chrome.runtime.lastError);
    chrome.action.setIcon({
      tabId: tb.id,
      path: {
        '16': '/data/icons/16.png',
        '32': '/data/icons/32.png'
      }
    });
  };
  let exceptionCount = 0;

  // An accepted Edge direct discard can be observed briefly as an inactive,
  // loaded-looking tab. Consult the durable native intent before any plug-in
  // or frame metadata code can inject into that renderer. Errors fail closed:
  // automatic scans skip it and targeted scans report a protected no-op.
  const nativeIntentChecks = await Promise.all(tbs.map(async tab => ({
    blocked: await ownership.hasBlockingNativeIntent(tab.id).catch(() => true),
    tab
  })));
  tbs = nativeIntentChecks.filter(entry => {
    if (!entry.blocked) {
      return true;
    }
    const reason = 'direct native discard is still settling; renderer scan was skipped';
    icon(entry.tab, reason);
    classify('protected', entry.tab, reason);
    exceptionCount += 1;
    return false;
  }).map(entry => entry.tab);

  // remove tabs based on custom filters
  for (const [name, {prepare, check}] of Object.entries(pluginFilters)) {
    try {
      await prepare();
    }
    catch (error) {
      if (!targeted) {
        throw error;
      }
      for (const tab of tbs) {
        classify('unsupported', tab,
          `plug-in filter ${name} could not prepare: ${error?.message || String(error)}`);
      }
      tbs = [];
      break;
    }
    if (!targeted) {
      tbs = tbs.filter(check);
      continue;
    }
    tbs = tbs.filter(tab => {
      try {
        const accepted = Boolean(check(tab));
        if (!accepted) {
          classify('protected', tab, `tab was excluded by plug-in filter ${name}`);
        }
        return accepted;
      }
      catch (error) {
        classify('unsupported', tab,
          `plug-in filter ${name} failed: ${error?.message || String(error)}`);
        return false;
      }
    });
  }
  // remove tabs that match one of the matching lists

  if (
    prefs['whitelist'].length ||
    prefs['whitelist.session'].length ||
    (prefs.mode === 'url-based' && prefs['whitelist-url'].length)
  ) {
    tbs = tbs.filter(tb => {
      try {
        const {hostname} = new URL(tb.url);

        const m = list => match(list, hostname, tb.url);
        // if we are on url-based mode, remove tabs that are not on the list (before fetching meta)
        if (prefs.mode === 'url-based' && m(prefs['whitelist-url']) !== true) {
          icon(tb, 'tab is in the whitelist');
          log('number.check', 'tab is ignored', 'url-based whitelist', tb.url);
          exceptionCount += 1;
          classify('protected', tb, 'tab URL does not match the URL-based allowlist');
          return false;
        }
        // is the tab in whitelist, remove it (before fetching meta)
        if (m(prefs['whitelist']) || m(prefs['whitelist.session'])) {
          icon(tb, 'tab is in either the session whitelist or permanent whitelist');
          log('number.check', 'tab is ignored', 'whitelist', tb.url);
          exceptionCount += 1;
          classify('protected', tb, 'tab URL is protected by the session or permanent whitelist');
          return false;
        }
        return true;
      }
      catch (e) {
        classify('unsupported', tb,
          `tab URL could not be evaluated for whitelist protection: ${e?.message || String(e)}`);
        return false;
      }
    });
  }
  // do not discard a split tab if either tab of the split is focused
  if (prefs['split-view']) {
    // Tab.active means selected inside its own window; it does not mean that
    // window has focus. Restrict this protection to the user's focused window
    // so background split views do not become permanently undiscardable.
    let focused;
    try {
      focused = await query({active: true, lastFocusedWindow: true});
    }
    catch (error) {
      if (!targeted) {
        throw error;
      }
      for (const tab of tbs) {
        classify('unsupported', tab,
          `focused split-view state could not be queried: ${error?.message || String(error)}`);
      }
      tbs = [];
      focused = [];
    }
    const ids = new Set(focused.map(t => t.splitViewId).filter(id => id >= 0));
    if (ids.size) {
      tbs = tbs.filter(tb => {
        if (ids.has(tb.splitViewId)) {
          icon(tb, 'tab is part of a focused split view');
          log('number.check', 'tab is ignored', 'split view is focused', tb.url);
          exceptionCount += 1;
          classify('protected', tb, 'tab is part of a focused split view');
          return false;
        }
        return true;
      });
    }
  }
  if (!targeted && filterTabsFrom && filterTabsFrom.length) {
    const ids = filterTabsFrom.map(t => t.id);
    tbs = tbs.filter(tb => ids.includes(tb.id));
  }

  const now = Date.now();
  const frozen = partitionFrozenTabs(tbs, prefs, ops, now);
  for (const entry of frozen.protected) {
    icon(entry.tab, entry.reason);
    log('number.check', 'frozen tab is protected', entry.reason, entry.tab.url);
    classify('protected', entry.tab, entry.reason);
  }
  exceptionCount += frozen.protected.length;

  // do not discard if number of tabs is smaller than required
  if (prefs['icon-update'] === false) {
    if (frozen.renderer.length + frozen.eligible.length + exceptionCount <= prefs.number) {
      log(
        'number.check', 'total number of active tabs', tbs.length,
        ' + ignored tabs', exceptionCount,
        'is equal or smaller than', prefs.number
      );
      for (const tab of frozen.renderer) {
        classify('protected', tab,
          `configured tab-count floor (${prefs.number}) prevents this targeted discard`);
      }
      for (const entry of frozen.eligible) {
        classify('protected', entry.tab,
          `configured tab-count floor (${prefs.number}) prevents this targeted discard`);
      }
      return finalizeTargeted({
        candidates: 0,
        discarded: [],
        failed: [],
        forced: [],
        frozen: {
          eligible: frozen.eligible.map(entry => entry.tab.id),
          protected: frozen.protected.map(entry => ({
            id: entry.tab.id,
            reason: entry.reason
          })),
          attempted: [],
          failed: []
        },
        scan: {
          completed: 0,
          failed: [],
          skipped: [],
          timedOut: false,
          total: 0
        },
        succeeded: []
      });
    }
  }

  const scan = await runBoundedScan(frozen.renderer, tb => {
    if (tb.status === 'unloaded') {
      return [];
    }

    // The permanent watcher and top metadata probe stay top-frame-only. A
    // bounded collector touches subframes only when form/media protections need
    // aggregate state, caps its output, and tolerates frame churn.
    return discard.withRendererGuard(tb.id, async () => {
      if (await ownership.hasBlockingNativeIntent(tb.id).catch(() => true)) {
        const error = Error('direct native discard is still settling');
        error.code = 'DISCARD_OPERATION_BLOCKED';
        throw error;
      }
      return frameMetadata.collect(tb.id, prefs);
    });
  }, {
    concurrency: METADATA_SCAN_CONCURRENCY,
    timeout: METADATA_SCAN_TIMEOUT
  });

  if (scan.failed.length) {
    exceptionCount += scan.failed.length;
    for (const {error, item} of scan.failed) {
      console.warn(error);
      const blocked = error?.code === 'DISCARD_OPERATION_BLOCKED';
      classify(blocked ? 'protected' : 'unsupported', item,
        blocked ? 'a discard transaction already owns this tab; renderer scan was skipped' :
          `renderer metadata scan failed: ${error?.message || String(error)}`);
    }
  }
  if (scan.skipped.length) {
    exceptionCount += scan.skipped.length;
    log(
      'number.check',
      'metadata scan deadline reached',
      'skipped tabs',
      scan.skipped.length
    );
    for (const {item} of scan.skipped) {
      classify('unsupported', item,
        'renderer metadata scan deadline was reached before the tab could be inspected');
    }
  }

  const candidateById = new Map(frozen.eligible.map(entry => [entry.tab.id, {
    kind: 'takeover',
    tab: entry.tab,
    time: entry.time
  }]));
  const forcedRecovery = new Set();
  const failed = [];
  const forced = [];
  const successful = [];
  for (const entry of scan.completed) {
    const tb = entry.item;
    try {
      const ms = entry.value;

      // remove protected tabs (e.g. addons.mozilla.org)
      if (targeted && (!Array.isArray(ms) || ms.length === 0)) {
        const detail = tb.status === 'unloaded' ?
          'renderer metadata is unavailable while the tab is unloaded' :
          'renderer metadata returned no inspectable document';
        classify('unsupported', tb, detail);
        exceptionCount += 1;
        continue;
      }
      if (ms.length === 0) {
        if (ops['ignore.meta.data'] === true && tb.url.startsWith('http') !== true) {
          log('discarding aborted', 'metadata fetch error', tb.url);
          icon(tb, 'metadata fetch error');
          exceptionCount += 1;
          continue;
        }
      }
      const meta = Object.assign({}, ...ms);
      log('number check', 'got meta data of tab');
      meta.forms = ms.some(o => o && o.forms);
      meta.audible = ms.some(o => o && o.audible);
      meta.paused = ms.some(o => o && o.paused);

      // is the tab using too much memory, discard instantly
      if (prefs['memory-enabled'] && meta.memory && meta.memory > prefs['memory-value'] * 1024 * 1024) {
        if (recoveryIds instanceof Set) {
          // The normal automatic path executes this before ready/media/form,
          // count-floor, and per-scan-limit checks. Record the same forced
          // decision without crossing the native boundary during recovery.
          forcedRecovery.add(tb.id);
          continue;
        }
        log('forced discarding', 'memory usage');
        const [result] = await runDiscardCandidates([{
          kind: 'discard',
          tab: tb,
          time: meta.time
        }], {
          discard,
          takeover: () => false
        });
        const outcome = loadedDiscardOutcomes([result]);
        if (outcome.succeeded.length) {
          forced.push(tb.id);
        }
        successful.push(...outcome.succeeded);
        failed.push(...outcome.failed);
        continue;
      }
      // is this tab loaded
      if (meta.ready !== true && ops['ignore.ready.state'] !== true) {
        log('discarding aborted', 'tab is not ready', tb);
        exceptionCount += 1;
        classify('protected', tb, 'tab document is not ready for discard');
        continue;
      }
      // is tab playing audio
      if (prefs.audio && meta.audible) {
        log('discarding aborted', 'audio is playing', tb);
        icon(tb, 'tab plays an audio');
        exceptionCount += 1;
        classify('protected', tb, 'tab has playing audio or Picture-in-Picture media');
        continue;
      }
      if (prefs.paused && meta.paused) {
        log('discarding aborted', 'player is paused', tb);
        icon(tb, 'tab has a paused player');
        exceptionCount += 1;
        classify('protected', tb, 'tab has a paused media player');
        continue;
      }
      // is there an unsaved form
      if (prefs.form && meta.forms) {
        log('discarding aborted', 'active form', tb);
        icon(tb, 'there is an active form on this tab');
        exceptionCount += 1;
        classify('protected', tb, 'tab has unsaved form input');
        continue;
      }
      // is notification allowed
      if (prefs['notification.permission'] && meta.permission) {
        log('discarding aborted', 'tab has notification permission');
        icon(tb, 'tab has notification permission');
        exceptionCount += 1;
        classify('protected', tb, 'tab has notification permission');
        continue;
      }
      if (tb.autoDiscardable === false) {
        log('discarding aborted', 'tab is not discardable', tb);
        exceptionCount += 1;
        icon(tb, 'tab is not discardable');
        classify('protected', tb, 'tab is not automatically discardable');
        continue;
      }
      // check tab's age
      if ((now - meta.time) < prefs.period * 1000) {
        log('discarding aborted', 'tab is not old', tb);
        exceptionCount += 1;
        // in case the icon is blue because of a condition that met before
        icon.reset(tb);
        classify('protected', tb,
          `tab is younger than the configured discard age (${prefs.period} seconds)`);
        continue;
      }
      // in case the tab is not excluded by the initial query
      if (tb.active) {
        log('discarding aborted', 'tab is active', tb);
        exceptionCount += 1;
        icon.reset(tb);
        classify('protected', tb, 'tab became active before discard');
        continue;
      }
      candidateById.set(tb.id, {
        kind: 'discard',
        tab: tb,
        time: meta.time
      });
    }
    catch (e) {
      console.warn(e);
      classify('unsupported', tb,
        `renderer metadata could not be evaluated: ${e?.message || String(e)}`);
    }
  }
  // Restore the original query order before stable age sorting. Completion
  // order and the frozen/renderer partition must never decide a timestamp tie.
  const arr = tbs.map(tab => candidateById.get(tab.id)).filter(Boolean);
  // do not discard if number of tabs is smaller than required
  if (prefs['icon-update'] === true) {
    if (arr.length + exceptionCount <= prefs.number) {
      log(
        'number.check', 'total number of active tabs', arr.length,
        ' + ignored tabs', exceptionCount,
        'is equal or smaller than', prefs.number
      );
      for (const candidate of arr) {
        classify('protected', candidate.tab,
          `configured tab-count floor (${prefs.number}) prevents this targeted discard`);
      }
      if (recoveryIds instanceof Set) {
        return new Set([...forcedRecovery].filter(id => recoveryIds.has(id)));
      }
      return finalizeTargeted({
        candidates: arr.length,
        discarded: [],
        failed,
        forced,
        frozen: {
          eligible: frozen.eligible.map(entry => entry.tab.id),
          protected: frozen.protected.map(entry => ({
            id: entry.tab.id,
            reason: entry.reason
          })),
          attempted: [],
          failed: []
        },
        scan: {
          completed: scan.completed.length,
          failed: scan.failed.map(entry => entry.item.id),
          skipped: scan.skipped.map(entry => entry.item.id),
          timedOut: scan.timedOut,
          total: scan.total
        },
        succeeded: successful
      });
    }
  }

  // ready to discard
  log('number check', 'tabs that are ignored', exceptionCount);
  log('number check', 'possible tabs that could get discarded', arr.length);
  const maximum = Number(prefs['max.single.discard']);
  const limit = Math.min(
    arr.length,
    Math.max(0, arr.length + exceptionCount - prefs.number),
    Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : arr.length
  );
  const candidates = selectOldest(arr, candidate => candidate.time, limit);
  if (recoveryIds instanceof Set) {
    // Worker-restart recovery asks the complete current automatic policy and
    // metadata pipeline which of its durable ordinary intents would be chosen
    // now. It must never cross the native boundary while answering.
    return new Set([
      ...[...forcedRecovery].filter(id => recoveryIds.has(id)),
      ...candidates.map(candidate => candidate.tab.id).filter(id => recoveryIds.has(id))
    ]);
  }
  if (targeted && candidates.length < arr.length) {
    const selected = new Set(candidates.map(candidate => candidate.tab.id));
    const maximumLabel = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 'unlimited';
    for (const candidate of arr) {
      if (!selected.has(candidate.tab.id)) {
        classify('protected', candidate.tab,
          `targeted discard limit retained this tab (selected ${limit} of ${arr.length}; ` +
          `tab-count floor ${prefs.number}; per-scan maximum ${maximumLabel})`);
      }
    }
  }

  log('number check', 'discarding', candidates.length);
  const settled = await runDiscardCandidates(candidates, {
    discard,
    takeover: tab => discard.takeover({...tab, windowType: 'normal'})
  });
  for (const result of settled) {
    if (result.error) {
      console.warn(result.error);
      log(
        'number.check',
        result.kind === 'takeover' ? 'automatic frozen takeover failed' : 'automatic discard failed',
        result.tab.id
      );
    }
  }
  const succeeded = settled.filter(result => result.success);
  const loaded = loadedDiscardOutcomes(settled);
  successful.push(...loaded.succeeded);
  failed.push(...loaded.failed);
  const takeoverResults = settled.filter(result => result.kind === 'takeover');
  if (targeted) {
    for (const result of takeoverResults) {
      if (result.success) {
        successful.push({tab: result.tab});
      }
      else {
        failed.push({
          failureCause: failureCauseFrom(
            result.error || result.value,
            FAILURE_CAUSES.TAKEOVER_FAILED
          ),
          tab: result.tab,
          reason: result.error ?
            `frozen takeover failed: ${result.error.message || String(result.error)}` :
            result.value?.reason || 'frozen takeover was rejected'
        });
      }
    }
  }
  return finalizeTargeted({
    candidates: arr.length,
    discarded: succeeded.map(result => result.tab.id),
    failed,
    forced,
    frozen: {
      eligible: frozen.eligible.map(entry => entry.tab.id),
      protected: frozen.protected.map(entry => ({
        id: entry.tab.id,
        reason: entry.reason
      })),
      attempted: takeoverResults.map(result => result.tab.id),
      failed: takeoverResults.filter(result => result.success === false).map(result => ({
        id: result.tab.id,
        error: result.error?.message || (result.value === false ? 'takeover rejected' : 'takeover failed')
      }))
    },
    scan: {
      completed: scan.completed.length,
      failed: scan.failed.map(entry => entry.item.id),
      skipped: scan.skipped.map(entry => entry.item.id),
      timedOut: scan.timedOut,
      total: scan.total
    },
    succeeded: successful
  });
};

const checkQueue = createSingleFlightQueue(async (...args) => {
  const result = await runCheck(...args);
  number.lastScan = result;
  return result;
});

// Equivalent automatic triggers join one scan. Targeted/manual requests retain
// their own scopes and wait their turn so no two all-frame scans overlap.
number.check = (filterTabsFrom, ops, reason) => {
  const settings = ops === undefined ? {} : ops;
  const flight = checkQueue.run(
    metadataFlightKey(filterTabsFrom, ops),
    filterTabsFrom,
    settings,
    reason
  );

  if (flight.invalidated && flight.joined === false) {
    log(
      'number.check',
      'queued one fresh automatic metadata generation after an in-flight scan',
      reason,
      flight.generation
    );
  }
  else if (flight.joined) {
    log('number.check', 'joined an automatic metadata scan already in flight', reason);
  }
  return flight.promise;
};

number.revalidateOrdinaryIntents = tabs => {
  const ids = new Set((tabs || []).map(tab => tab?.id).filter(Number.isInteger));
  if (ids.size === 0) {
    return Promise.resolve(ids);
  }
  // Run one full automatic eligibility pass for the whole restart batch. The
  // private fourth argument turns the final action phase into an ID-only proof
  // and cannot be supplied through extension messages or preferences.
  // Keep restart recovery on the same FIFO as automatic and manual metadata
  // scans. It is intentionally unkeyed: it must run as one fresh generation,
  // never join a pre-existing automatic snapshot with different proof output.
  return checkQueue.run(
    undefined,
    undefined,
    {},
    'ordinary/restart-revalidation',
    ids
  ).promise.then(result => result instanceof Set ? result : new Set());
};

const alarmCatchUp = createAlarmCatchUp({
  run: reason => number.check(undefined, undefined, reason),
  storageArea: chrome.storage.local
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'number.check') {
    log('alarm fire', 'number.check', alarm.name);
    alarmCatchUp.trigger({scheduledTime: alarm.scheduledTime}, 'number/alarm').catch(error =>
      log('number alarm catch-up failed', error)
    );
  }
});
// fix outdated alarms
chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') {
    const now = Date.now();
    chrome.alarms.getAll(alarms => {
      for (const o of alarms) {
        if (o.scheduledTime < now) {
          chrome.alarms.create(o.name, {
            when: now + Math.round(Math.random() * 10000),
            periodInMinutes: o.periodInMinutes
          });
        }
      }
    });
  }
});

/* start */
{
  const check = async (resume = false) => storage({
    'mode': 'time-based',
    'period': 10 * 60, // in seconds
    'tmp_disable': 0
  }).then(async ps => {
    if (
      ps.period &&
      (ps.mode === 'time-based' || ps.mode === 'url-based') &&
      ps['tmp_disable'] === 0
    ) {
      await number.install(ps.period);
      if (resume) {
        return alarmCatchUp.resume(ps.period * 1000, 'number/resume');
      }
    }
    else {
      return number.remove();
    }
  });
  starters.push(() => check(true).catch(error =>
    log('number startup/catch-up failed', error)
  ));
  chrome.storage.onChanged.addListener(ps => {
    if (ps.period || ps.mode || ps['tmp_disable']) {
      check();
    }
  });
}

/* inject to existing tabs */
starters.push(() => chrome.app && query({
  url: '*://*/*',
  discarded: false
}).then(tbs => {
  const contentScripts = chrome.app.getDetails().content_scripts;
  for (const tab of tbs) {
    for (const cs of contentScripts) {
      // Legacy Chrome-app reinjection obeys the same transaction exclusion as
      // automatic metadata. A loaded-looking Edge replacement must never be
      // scripted while its direct native discard is still settling.
      void discard.withRendererGuard(tab.id, async () => {
        if (await ownership.hasBlockingNativeIntent(tab.id).catch(() => true)) {
          return false;
        }
        return ownership.withNativeMutationGuard(() => chrome.scripting.executeScript({
          target: {
            tabId: tab.id
          },
          files: cs.js
        }), tab.id);
      }).catch(() => false);
    }
  }
}));

/* temporarily disable auto discarding */
{
  const exit = () => {
    chrome.action.setIcon({
      path: {
        '16': '/data/icons/tmp/' + '/16.png',
        '32': '/data/icons/tmp/' + '/32.png'
      }
    });
    chrome.action.setTitle({
      title: chrome.i18n.getMessage('bg_msg_2')
    });
  };
  chrome.storage.onChanged.addListener(ps => {
    if (ps['tmp_disable']) {
      if (ps['tmp_disable'].newValue !== 0) {
        chrome.alarms.create('tmp.disable', {
          when: Date.now() + ps['tmp_disable'].newValue * 60 * 60 * 1000
          // when: Date.now() + 120 * 1000
        });
        exit();
      }
      else {
        chrome.alarms.clear('tmp.disable');
        chrome.action.setIcon({
          path: {
            '16': '/data/icons/16.png',
            '32': '/data/icons/32.png'
          }
        });
        chrome.action.setTitle({
          title: chrome.runtime.getManifest().name
        });
      }
    }
  });
  starters.push(() => storage({
    'tmp_disable': 0
  }).then(ps => {
    if (ps['tmp_disable']) {
      // verify timer is installed
      chrome.alarms.get('tmp.disable', a => {
        if (a) {
          exit();
        }
        else {
          console.info('tmp timer is not present. Re-enabling the numbered module');
          chrome.storage.local.set({
            'tmp_disable': 0
          });
        }
      });
    }
  }));

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'tmp.disable') {
      chrome.storage.local.set({
        'tmp_disable': 0
      });
    }
  });
}

export {pluginFilters, number};
