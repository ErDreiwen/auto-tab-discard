import {
  isKeeperCandidate,
  revalidateDirectKeeper,
  selectKeeper
} from './keeper.mjs';

const outcomeTabId = entry => {
  if (Number.isInteger(entry)) {
    return entry;
  }
  if (Number.isInteger(entry?.tab?.id)) {
    return entry.tab.id;
  }
  if (Number.isInteger(entry?.id)) {
    return entry.id;
  }
};

const successfulTabIds = (result, resolveId = id => id) => {
  if (result === true) {
    return undefined;
  }
  return new Set((result?.succeeded || []).map(outcomeTabId).filter(Number.isInteger)
    .map(id => {
      try {
        const current = resolveId(id);
        return Number.isInteger(current) ? current : id;
      }
      catch (error) {
        return id;
      }
    }));
};

const helperTransaction = ({affected, helpers, id, registry, resolveId = value => value}) => {
  let settled = false;
  const currentId = value => {
    try {
      const current = resolveId(value);
      return Number.isInteger(current) ? current : value;
    }
    catch (error) {
      return value;
    }
  };
  return {
    async commit(result) {
      if (settled) {
        return result;
      }
      const succeeded = successfulTabIds(result, currentId);
      // Edge can replace a tab ID while its native discard settles. Treat the
      // predecessor opener and successor outcome as one logical tab so a
      // successful command retains its helper instead of closing it and
      // restoring the just-discarded opener.
      const successful = original => succeeded === undefined || succeeded.has(currentId(original.tabId));
      const keepWindowIds = affected.filter(successful).map(original => original.windowId);
      const keepHelperIds = helpers
        .filter(helper => succeeded === undefined || succeeded.has(currentId(helper.openerTabId)))
        .map(helper => helper.tab.id);
      await registry.commitTransaction(id, {keepHelperIds, keepWindowIds});
      settled = true;
      return result;
    },
    async rollback() {
      if (!settled) {
        await registry.rollback(id);
        settled = true;
      }
    }
  };
};

const createBlankPreparer = ({
  activate,
  create,
  inProgress = () => false,
  isHelper = () => false,
  read,
  registry,
  resolveId = value => value,
  sendMessage
}) => {
  const readWithoutHelpers = async options => {
    const tabs = await read(options);
    const registered = await registry.helperIds();
    return tabs.filter(tab => registered.has(tab.id) === false && isHelper(tab) === false);
  };
  const directTabs = tab => () => readWithoutHelpers({windowId: tab.windowId});
  const candidate = (tabs, selected) => selectKeeper(tabs, selected, {
    inProgress,
    targetIds: new Set([selected.id])
  });

  return async ({menuItemId}, tab) => {
    if (menuItemId === 'release-tabs' || menuItemId === 'release-other-windows') {
      const tbs = await read({active: true, currentWindow: false});
      for (const tb of tbs) {
        sendMessage(tb.id, {method: 'tab-is-active'});
      }
      return undefined;
    }

    if (menuItemId === 'discard-other-windows' || menuItemId === 'discard-tabs') {
      // The command executor admits only normal windows in the selected
      // privacy context. Mirror that boundary before changing focus: a broad
      // currentWindow:false query can include incognito and popup windows, and
      // a popup cannot accept the helper tab this preflight may need to create.
      // Use the selected window ID instead of mutable browser focus for both
      // bulk commands; its active tab remains the user's final keeper.
      const activeTabs = (await readWithoutHelpers({
        active: true,
        windowType: 'normal'
      })).filter(active =>
        active.windowId !== tab.windowId &&
        Boolean(active.incognito) === Boolean(tab.incognito)
      );
      const windowIds = [...new Set(activeTabs
        .filter(active => Number.isInteger(active?.windowId) && isHelper(active) === false)
        .map(active => active.windowId))];
      const affected = [];
      const helpers = [];
      let id;
      const transaction = async () => id ||= await registry.begin();

      try {
        for (const windowId of windowIds) {
          let changed = false;
          // Focus can move while the hook is awaiting storage or a tab query.
          // Retry a small, deterministic number of times; never act on a clone
          // that is no longer the active tab for this window.
          for (let attempt = 0; attempt < 3 && !changed; attempt += 1) {
            const before = await readWithoutHelpers({windowId});
            const original = before.find(candidate => candidate.active === true);
            if (!original) {
              break;
            }
            const transactionId = await transaction();
            await registry.recordOriginal(transactionId, original);

            // This is the authoritative read immediately before changing
            // focus. selectKeeper and the explicit predicate below are the
            // same keeper policy used by the command executor.
            const currentTabs = await readWithoutHelpers({windowId});
            const current = currentTabs.find(candidate => candidate.id === original.id && candidate.active === true);
            if (!current) {
              continue;
            }
            const keeper = candidate(currentTabs, current);
            if (keeper && isKeeperCandidate(keeper, {
              inProgress,
              targetIds: new Set([current.id])
            })) {
              await activate(keeper);
              affected.push({tabId: current.id, windowId});
              changed = true;
            }
            else if (/^https?:/i.test(current.url || '')) {
              const helper = await create(current, {active: true, transactionId});
              helpers.push({openerTabId: current.id, tab: helper, windowId});
              affected.push({tabId: current.id, windowId});
              changed = true;
            }
          }
          if (!changed && id) {
            await registry.forgetOriginal(id, windowId);
          }
        }
        if (!id || affected.length === 0) {
          if (id) {
            await registry.rollback(id);
          }
          return undefined;
        }
        return helperTransaction({affected, helpers, id, registry, resolveId});
      }
      catch (error) {
        if (id) {
          await registry.rollback(id);
        }
        throw error;
      }
    }

    if (menuItemId === 'discard-tab' || menuItemId === 'discard-tree') {
      const readTabs = directTabs(tab);
      const initial = await revalidateDirectKeeper(readTabs, menuItemId, tab, {inProgress});
      if (!initial.needsKeeper || initial.keeper || !/^https?:/i.test(initial.selected?.url || '')) {
        return undefined;
      }

      const id = await registry.begin();
      const affected = [{tabId: initial.selected.id, windowId: initial.selected.windowId}];
      try {
        await registry.recordOriginal(id, initial.selected);
        // Re-run the complete direct policy immediately before creating a tab.
        // If a genuine keeper appeared, or the target/focus changed, the blank
        // tab is no longer necessary and the transaction is erased.
        const current = await revalidateDirectKeeper(readTabs, menuItemId, tab, {inProgress});
        if (!current.needsKeeper || current.keeper || current.selected?.id !== initial.selected.id ||
            !/^https?:/i.test(current.selected?.url || '')) {
          await registry.rollback(id);
          return undefined;
        }
        const helper = await create(current.selected, {active: false, transactionId: id});
        return helperTransaction({
          affected,
          helpers: [{openerTabId: current.selected.id, tab: helper, windowId: current.selected.windowId}],
          id,
          registry,
          resolveId
        });
      }
      catch (error) {
        await registry.rollback(id);
        throw error;
      }
    }
  };
};

export {createBlankPreparer, helperTransaction, successfulTabIds};
