const FROZEN_CAPABILITY = Object.freeze({
  ABSENT: 'absent',
  FALSE: 'false',
  TRANSITIONAL: 'transitional',
  TRUE: 'true',
  UNKNOWN: 'unknown'
});

const frozenCapability = tab => {
  if (!tab || !Object.hasOwn(tab, 'frozen')) return FROZEN_CAPABILITY.ABSENT;
  if (tab.frozen === true) return FROZEN_CAPABILITY.TRUE;
  if (tab.frozen === false) return FROZEN_CAPABILITY.FALSE;
  if (tab.frozen === null && ['loading', 'unloaded'].includes(tab.status)) {
    return FROZEN_CAPABILITY.TRANSITIONAL;
  }
  return FROZEN_CAPABILITY.UNKNOWN;
};

const suspensionState = tab => {
  if (!tab || !Number.isInteger(tab.id)) return {kind: 'missing'};
  const frozen = frozenCapability(tab);
  if (tab.active === true) {
    if (tab.discarded === false &&
        (frozen === FROZEN_CAPABILITY.ABSENT || frozen === FROZEN_CAPABILITY.FALSE)) {
      return {active: true, kind: 'loaded', frozen};
    }
    if (frozen === FROZEN_CAPABILITY.UNKNOWN || frozen === FROZEN_CAPABILITY.TRANSITIONAL) {
      return {active: true, kind: 'unknown', frozen, reason: `unrecognized frozen state: ${String(tab.frozen)}`};
    }
    return {active: true, kind: 'active', frozen};
  }
  if (tab.discarded === true) return {kind: 'discarded', frozen};
  if (frozen === FROZEN_CAPABILITY.TRUE) return {kind: 'frozen', frozen};
  if (frozen === FROZEN_CAPABILITY.UNKNOWN || frozen === FROZEN_CAPABILITY.TRANSITIONAL) {
    return {kind: 'unknown', frozen, reason: `unrecognized frozen state: ${String(tab.frozen)}`};
  }
  if (tab.discarded === false) return {kind: 'loaded', frozen};
  return {kind: 'unknown', frozen, reason: `unrecognized discarded state: ${String(tab.discarded)}`};
};

const isDiscardedTab = tab => suspensionState(tab).kind === 'discarded';
const isFrozenTab = tab => suspensionState(tab).kind === 'frozen';
const isLoadedTab = tab => suspensionState(tab).kind === 'loaded';
const isSuspendedTab = tab => ['discarded', 'frozen'].includes(suspensionState(tab).kind);

export {
  FROZEN_CAPABILITY,
  frozenCapability,
  isDiscardedTab,
  isFrozenTab,
  isLoadedTab,
  isSuspendedTab,
  suspensionState
};
