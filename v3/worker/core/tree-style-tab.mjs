const TREE_STYLE_TAB_ID = 'treestyletab@piro.sakura.ne.jp';
const MAX_TREE_NODES = 10_000;

const validTabId = value => Number.isInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const apiError = (value, fallback) => {
  const error = value instanceof Error ? value : Error(value?.message || String(value || fallback));
  if (value?.code !== undefined && error.code === undefined) {
    error.code = value.code;
  }
  return error;
};

const requestTreeStyleTab = (runtime, tabId, {timeoutMs = 5_000} = {}) => new Promise(
  (resolve, reject) => {
    if (typeof runtime?.sendMessage !== 'function' || !validTabId(tabId)) {
      reject(Error('Tree Style Tab request is unavailable'));
      return;
    }
    let settled = false;
    let timer;
    const finish = (method, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      method(value);
    };
    const callback = tree => {
      const error = runtime.lastError;
      if (error) {
        finish(reject, apiError(error, 'Tree Style Tab request failed'));
      }
      else {
        finish(resolve, tree);
      }
    };

    timer = setTimeout(() => {
      const error = Error('Tree Style Tab request timed out');
      error.code = 'TREE_STYLE_TAB_TIMEOUT';
      finish(reject, error);
    }, Math.max(1, Math.min(30_000, Number(timeoutMs) || 5_000)));

    try {
      const operation = runtime.sendMessage(TREE_STYLE_TAB_ID, {
        tab: tabId,
        type: 'get-tree'
      }, callback);
      if (operation?.then) {
        operation.then(tree => finish(resolve, tree), error =>
          finish(reject, apiError(error, 'Tree Style Tab request failed')));
      }
    }
    catch (error) {
      finish(reject, apiError(error, 'Tree Style Tab request failed'));
    }
  }
);

const flattenTreeStyleTabResponse = (tree, tabs, selectedTab) => {
  if (!record(tree) || !validTabId(selectedTab?.id) || !Number.isInteger(selectedTab.windowId) ||
      tree.id !== selectedTab.id || !Array.isArray(tabs)) {
    throw Error('Tree Style Tab returned an invalid root');
  }
  const available = new Map();
  for (const tab of tabs) {
    if (!record(tab) || !validTabId(tab.id) || tab.windowId !== selectedTab.windowId) {
      throw Error('Tree Style Tab scope contains malformed tab data');
    }
    available.set(tab.id, tab);
  }
  if (!available.has(selectedTab.id)) {
    throw Error('Tree Style Tab root is outside the current window scope');
  }

  const result = [];
  const included = new Set();
  const path = new Set();
  let visited = 0;
  const visit = node => {
    visited += 1;
    if (visited > MAX_TREE_NODES || !record(node) || !validTabId(node.id) || path.has(node)) {
      throw Error('Tree Style Tab returned a malformed or cyclic tree');
    }
    const children = node.children === undefined ? [] : node.children;
    if (!Array.isArray(children)) {
      throw Error('Tree Style Tab returned malformed child data');
    }
    const tab = available.get(node.id);
    if (!tab) {
      throw Error('Tree Style Tab returned a tab outside the current window scope');
    }
    if (!included.has(tab.id)) {
      included.add(tab.id);
      result.push(tab);
    }
    path.add(node);
    for (const child of children) {
      visit(child);
    }
    path.delete(node);
  };
  visit(tree);
  return result;
};

const resolveTreeStyleTabTargets = async ({
  runtime,
  selectedTab,
  tabs,
  timeoutMs
}) => flattenTreeStyleTabResponse(
  await requestTreeStyleTab(runtime, selectedTab?.id, {timeoutMs}),
  tabs,
  selectedTab
);

export {
  flattenTreeStyleTabResponse,
  requestTreeStyleTab,
  resolveTreeStyleTabTargets,
  TREE_STYLE_TAB_ID
};
