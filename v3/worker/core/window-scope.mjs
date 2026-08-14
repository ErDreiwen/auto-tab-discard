const ALLOWED_WINDOW_TYPES = Object.freeze(['normal']);
const allowedTypes = new Set(ALLOWED_WINDOW_TYPES);

const createWindowScope = (selected, windowInfo = {}) => {
  if (!Number.isInteger(selected?.windowId) || !Number.isInteger(selected?.id)) {
    throw Error('selected tab has no stable window identity');
  }
  const type = windowInfo.type || selected.windowType || 'unknown';
  if (!allowedTypes.has(type)) {
    throw Error(`tab discard commands do not operate on ${type} windows`);
  }
  if (Number.isInteger(windowInfo.id) && windowInfo.id !== selected.windowId) {
    throw Error('selected tab and selected window identities disagree');
  }
  if (typeof windowInfo.incognito === 'boolean' &&
      windowInfo.incognito !== Boolean(selected.incognito)) {
    throw Error('selected tab and selected window privacy contexts disagree');
  }
  return Object.freeze({
    incognito: Boolean(selected.incognito),
    selectedId: selected.id,
    type,
    windowId: selected.windowId
  });
};

const tabInAllowedWindowScope = (tab, selected, {requireExplicit = false} = {}) => Boolean(tab &&
  (requireExplicit ? allowedTypes.has(tab.windowType) :
    (!tab.windowType || allowedTypes.has(tab.windowType))) &&
  (requireExplicit ? typeof tab.incognito === 'boolean' : true) &&
  Boolean(tab.incognito) === Boolean(selected?.incognito));

const attachWindowScope = (selected, scope) => ({
  ...selected,
  incognito: scope.incognito,
  windowType: scope.type
});

export {
  ALLOWED_WINDOW_TYPES,
  attachWindowScope,
  createWindowScope,
  tabInAllowedWindowScope
};
