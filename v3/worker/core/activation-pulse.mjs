// A frozen-tab wake is a focus transaction, not two independent tabs.update
// calls.  Keep activation events, lifecycle events, callback snapshots and
// live active-tab reads behind one observer so reordered Chromium delivery can
// only prove the expected transition or fail closed.
const createActivationPulse = ({
  allowTransientFocusLoss = false,
  noFocusedWindowId = -1,
  resolveId = id => id,
  tabs,
  windowId,
  windows
}) => {
  const activationEvent = tabs?.onActivated;
  if (!activationEvent?.addListener || !activationEvent?.removeListener) {
    return undefined;
  }

  const aliases = new Map();
  const localId = value => {
    let id = resolveId(value);
    const seen = new Set();
    while (Number.isInteger(id) && aliases.has(id) && !seen.has(id)) {
      seen.add(id);
      id = aliases.get(id);
    }
    return resolveId(id);
  };
  const state = {
    activationSequence: 0,
    alternateKeeperSelections: 0,
    closed: false,
    expected: undefined,
    focusLoss: undefined,
    interference: undefined,
    keeperFault: undefined,
    keeperId: undefined,
    lastCompleted: undefined,
    phase: 'selecting-keeper',
    targetFault: undefined,
    targetId: undefined
  };

  const interfere = details => {
    state.interference ||= details;
  };
  const roleFor = id => {
    id = localId(id);
    if (Number.isInteger(state.targetId) && id === localId(state.targetId)) {
      return 'target';
    }
    if (Number.isInteger(state.keeperId) && id === localId(state.keeperId)) {
      return 'keeper';
    }
  };
  const lifecycleFault = (role, kind, details = {}) => {
    const fault = {kind, role, ...details};
    if (role === 'target') {
      state.targetFault ||= fault;
    }
    else if (role === 'keeper') {
      state.keeperFault ||= fault;
    }
  };

  const onActivated = info => {
    if (info?.windowId !== windowId) {
      return;
    }
    state.activationSequence += 1;
    const id = localId(info.tabId);
    if (state.expected && id === localId(state.expected.id)) {
      if (state.expected.observed) {
        // A duplicated browser delivery and a user explicitly choosing the
        // temporarily active target are indistinguishable. Abort rather than
        // restoring over a possible user choice.
        interfere({kind: 'duplicate-activation', sequence: state.activationSequence, tabId: id});
        return;
      }
      state.expected.observed = true;
      state.expected.lastEventSequence = state.activationSequence;
      return;
    }
    if (!state.expected && state.lastCompleted && id === localId(state.lastCompleted.id)) {
      // A late duplicate is equally ambiguous with a user retaining this tab.
      interfere({kind: 'late-activation', sequence: state.activationSequence, tabId: id});
      return;
    }
    if (!state.expected && state.phase === 'selecting-keeper' && state.keeperFault &&
        state.alternateKeeperSelections < 1) {
      // Closing/moving/suspending the active keeper makes Chromium choose a
      // replacement synchronously. Accept that one provisional selection only
      // before the extension has armed its target pulse; the following active
      // query and full tab read still have to validate it.
      state.provisionalAlternateId = id;
      return;
    }
    interfere({kind: 'activation', sequence: state.activationSequence, tabId: id});
  };
  const onRemoved = id => {
    const role = roleFor(id);
    if (role) {
      lifecycleFault(role, 'removed', {tabId: localId(id)});
    }
  };
  const onReplaced = (addedId, removedId) => {
    const removed = localId(removedId);
    const role = roleFor(removed);
    const added = resolveId(addedId);
    aliases.set(removed, added);
    if (role === 'target') {
      state.targetId = added;
    }
    else if (role === 'keeper') {
      state.keeperId = added;
    }
    if (state.expected && localId(state.expected.id) === localId(removed)) {
      state.expected.id = added;
    }
    if (state.lastCompleted && localId(state.lastCompleted.id) === localId(removed)) {
      state.lastCompleted.id = added;
    }
  };
  const onAttached = (id, info) => {
    const role = roleFor(id);
    if (role && info?.newWindowId !== windowId) {
      lifecycleFault(role, 'attached', {
        newWindowId: info?.newWindowId,
        tabId: localId(id)
      });
    }
  };
  const onUpdated = (id, changeInfo, tab) => {
    const role = roleFor(id);
    if (!role) {
      return;
    }
    const discarded = changeInfo?.discarded === true || tab?.discarded === true;
    const frozen = changeInfo?.frozen === true || tab?.frozen === true;
    if ((discarded && !(role === 'target' && state.phase === 'native-discard')) ||
        (role === 'keeper' && frozen)) {
      lifecycleFault(role, discarded ? 'discarded' : 'frozen', {tabId: localId(id)});
    }
  };
  const onFocusChanged = focusedWindowId => {
    if (focusedWindowId === windowId) {
      if (state.focusLoss?.pending === true) {
        // Never infer whether a focus return happened before or after keeper
        // activation from cross-API event delivery order. A pending sentinel is
        // accepted only while windows.get independently still reports this
        // window unfocused after the keeper is active. Any return event before
        // that background proof is ambiguous with Alt+Tab away/back.
        interfere({kind: 'window-focus-return-before-background-proof', windowId: focusedWindowId});
      }
      return;
    }
    // Edge can emit WINDOW_ID_NONE while its native sleeping-tab activation
    // temporarily transfers OS focus, then report the exact same window again.
    // This event pair is only a candidate for later authoritative verification:
    // it never clears itself and blocks confirm()/phase progress until the
    // caller proves windows.get(windowId).focused plus the exact active tab.
    if (allowTransientFocusLoss === true && focusedWindowId === noFocusedWindowId &&
        state.phase === 'activating-target' && (state.expected || state.lastCompleted) &&
        !state.focusLoss) {
      state.focusLoss = {
        activationSequence: state.activationSequence,
        pending: true
      };
      return;
    }
    interfere({kind: allowTransientFocusLoss === true && focusedWindowId === noFocusedWindowId ?
      'repeated-window-focus-loss' : 'window-focus', windowId: focusedWindowId});
  };

  const listeners = [
    [activationEvent, onActivated],
    [tabs?.onRemoved, onRemoved],
    [tabs?.onReplaced, onReplaced],
    [tabs?.onAttached, onAttached],
    [tabs?.onUpdated, onUpdated],
    [windows?.onFocusChanged, onFocusChanged]
  ];
  try {
    for (const [event, listener] of listeners) {
      event?.addListener?.(listener);
    }
  }
  catch (error) {
    for (const [event, listener] of listeners) {
      event?.removeListener?.(listener);
    }
    return undefined;
  }

  const fault = () => state.interference || state.targetFault ||
    (state.phase !== 'selecting-keeper' ? state.keeperFault : undefined);
  const transientFocusSnapshotSafe = (activeTab, window, targetTab) => {
    const expectedId = state.expected?.id ?? state.lastCompleted?.id;
    const keeperSettled = ['failure-restoration', 'restoring-keeper'].includes(state.phase) &&
      !state.expected && state.lastCompleted &&
      localId(state.lastCompleted.id) === localId(state.keeperId);
    return state.focusLoss?.pending === true && keeperSettled &&
      Number.isInteger(expectedId) && !fault() &&
      state.focusLoss.activationSequence <= state.activationSequence &&
      window?.id === windowId && window.focused === false &&
      activeTab?.windowId === windowId && activeTab.active === true &&
      localId(activeTab.id) === localId(expectedId) &&
      localId(activeTab.id) === localId(state.keeperId) &&
      targetTab?.windowId === windowId && targetTab.active !== true &&
      localId(targetTab.id) === localId(state.targetId);
  };
  const arm = (id, phase) => {
    const focusLossKeeperRestore = state.focusLoss?.pending === true &&
      ['failure-restoration', 'restoring-keeper'].includes(phase) &&
      localId(id) === localId(state.keeperId) && !state.expected && state.lastCompleted &&
      localId(state.lastCompleted.id) === localId(state.targetId);
    if (fault() || state.expected || state.closed ||
        (state.focusLoss?.pending === true && !focusLossKeeperRestore)) {
      return false;
    }
    state.phase = phase || 'activation';
    state.lastCompleted = undefined;
    state.expected = {
      activationSequence: state.activationSequence,
      id: localId(id),
      observed: false
    };
    return true;
  };

  return {
    arm,
    callback(id, tab) {
      if (!state.expected || localId(id) !== localId(state.expected.id)) {
        interfere({kind: 'unexpected-callback', tabId: localId(id)});
        return false;
      }
      if (tab && (tab.active !== true || localId(tab.id) !== localId(id))) {
        interfere({kind: 'callback-postcondition', tabId: localId(tab.id)});
        return false;
      }
      state.expected.callback = true;
      return true;
    },
    cancelExpected({preserveCompleted = false} = {}) {
      state.expected = undefined;
      if (!preserveCompleted) {
        state.lastCompleted = undefined;
      }
    },
    close() {
      if (state.closed) {
        return;
      }
      state.closed = true;
      for (const [event, listener] of listeners) {
        event?.removeListener?.(listener);
      }
    },
    confirm(id, activeTab) {
      const expected = state.expected;
      if (!expected || fault() ||
          localId(id) !== localId(expected.id) ||
          !activeTab || activeTab.active !== true ||
          localId(activeTab.id) !== localId(expected.id)) {
        return false;
      }
      // A live active-tab read may stand in for a missing/coalesced event only
      // because every competing activation and focus/lifecycle change has been
      // observed since arm().
      state.lastCompleted = {
        activationSequence: state.activationSequence,
        id: localId(expected.id),
        lateDuplicates: 0,
        observed: expected.observed === true
      };
      state.expected = undefined;
      return true;
    },
    fault,
    interference: fault,
    focusLossPending: () => state.focusLoss?.pending === true,
    failTransientFocus(kind = 'window-focus-return-timeout') {
      if (state.focusLoss?.pending === true) {
        interfere({kind, windowId});
      }
      return false;
    },
    resolveTransientFocus(activeTab, window, targetTab) {
      const focusLoss = state.focusLoss;
      if (!transientFocusSnapshotSafe(activeTab, window, targetTab)) {
        interfere({kind: 'unverified-window-focus-return', windowId: window?.id});
        return false;
      }
      state.focusLoss = {
        ...focusLoss,
        pending: false,
        verified: true
      };
      return true;
    },
    transientFocusSnapshotSafe,
    keeperFault: () => state.keeperFault,
    keeperId: () => localId(state.keeperId),
    observed: id => Boolean(state.expected && !fault() &&
      localId(state.expected.id) === localId(id) && state.expected.observed),
    replaceKeeper(id) {
      if (state.phase !== 'selecting-keeper' || state.expected || state.interference ||
          state.targetFault || state.alternateKeeperSelections >= 1 ||
          (Number.isInteger(state.provisionalAlternateId) &&
            localId(state.provisionalAlternateId) !== localId(id))) {
        return false;
      }
      state.alternateKeeperSelections += 1;
      state.keeperId = localId(id);
      state.keeperFault = undefined;
      state.provisionalAlternateId = undefined;
      return true;
    },
    setKeeper(id) {
      if (state.phase !== 'selecting-keeper' || Number.isInteger(state.keeperId)) {
        return false;
      }
      state.keeperId = localId(id);
      return true;
    },
    setPhase(phase) {
      if (state.closed || state.expected || fault() || state.focusLoss?.pending === true) {
        return false;
      }
      state.phase = phase;
      return !fault();
    },
    setTarget(id) {
      if (Number.isInteger(state.targetId)) {
        return false;
      }
      state.targetId = localId(id);
      return true;
    },
    snapshot: () => Object.freeze({
      activationSequence: state.activationSequence,
      alternateKeeperSelections: state.alternateKeeperSelections,
      fault: fault(),
      focusLossPending: state.focusLoss?.pending === true,
      focusLossVerified: state.focusLoss?.verified === true,
      keeperId: localId(state.keeperId),
      phase: state.phase,
      targetId: localId(state.targetId)
    }),
    transientFocusAllowed: () => allowTransientFocusLoss === true &&
      state.phase === 'activating-target',
    targetId: () => localId(state.targetId),
    windowId: () => windowId
  };
};

export {createActivationPulse};
