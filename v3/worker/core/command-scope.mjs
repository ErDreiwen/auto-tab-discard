const CURRENT_WINDOW_COMMANDS = new Set([
  'discard-window',
  'discard-rights',
  'discard-lefts',
  'release-window',
  'release-rights',
  'release-lefts'
]);
const OTHER_WINDOW_COMMANDS = new Set([
  'discard-other-windows',
  'release-other-windows'
]);
const DISCARD_COMMANDS = new Set([
  'discard-tab',
  'discard-tree',
  'discard-window',
  'discard-rights',
  'discard-lefts',
  'discard-other-windows',
  'discard-tabs'
]);
const releaseCommands = Object.freeze([
  'release-window',
  'release-rights',
  'release-lefts',
  'release-other-windows',
  'release-tabs'
]);
const RELEASE_COMMANDS = new Set(releaseCommands);

const scopeQuery = command => {
  const options = {
    url: '*://*/*',
    active: false
  };
  if (CURRENT_WINDOW_COMMANDS.has(command)) {
    options.currentWindow = true;
  }
  else if (OTHER_WINDOW_COMMANDS.has(command)) {
    options.currentWindow = false;
  }
  return options;
};

const filterScopeTabs = (command, tabs, selected) => {
  if (command.endsWith('lefts')) {
    return tabs.filter(tab => tab.index < selected.index);
  }
  if (command.endsWith('rights')) {
    return tabs.filter(tab => tab.index > selected.index);
  }
  return tabs;
};

const releaseAvailability = async (query, selected) => Object.fromEntries(await Promise.all(
  releaseCommands.map(async command => {
    if (!selected && (command.endsWith('lefts') || command.endsWith('rights'))) {
      return [command, false];
    }
    const tabs = await query(scopeQuery(command));
    return [command, filterScopeTabs(command, tabs, selected).some(tab => tab.discarded === true)];
  })
));

// A popup discard command owns both halves of its scope: loaded tabs continue
// to the normal pipeline, while normal commands adopt existing discards in
// place. Shift can physically upgrade adopted/claimed tabs through takeover.
const prepareDiscardTargets = async (command, tabs, resolveFresh, {upgradeAdopted = false} = {}) => {
  if (!DISCARD_COMMANDS.has(command)) {
    throw Error(`Unknown discard command: ${command}`);
  }

  const resolved = await Promise.all(tabs.map(async tab => {
    if (tab.discarded !== true) {
      return {state: 'loaded', tab};
    }
    try {
      return await resolveFresh(tab);
    }
    catch (error) {
      // One failed ownership write must not prevent loaded targets elsewhere in
      // the command scope from continuing through the discard pipeline.
      return {error, state: 'discarded', tab};
    }
  }));
  const candidates = resolved.filter(result => result?.state === 'loaded').map(result => result.tab);
  const discarded = resolved.filter(result => result?.state === 'discarded');
  const alreadyOwned = discarded
    .filter(result => result.marker?.state === 'owned' &&
      (result.marker.source === 'self' || (result.marker.source === 'adopted' && upgradeAdopted === false)))
    .map(result => result.tab);
  const takeovers = discarded
    .filter(result => result.marker?.state !== 'owned' ||
      (result.marker.source !== 'self' &&
        (result.marker.source !== 'adopted' || upgradeAdopted === true)))
    .map(result => result.tab);
  const errors = resolved.filter(result => result?.error).map(result => result.error);
  return {alreadyOwned, candidates, errors, takeovers};
};

const runTakeovers = async (tabs, takeover) => {
  if (tabs.length === 0) {
    return [];
  }
  const settled = await Promise.allSettled(tabs.map(tab => takeover(tab)));
  const failed = settled.filter(result => result.status === 'rejected' || result.value !== true);
  if (failed.length) {
    const reasons = failed.map(result => result.status === 'rejected' ?
      result.reason?.message || String(result.reason) : 'takeover returned false');
    throw Error(`one or more discard takeovers failed: ${reasons.join('; ')}`);
  }
  return settled.map(result => result.value);
};

