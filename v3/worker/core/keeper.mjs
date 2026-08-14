import {tabsForGroupCommand} from './group.mjs';

const isKeeperCandidate = (tab, {
  inProgress = () => false,
  targetIds = new Set()
} = {}) => Boolean(tab &&
  tab.discarded === false &&
  tab.frozen !== true &&
  tab.highlighted === false &&
  tab.status !== 'unloaded' &&
  targetIds.has(tab.id) === false &&
  inProgress(tab.id) === false);

const selectKeeper = (tabs, selected, options = {}) => tabs
  .filter(tab => isKeeperCandidate(tab, options))
  .sort((a, b) => Math.abs(a.index - selected.index) - Math.abs(b.index - selected.index))[0];

const inspectDirectKeeper = (command, tabs, selected, {inProgress = () => false} = {}) => {
  tabs = Array.isArray(tabs) ? tabs : [];
  const current = tabs.find(tab => tab.id === selected?.id);
  if (!current) {
    return {
      keeper: undefined,
      needsKeeper: false,
      selected: undefined,
      targetIds: new Set(),
      targets: []
    };
  }
  const targets = command === 'discard-tree' ? tabsForGroupCommand(tabs, current) : [current];
  const targetIds = new Set(targets.map(tab => tab.id));
  return {
    keeper: selectKeeper(tabs, current, {inProgress, targetIds}),
    needsKeeper: targets.some(tab => tab.active === true),
    selected: current,
    targetIds,
    targets
  };
};

// The blank plug-in runs before the command's own tabs.query. Read twice so a
// frozen/unloaded/in-progress transition that occurs while the hook is awake
// cannot suppress a needed helper (or create one after a keeper appeared).
const revalidateDirectKeeper = async (readTabs, command, selected, options = {}) => {
  const previous = inspectDirectKeeper(command, await readTabs(), selected, options);
  const current = inspectDirectKeeper(command, await readTabs(), selected, options);
  return {...current, previous};
};

export {
  inspectDirectKeeper,
  isKeeperCandidate,
  revalidateDirectKeeper,
  selectKeeper
};
