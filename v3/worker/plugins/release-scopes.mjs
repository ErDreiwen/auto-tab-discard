const expectedNormalScope = tab => Number.isInteger(tab?.windowId) &&
  typeof tab?.incognito === 'boolean' &&
  (!tab.windowType || tab.windowType === 'normal') ? Object.freeze({
    incognito: tab.incognito,
    windowId: tab.windowId,
    windowType: 'normal'
  }) : undefined;

const tabMatchesExpectedScope = (tab, expected) => Boolean(tab && expected &&
  Number.isInteger(tab.windowId) && tab.windowId === expected.windowId &&
  typeof tab.incognito === 'boolean' && tab.incognito === expected.incognito &&
  (!tab.windowType || tab.windowType === expected.windowType));

const releaseScope = (query, geometry, expected) => {
  const fixedExpected = expected && Object.freeze({...expected});
  const matches = tab => {
    const candidateExpected = fixedExpected || expectedNormalScope(tab);
    return Boolean(candidateExpected && geometry(tab) &&
      tabMatchesExpectedScope(tab, candidateExpected));
  };
  const admit = tab => {
    const candidateExpected = fixedExpected || expectedNormalScope(tab);
    return candidateExpected && geometry(tab) && tabMatchesExpectedScope(tab, candidateExpected) ?
      candidateExpected : undefined;
  };
  return Object.freeze({
    admit,
    expectedScope: fixedExpected,
    matches,
    query: Object.freeze({...query, windowType: 'normal'})
  });
};

const focusReleaseScope = activeTab => {
  const expected = expectedNormalScope(activeTab);
  return expected ? releaseScope({
    active: false,
    windowId: expected.windowId
  }, tab => tab?.windowId === expected.windowId, expected) : undefined;
};

const adjacentReleaseScope = (activeInfo, activeTab, offset) => {
  const expected = expectedNormalScope(activeTab);
  const windowId = Number.isInteger(activeInfo?.windowId) ? activeInfo.windowId : activeTab?.windowId;
  const index = Number.isInteger(activeTab?.index) ? activeTab.index + offset : NaN;
  if (!expected || windowId !== expected.windowId || !Number.isInteger(index) || index < 0) {
    return undefined;
  }
  return releaseScope({
    index,
    windowId
  }, tab => tab?.windowId === windowId && tab?.index === index, expected);
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
  expectedNormalScope,
  focusReleaseScope,
  nextReleaseScope,
  previousReleaseScope,
  startupPinnedReleaseScope,
  tabMatchesExpectedScope
};
