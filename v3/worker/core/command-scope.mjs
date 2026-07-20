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

// A manual discard command owns both halves of its scope: loaded tabs continue
// to the normal pipeline, while tabs suspended by another mechanism are
// physically taken over. A bookkeeping-only adoption cannot apply the portable
// title/favicon marker because an unloaded document has no renderer to update.
const prepareDiscardTargets = async (command, tabs, resolveFresh) => {
  if (!DISCARD_COMMANDS.has(command)) {
    throw Error(`Unknown discard command: ${command}`);
  }

  const resolved = await Promise.all(tabs.map(async tab => {
    // Edge Sleeping Tabs are frozen while still memory-loaded. Treat that as an
    // existing suspension, not as an ordinary loaded candidate: the controlled
    // takeover wakes it once, applies our marker, then performs the native
    // discard. Missing `frozen` remains compatible with older Chromium builds.
    if (tab.discarded !== true && tab.frozen === true) {
      return {state: 'frozen', tab};
    }
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
    .filter(result => result.marker?.state === 'owned' && result.marker.source === 'self')
    .map(result => result.tab);
  const takeovers = resolved.filter(result => result?.state === 'frozen').map(result => result.tab);
  takeovers.push(...discarded
    .filter(result => result.marker?.state !== 'owned' ||
      result.marker.source !== 'self')
    .map(result => result.tab));
  const errors = resolved.filter(result => result?.error).map(result => result.error);
  return {alreadyOwned, candidates, errors, takeovers};
};

const CHANGED_TAKEOVER_TARGET = /\bis no longer an inactive takeover target\b/;
const runTakeovers = async (tabs, takeover, {
  onAwake = async () => {},
  onSkipped = async () => {},
  refresh = async tab => tab
} = {}) => {
  if (tabs.length === 0) {
    return [];
  }
  const settled = await Promise.allSettled(tabs.map(async tab => {
    try {
      return await takeover(tab);
    }
    catch (error) {
      // A takeover can wait behind another queued job after the preflight read.
      // Its first authoritative read reports this exact condition before it has
      // woken or modified the tab, so it is safe to route the now-loaded target
      // back through the command's normal/forced loaded behavior.
      if (CHANGED_TAKEOVER_TARGET.test(error?.message || String(error))) {
        const current = await refresh(tab);
        if (!current) {
          await onSkipped(current, tab);
          return true;
        }
        if (current.discarded !== true && current.frozen !== true) {
          if (current.active === true) {
            await onSkipped(current, tab);
            return true;
          }
          await onAwake(current, tab);
          return true;
        }
      }
      throw error;
    }
  }));
  const failed = settled.filter(result => result.status === 'rejected' || result.value !== true);
  if (failed.length) {
    const reasons = failed.map(result => result.status === 'rejected' ?
      result.reason?.message || String(result.reason) : 'takeover returned false');
    throw Error(`one or more discard takeovers failed: ${reasons.join('; ')}`);
  }
  return settled.map(result => result.value);
};

// A tab can wake after the ownership snapshot was prepared but before its
// queued takeover begins. Take one final live read at the scope boundary so an
// already-awake tab returns to the command's ordinary loaded path instead of
// turning a benign lifecycle race into a failed popup command. Frozen tabs are
// still suspended and must remain on the controlled Edge takeover path.
const refreshTakeoverTargets = async (result, refresh = async tab => tab) => {
  if (result.takeovers.length === 0) {
    return result;
  }
  const refreshed = await Promise.all(result.takeovers.map(async tab => {
    try {
      const current = await refresh(tab);
      if (!current) {
        return {state: 'missing', tab};
      }
      if (current.discarded !== true && current.frozen !== true) {
        if (current.active === true) {
          return {state: 'active', tab: current};
        }
        return {state: 'loaded', tab: current};
      }
      return {state: 'takeover', tab: current};
    }
    catch (error) {
      // Preserve the original takeover behavior on a transient refresh error;
      // its own authoritative live read still decides whether it can proceed.
      result.errors.push(error);
      return {state: 'takeover', tab};
    }
  }));

  result.candidates.push(...refreshed
    .filter(entry => entry.state === 'loaded')
    .map(entry => entry.tab));
  result.takeovers = refreshed
    .filter(entry => entry.state === 'takeover')
    .map(entry => entry.tab);
  result.missing = [
    ...(result.missing || []),
    ...refreshed.filter(entry => entry.state === 'missing').map(entry => entry.tab)
  ];
  result.skipped = [
    ...(result.skipped || []),
    ...refreshed.filter(entry => entry.state === 'active').map(entry => entry.tab)
  ];
  return result;
};

const recordSkippedTakeover = (result, current, original) => {
  result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
  const target = current || original;
  const key = current ? 'skipped' : 'missing';
  result[key] ||= [];
  if (result[key].some(candidate => candidate.id === target.id) === false) {
    result[key].push(target);
  }
};

// The selected-tab and tab-group rows need an active keeper before Chromium
// permits their active target to be discarded. Keeping this path here makes
// the first two popup commands exercise the same tested ownership preparation.
const runDirectDiscardCommand = async ({
  activate,
  allTabs,
  command,
  discard,
  inProgress,
  notifyNoKeeper,
  refresh = async tab => tab,
  resolveFresh,
  selected,
  shiftKey,
  takeover,
  targets
}) => {
  const result = await prepareDiscardTargets(command, targets, resolveFresh);
  await refreshTakeoverTargets(result, refresh);
  result.adopted = [];
  let keeper;

  if ([...result.candidates, ...result.takeovers].some(tab => tab.active)) {
    const ids = new Set(targets.map(tab => tab.id));
    keeper = allTabs
      .filter(tab => tab.discarded === false && tab.frozen !== true && tab.highlighted === false &&
        tab.status !== 'unloaded' &&
        ids.has(tab.id) === false && inProgress(tab.id) === false)
      .sort((a, b) => Math.abs(a.index - selected.index) - Math.abs(b.index - selected.index))[0];

    if (!keeper) {
      notifyNoKeeper();
      await runTakeovers(result.takeovers.filter(tab => tab.active !== true), takeover, {
        onAwake: (tab, original) => {
          result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
          result.candidates.push(tab);
          return discard(tab);
        },
        onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
        refresh
      });
      return {...result, blocked: true, keeper: null};
    }
    await activate(keeper);
    [...result.candidates, ...result.takeovers].forEach(tab => tab.active = false);
  }

  await Promise.all([
    ...result.candidates.map(discard),
    runTakeovers(result.takeovers, takeover, {
      onAwake: (tab, original) => {
        result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
        result.candidates.push(tab);
        return discard(tab);
      },
      onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
      refresh
    })
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
  refresh = async tab => tab,
  refreshScope
) => {
  if (!RELEASE_COMMANDS.has(command)) {
    throw Error(`Unknown release command: ${command}`);
  }
  // A takeover's wake phase is discarded:false, so cancel every tab in the
  // selected release scope before deciding which live tabs still need reload.
  await Promise.all(tabs.map(cancelTakeover));
  // Edge may replace a tab id while cancellation is settling. Re-querying the
  // whole live scope avoids looking up a stale predecessor and silently
  // skipping its discarded successor. Direct helper callers retain the
  // per-target refresh fallback.
  const live = refreshScope ? await refreshScope() : await Promise.all(tabs.map(refresh));
  const targets = live.filter(tab => tab?.discarded === true);
  await Promise.all(targets.map(tab => reload(tab, options)));
  return targets;
};

// This is the shared execution path for all five bulk rows and their X controls.
// Tests exercise this same function, not a parallel reconstruction of menu.mjs.
const runScopedCommand = async ({
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
  takeover
}) => {
  const queried = await query(scopeQuery(command));
  const tabs = filterScopeTabs(command, queried, selected);

  if (DISCARD_COMMANDS.has(command)) {
    const result = await prepareDiscardTargets(command, tabs, resolveFresh);
    await refreshTakeoverTargets(result, refresh);
    result.adopted = [];
    if (shiftKey) {
      await Promise.all([
        runTakeovers(result.takeovers, takeover, {
          onAwake: (tab, original) => {
            result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
            result.candidates.push(tab);
            return discard(tab);
          },
          onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
          refresh
        }),
        ...result.candidates.map(discard)
      ]);
    }
    else {
      const candidates = [...result.candidates];
      await Promise.all([
        runTakeovers(result.takeovers, takeover, {
          onAwake: (tab, original) => {
            result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
            result.candidates.push(tab);
            return check([tab]);
          },
          onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
          refresh
        }),
        candidates.length ? check(candidates) : Promise.resolve()
      ]);
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
        refresh,
        async () => filterScopeTabs(command, await query(scopeQuery(command)), selected)
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
