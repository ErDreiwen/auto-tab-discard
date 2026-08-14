const TAB_GROUP_ID_NONE = -1;

const isNativeGroup = tab => Number.isInteger(tab.groupId) && tab.groupId !== TAB_GROUP_ID_NONE;

const tabsForGroupCommand = (tabs, selected) => {
  if (isNativeGroup(selected)) {
    return tabs.filter(tab => tab.windowId === selected.windowId && tab.groupId === selected.groupId);
  }

  // An ungrouped tab has no group to expand into, so keep the command scoped
  // to the selected tab instead of accidentally using highlighted tabs.
  return [selected];
};

const tabsOutsideSelectedGroup = (tabs, selected) => isNativeGroup(selected) ?
  tabs.filter(tab => tab.windowId === selected.windowId && tab.groupId !== selected.groupId) : tabs;

export {isNativeGroup, TAB_GROUP_ID_NONE, tabsForGroupCommand, tabsOutsideSelectedGroup};
