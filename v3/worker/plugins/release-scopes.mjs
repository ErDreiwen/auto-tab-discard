const releaseScope = (query, matches) => Object.freeze({
  matches,
  query: Object.freeze({...query})
});

const focusReleaseScope = windowId => Number.isInteger(windowId) ? releaseScope({
  active: false,
  windowId
}, tab => tab?.windowId === windowId) : undefined;

const adjacentReleaseScope = (activeInfo, activeTab, offset) => {
  const windowId = Number.isInteger(activeInfo?.windowId) ? activeInfo.windowId : activeTab?.windowId;
  const index = Number.isInteger(activeTab?.index) ? activeTab.index + offset : NaN;
  if (!Number.isInteger(windowId) || !Number.isInteger(index) || index < 0) {
    return undefined;
  }
  return releaseScope({
    index,
    windowId
  }, tab => tab?.windowId === windowId && tab?.index === index);
};

const nextReleaseScope = (activeInfo, activeTab) => adjacentReleaseScope(activeInfo, activeTab, 1);
const previousReleaseScope = (activeInfo, activeTab) => adjacentReleaseScope(activeInfo, activeTab, -1);

const startupUrlMatches = tab => /^https?:\/\//i.test(tab?.url || '');

const startupPinnedReleaseScope = () => releaseScope({
  url: '*://*/*',
  active: false,
  pinned: true
}, tab => tab?.pinned === true && startupUrlMatches(tab));

export {
  focusReleaseScope,
  nextReleaseScope,
  previousReleaseScope,
  startupPinnedReleaseScope
};
