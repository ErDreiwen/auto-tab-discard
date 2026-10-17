import {query} from './utils.mjs';
import {ownership} from './ownership.mjs';

const update = (id, properties) => new Promise((resolve, reject) => chrome.tabs.update(
  id, properties, (tab, compatibilityError) => {
    const error = chrome.runtime.lastError || compatibilityError;
    if (error) {
      reject(Error(error.message));
    }
    else {
      resolve(tab);
    }
  }
));
const remove = id => new Promise((resolve, reject) => chrome.tabs.remove(id, () => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message));
  }
  else {
    resolve();
  }
}));

const navigationTabs = async target => {
  const pinned = Number.isInteger(target?.tabId) && Number.isInteger(target?.windowId);
  const tabs = await query(pinned ? {windowId: target.windowId} : {currentWindow: true});
  const active = tabs.find(tab => tab.active === true);
  if (pinned && (!active || active.id !== target.tabId || active.windowId !== target.windowId ||
      (typeof target.incognito === 'boolean' && active.incognito !== target.incognito))) {
    throw Error('The navigation target changed before the command could run');
  }
  return {active, tabs};
};

const adjacent = (method, tabs, active, discarded) => {
  const next = tabs.filter(tab => tab.discarded === discarded && tab.index > active.index);
  const previous = tabs.filter(tab => tab.discarded === discarded && tab.index < active.index);
  if (method === 'move-next') return next.length ? next.shift() : previous.shift();
  return previous.length ? previous.pop() : next.pop();
};

const navigate = async (method, discarded = false, target) => {
  let {active, tabs: tbs} = await navigationTabs(target);
  if (!active) {
    return false;
  }
  let ntab = adjacent(method, tbs, active, discarded);

  if (ntab) {
    // Re-read the pinned window immediately before the first mutation. This
    // rejects an in-window activation race and recomputes the adjacent tab from
    // current indices instead of acting on a stale popup/currentWindow scope.
    ({active, tabs: tbs} = await navigationTabs(target));
    ntab = adjacent(method, tbs, active, discarded);
    if (!ntab) throw Error('The navigation scope changed before mutation');
    await ownership.withNativeMutationGuard(() =>
      update(ntab.id, {active: true}),
    ntab.id);
    if (method === 'close') {
      await remove(active.id);
    }
    return true;
  }
  // prevent infinite loop
  else if (discarded === false) {
    // https://github.com/rNeomy/auto-tab-discard/issues/41#issuecomment-422923307
    return navigate(method, true, target);
  }

  // https://github.com/rNeomy/auto-tab-discard/issues/264#issuecomment-1001410665
  if (method === 'close' && !ntab && tbs.length === 1 && tbs[0].active) {
    ({active, tabs: tbs} = await navigationTabs(target));
    if (tbs.length !== 1 || tbs[0].id !== active.id) {
      throw Error('The navigation scope changed before mutation');
    }
    await remove(active.id);
    return true;
  }

  return false;
};

export {navigate};