// Adoption normally completes without touching the tab. If the tab woke in
// the narrow gap after classification, return it to the loaded-tab pipeline
// instead of reporting a false failure or leaving it awake.
const runAdoptions = async (tabs, adopt, resolveFresh, waitForTakeover) => {
  if (tabs.length === 0) {
    return {adopted: [], loaded: []};
  }
  const settled = await Promise.allSettled(tabs.map(async tab => {
    let fallbackDeadline;
    const joinedJobs = new Set();
    const joinTakeover = async () => {
      const job = waitForTakeover?.(tab.id);
      if (!job || joinedJobs.has(job)) {
        return false;
      }
      joinedJobs.add(job);
      try {
        await job;
      }
      catch (e) {
        // Re-read after a failed physical takeover. The tab may still be
        // discarded and safe to adopt, or it may have woken and need the
        // ordinary loaded-tab pipeline.
      }
      return true;
    };

    while (true) {
      // A Shift takeover can be queued before its ownership attempt starts.
      // Join the actual job instead of guessing how long its reload/native
      // discard fences may take.
      if (await joinTakeover()) {
        continue;
      }
      const outcome = await adopt(tab);
      if (outcome === true) {
        return {state: 'adopted', tab};
      }
      if (outcome?.state === 'loaded') {
        return {state: 'loaded', tab: outcome.tab};
      }
      if (outcome?.state === 'missing') {
        throw Error(`discarded tab ${tab.id} disappeared during adoption`);
      }
      if (outcome?.busy === true || outcome?.retry === true) {
        if (await joinTakeover()) {
          continue;
        }
        // A non-takeover discard has a much shorter bounded native path. Keep
        // a fallback so an abandoned ordinary attempt cannot hang the popup.
        fallbackDeadline ||= Date.now() + 16000;
        if (Date.now() >= fallbackDeadline) {
          throw Error(`timed out waiting to adopt discarded tab ${tab.id}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const fresh = await resolveFresh(tab);
      if (fresh?.state === 'loaded') {
        return {state: 'loaded', tab: fresh.tab};
      }
      if (fresh?.state === 'discarded' && fresh.marker?.state === 'owned' &&
          (fresh.marker.source === 'self' || fresh.marker.source === 'adopted')) {
        return {state: 'adopted', tab: fresh.tab};
      }
      throw Error(`could not adopt discarded tab ${tab.id}`);
    }
  }));
  if (settled.some(result => result.status === 'rejected')) {
    throw Error('one or more discard adoptions failed');
  }
  const values = settled.map(result => result.value);
  return {
    adopted: values.filter(result => result.state === 'adopted').map(result => result.tab),
    loaded: values.filter(result => result.state === 'loaded').map(result => result.tab)
  };
};

// The selected-tab and tab-group rows need an active keeper before Chromium
// permits their active target to be discarded. Keeping this path here makes
// the first two popup commands exercise the same tested ownership preparation.
const runDirectDiscardCommand = async ({
  activate,
  adopt,
  allTabs,
  command,
  discard,
  inProgress,
  notifyNoKeeper,
  resolveFresh,
  selected,
  shiftKey,
  takeover,
  targets,
  waitForTakeover
}) => {
  const result = await prepareDiscardTargets(command, targets, resolveFresh, {
    upgradeAdopted: shiftKey === true
  });
  if (shiftKey !== true) {
    const adoption = await runAdoptions(result.takeovers, adopt, resolveFresh, waitForTakeover);
    result.adopted = adoption.adopted;
    result.candidates.push(...adoption.loaded);
  }
  else {
    result.adopted = [];
  }
  let keeper;

  if (result.candidates.some(tab => tab.active)) {
    const ids = new Set(targets.map(tab => tab.id));
    keeper = allTabs
      .filter(tab => tab.discarded === false && tab.highlighted === false && tab.status !== 'unloaded' &&
        ids.has(tab.id) === false && inProgress(tab.id) === false)
      .sort((a, b) => Math.abs(a.index - selected.index) - Math.abs(b.index - selected.index))[0];

    if (!keeper) {
      notifyNoKeeper();
      if (shiftKey === true) {
        await runTakeovers(result.takeovers, takeover);
      }
      return {...result, blocked: true, keeper: null};
    }
    await activate(keeper);
    result.candidates.forEach(tab => tab.active = false);
  }

  await Promise.all([
    ...result.candidates.map(discard),
    shiftKey === true ? runTakeovers(result.takeovers, takeover) : Promise.resolve([])
  ]);
  return {...result, blocked: false, keeper};
};

// Chromium's discarded:false event is the authoritative ownership cleanup.
// Clearing immediately after reload() could erase a newer concurrent discard.
const releaseDiscardedTargets = async (
  command,
  tabs,
  reload,
  options = {},
  cancelTakeover = async () => {},
  refresh = async tab => tab
) => {
  if (!RELEASE_COMMANDS.has(command)) {
    throw Error(`Unknown release command: ${command}`);
  }
  // A takeover's wake phase is discarded:false, so cancel every tab in the
  // selected release scope before deciding which live tabs still need reload.
  await Promise.all(tabs.map(cancelTakeover));
  const live = await Promise.all(tabs.map(refresh));
  const targets = live.filter(tab => tab?.discarded === true);
  await Promise.all(targets.map(tab => reload(tab, options)));
  return targets;
};

// This is the shared execution path for all five bulk rows and their X controls.
// Tests exercise this same function, not a parallel reconstruction of menu.mjs.
const runScopedCommand = async ({
  adopt,
  cancelTakeover,
  check,
  command,
  discard,
  query,
  refresh,
  reload,
  resolveFresh,
  selected,
  shiftKey,
  takeover,
  waitForTakeover
}) => {
  const queried = await query(scopeQuery(command));
  const tabs = filterScopeTabs(command, queried, selected);

  if (DISCARD_COMMANDS.has(command)) {
    const result = await prepareDiscardTargets(command, tabs, resolveFresh, {
      upgradeAdopted: shiftKey === true
    });
    if (shiftKey) {
      await Promise.all([
        runTakeovers(result.takeovers, takeover),
        ...result.candidates.map(discard)
      ]);
    }
    else {
      const adoption = await runAdoptions(result.takeovers, adopt, resolveFresh, waitForTakeover);
      result.adopted = adoption.adopted;
      result.candidates.push(...adoption.loaded);
      if (result.candidates.length) {
        await check(result.candidates);
      }
    }
    return result;
  }
  if (RELEASE_COMMANDS.has(command)) {
    return {
      released: await releaseDiscardedTargets(
        command,
        tabs,
        reload,
        {bypassCache: shiftKey === true},
        cancelTakeover,
        refresh
      )
    };
  }
  throw Error(`Unknown scoped command: ${command}`);
};

export {
  filterScopeTabs,
  prepareDiscardTargets,
  releaseAvailability,
  releaseCommands,
  releaseDiscardedTargets,
  runDirectDiscardCommand,
  runScopedCommand,
  scopeQuery
};
