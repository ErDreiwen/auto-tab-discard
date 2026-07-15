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

// A popup discard command owns both halves of its scope: tabs that are already
// discarded are claimed in place, while loaded tabs continue to the normal
// eligibility/discard pipeline and receive a pending/self tag there.
const prepareDiscardTargets = async (command, tabs, resolveFresh) => {
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
  const claimed = resolved.filter(result => result?.state === 'discarded').map(result => result.tab);
  const errors = resolved.filter(result => result?.error).map(result => result.error);
  return {candidates, claimed, errors};
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
  resolveFresh,
  selected,
  targets
}) => {
  const result = await prepareDiscardTargets(command, targets, resolveFresh);
  let keeper;

  if (result.candidates.some(tab => tab.active)) {
    const ids = new Set(targets.map(tab => tab.id));
    keeper = allTabs
      .filter(tab => tab.discarded === false && tab.highlighted === false && tab.status !== 'unloaded' &&
        ids.has(tab.id) === false && inProgress(tab.id) === false)
      .sort((a, b) => Math.abs(a.index - selected.index) - Math.abs(b.index - selected.index))[0];

    if (!keeper) {
      notifyNoKeeper();
      return {...result, blocked: true, keeper: null};
    }
    await activate(keeper);
    result.candidates.forEach(tab => tab.active = false);
  }

  await Promise.all(result.candidates.map(discard));
  return {...result, blocked: false, keeper};
};

// Chromium's discarded:false event is the authoritative ownership cleanup.
// Clearing immediately after reload() could erase a newer concurrent discard.
const releaseDiscardedTargets = async (command, tabs, reload, options = {}) => {
  if (!RELEASE_COMMANDS.has(command)) {
    throw Error(`Unknown release command: ${command}`);
  }
  const targets = tabs.filter(tab => tab.discarded === true);
  await Promise.all(targets.map(tab => reload(tab, options)));
  return targets;
};

// This is the shared execution path for all five bulk rows and their X controls.
// Tests exercise this same function, not a parallel reconstruction of menu.mjs.
const runScopedCommand = async ({
  check,
  command,
  discard,
  query,
  reload,
  resolveFresh,
  selected,
  shiftKey
}) => {
  const queried = await query(scopeQuery(command));
  const tabs = filterScopeTabs(command, queried, selected);

  if (DISCARD_COMMANDS.has(command)) {
    const result = await prepareDiscardTargets(command, tabs, resolveFresh);
    if (shiftKey) {
      await Promise.all(result.candidates.map(discard));
    }
    else if (result.candidates.length) {
      await check(result.candidates);
    }
    return result;
  }
  if (RELEASE_COMMANDS.has(command)) {
    return {
      released: await releaseDiscardedTargets(command, tabs, reload, {
        bypassCache: shiftKey === true
      })
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
