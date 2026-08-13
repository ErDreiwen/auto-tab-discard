import test from 'node:test';
import assert from 'node:assert/strict';

import {createActivationPulse} from '../v3/worker/core/activation-pulse.mjs';
import {
  inspectDocumentPulseState,
  normalizePulseState
} from '../v3/worker/core/pulse-side-effects.mjs';
import {
  isDiscardedTab,
  isFrozenTab,
  isLoadedTab,
  isSuspendedTab,
  suspensionState
} from '../v3/worker/core/browser-state.mjs';

const event = () => {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
    listenerCount: () => listeners.size,
    removeListener: listener => listeners.delete(listener)
  };
};

const fixture = ({allowTransientFocusLoss = false} = {}) => {
  const events = {
    activated: event(),
    attached: event(),
    focus: event(),
    removed: event(),
    replaced: event(),
    updated: event()
  };
  const pulse = createActivationPulse({
    allowTransientFocusLoss,
    noFocusedWindowId: -1,
    resolveId: id => id,
    tabs: {
      onActivated: events.activated,
      onAttached: events.attached,
      onRemoved: events.removed,
      onReplaced: events.replaced,
      onUpdated: events.updated
    },
    windowId: 9,
    windows: {onFocusChanged: events.focus}
  });
  pulse.setTarget(1);
  pulse.setKeeper(2);
  return {events, pulse};
};

test('Edge transient no-focus is accepted only after a keeper is proved active while still unfocused', () => {
  const f = fixture({allowTransientFocusLoss: true});
  assert.equal(f.pulse.arm(1, 'activating-target'), true);
  f.events.activated.emit({tabId: 1, windowId: 9});
  f.events.focus.emit(-1);
  assert.equal(f.pulse.callback(1, {id: 1, active: true, windowId: 9}), true);
  assert.equal(f.pulse.confirm(1, {id: 1, active: true, windowId: 9}), true);
  assert.equal(f.pulse.arm(2, 'restoring-keeper'), true,
    'the one preverified keeper may be restored while the window remains unfocused');
  f.events.activated.emit({tabId: 2, windowId: 9});
  assert.equal(f.pulse.callback(2, {id: 2, active: true, windowId: 9}), true);
  assert.equal(f.pulse.confirm(2, {id: 2, active: true, windowId: 9}), true);
  assert.equal(f.pulse.resolveTransientFocus(
    {id: 2, active: true, windowId: 9},
    {id: 9, focused: false},
    {id: 1, active: false, windowId: 9}
  ), true);
  f.events.focus.emit(9);
  assert.equal(f.pulse.interference(), undefined,
    'a later focus return is safe only because the target is already inactive');
  f.pulse.close();
});

test('transient no-focus fails closed on other window, repeated sentinel, timeout, or false live focus', () => {
  for (const mutate of [
    f => f.events.focus.emit(10),
    f => f.events.focus.emit(-1),
    f => f.pulse.failTransientFocus(),
    f => {
      f.pulse.confirm(1, {id: 1, active: true, windowId: 9});
      f.pulse.arm(2, 'restoring-keeper');
      f.events.activated.emit({tabId: 2, windowId: 9});
      f.pulse.confirm(2, {id: 2, active: true, windowId: 9});
      f.pulse.resolveTransientFocus(
        {id: 2, active: true, windowId: 9},
        {id: 9, focused: true},
        {id: 1, active: false, windowId: 9}
      );
    }
  ]) {
    const f = fixture({allowTransientFocusLoss: true});
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.events.focus.emit(-1);
    mutate(f);
    assert.ok(f.pulse.interference(), 'unsafe focus sequence must fault');
    assert.equal(f.pulse.confirm(1, {id: 1, active: true, windowId: 9}), false);
    f.pulse.close();
  }
});

test('Alt+Tab away and back before keeper proof is always ambiguous and fails closed', () => {
  const f = fixture({allowTransientFocusLoss: true});
  f.pulse.arm(1, 'activating-target');
  f.events.activated.emit({tabId: 1, windowId: 9});
  f.events.focus.emit(-1);
  f.events.focus.emit(9);
  assert.equal(f.pulse.interference().kind, 'window-focus-return-before-background-proof');
  assert.equal(f.pulse.confirm(1, {id: 1, active: true, windowId: 9}), false);
  assert.equal(f.pulse.arm(2, 'restoring-keeper'), false);
  f.pulse.close();
});

test('a queued exact-window return between background proof samples fails closed', async () => {
  const f = fixture({allowTransientFocusLoss: true});
  f.pulse.arm(1, 'activating-target');
  f.events.activated.emit({tabId: 1, windowId: 9});
  f.events.focus.emit(-1);
  f.pulse.callback(1, {id: 1, active: true, windowId: 9});
  f.pulse.confirm(1, {id: 1, active: true, windowId: 9});
  f.pulse.arm(2, 'restoring-keeper');
  f.events.activated.emit({tabId: 2, windowId: 9});
  f.pulse.callback(2, {id: 2, active: true, windowId: 9});
  f.pulse.confirm(2, {id: 2, active: true, windowId: 9});
  const active = {id: 2, active: true, windowId: 9};
  const target = {id: 1, active: false, windowId: 9};
  const window = {id: 9, focused: false};
  assert.equal(f.pulse.transientFocusSnapshotSafe(active, window, target), true,
    'the first authoritative background sample is valid');
  setTimeout(() => f.events.focus.emit(9), 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.pulse.transientFocusSnapshotSafe(active, window, target), false,
    'the pending return event invalidates the second sample even if its raw reads are stale');
  assert.equal(f.pulse.resolveTransientFocus(active, window, target), false);
  assert.equal(f.pulse.interference().kind, 'window-focus-return-before-background-proof');
  f.pulse.close();
});

test('transient no-focus never excuses user activation or duplicate and late ambiguity', () => {
  {
    const f = fixture({allowTransientFocusLoss: true});
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.events.focus.emit(-1);
    f.events.activated.emit({tabId: 3, windowId: 9});
    assert.equal(f.pulse.interference().kind, 'activation');
    f.pulse.close();
  }
  {
    const f = fixture({allowTransientFocusLoss: true});
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.events.focus.emit(-1);
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.interference().kind, 'duplicate-activation');
    f.pulse.close();
  }
  {
    const f = fixture({allowTransientFocusLoss: true});
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.pulse.confirm(1, {id: 1, active: true, windowId: 9});
    f.events.focus.emit(-1);
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.interference().kind, 'late-activation');
    f.pulse.close();
  }
});

test('Chrome behavior keeps no-focus immediately fatal', () => {
  const f = fixture();
  f.pulse.arm(1, 'activating-target');
  f.events.focus.emit(-1);
  assert.equal(f.pulse.interference().kind, 'window-focus');
  f.pulse.close();
});

test('pulse contract classifies Edge, Chrome, Firefox, and drifted states through the central adapter', () => {
  const fixtures = [
    [{id: 1, active: false, discarded: false, frozen: true, status: 'complete'}, 'frozen'],
    [{id: 2, active: false, discarded: true, frozen: false, status: 'unloaded'}, 'discarded'],
    [{id: 3, active: false, discarded: false, status: 'complete'}, 'loaded'],
    [{id: 4, active: false, discarded: false, frozen: false, status: 'complete'}, 'loaded'],
    [{id: 5, active: false, discarded: false, frozen: null, status: 'loading'}, 'unknown'],
    [{id: 6, active: false, discarded: false, frozen: 'sleeping', status: 'complete'}, 'unknown']
  ];
  for (const [tab, expected] of fixtures) {
    assert.equal(suspensionState(tab).kind, expected);
    assert.equal(isFrozenTab(tab), expected === 'frozen');
    assert.equal(isDiscardedTab(tab), expected === 'discarded');
    assert.equal(isLoadedTab(tab), expected === 'loaded');
    assert.equal(isSuspendedTab(tab), ['frozen', 'discarded'].includes(expected));
  }
});

test('activation callbacks, missing events, and live reads form one transaction', () => {
  const f = fixture();
  assert.equal(f.pulse.arm(1, 'activating-target'), true);
  f.events.activated.emit({tabId: 1, windowId: 9});
  assert.equal(f.pulse.callback(1, {id: 1, active: true}), true);
  assert.equal(f.pulse.confirm(1, {id: 1, active: true}), true);

  assert.equal(f.pulse.arm(2, 'restoring-keeper'), true);
  // A coalesced/missing event is accepted only with an uncontested live read.
  assert.equal(f.pulse.callback(2, {id: 2, active: true}), true);
  assert.equal(f.pulse.confirm(2, {id: 2, active: true}), true);
  assert.equal(f.pulse.snapshot().activationSequence, 1);
  f.pulse.close();
});

test('duplicate and late expected activations abort instead of overwriting a possible user choice', () => {
  {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.confirm(1, {id: 1, active: true}), false);
    assert.equal(f.pulse.interference().kind, 'duplicate-activation');
    f.pulse.close();
  }
  {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.confirm(1, {id: 1, active: true}), true);
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.interference().kind, 'late-activation');
    f.pulse.close();
  }
});

test('early, late-after-next-arm, foreign, and callback-mismatch activation orders fail closed', () => {
  {
    const f = fixture();
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.arm(1, 'activating-target'), false);
    assert.equal(f.pulse.interference().kind, 'activation');
    f.pulse.close();
  }
  {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 1, windowId: 9});
    f.pulse.confirm(1, {id: 1, active: true});
    f.pulse.arm(2, 'restoring-keeper');
    f.events.activated.emit({tabId: 1, windowId: 9});
    assert.equal(f.pulse.confirm(2, {id: 2, active: true}), false);
    assert.equal(f.pulse.interference().tabId, 1);
    f.pulse.close();
  }
  {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    f.events.activated.emit({tabId: 3, windowId: 9});
    assert.equal(f.pulse.confirm(1, {id: 1, active: true}), false);
    f.pulse.close();
  }
  {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    assert.equal(f.pulse.callback(1, {id: 2, active: true}), false);
    assert.equal(f.pulse.interference().kind, 'callback-postcondition');
    f.pulse.close();
  }
});

test('target and keeper replacements update both activation lineages without duplicate pulses', () => {
  const f = fixture();
  f.pulse.arm(1, 'activating-target');
  f.events.replaced.emit(11, 1);
  f.events.activated.emit({tabId: 11, windowId: 9});
  assert.equal(f.pulse.callback(11, {id: 11, active: true}), true);
  assert.equal(f.pulse.confirm(11, {id: 11, active: true}), true);
  assert.equal(f.pulse.targetId(), 11);

  f.pulse.arm(2, 'restoring-keeper');
  f.events.replaced.emit(22, 2);
  f.events.activated.emit({tabId: 22, windowId: 9});
  assert.equal(f.pulse.callback(22, {id: 22, active: true}), true);
  assert.equal(f.pulse.confirm(22, {id: 22, active: true}), true);
  assert.equal(f.pulse.keeperId(), 22);
  assert.equal(f.pulse.snapshot().activationSequence, 2);
  f.pulse.close();
});

test('one browser-selected alternate keeper is allowed only before activation is armed', () => {
  const f = fixture();
  f.events.removed.emit(2, {windowId: 9});
  f.events.activated.emit({tabId: 3, windowId: 9});
  assert.equal(f.pulse.interference(), undefined);
  assert.equal(f.pulse.replaceKeeper(3), true);
  assert.equal(f.pulse.keeperId(), 3);
  assert.equal(f.pulse.replaceKeeper(4), false);
  assert.equal(f.pulse.arm(1, 'activating-target'), true);
  f.events.removed.emit(3, {windowId: 9});
  assert.equal(f.pulse.interference().kind, 'removed');
  f.pulse.close();
});

test('keeper remove, attach, discard, and freeze faults abort at every activation boundary', () => {
  const mutations = [
    f => f.events.removed.emit(2, {windowId: 9}),
    f => f.events.attached.emit(2, {newWindowId: 10}),
    f => f.events.updated.emit(2, {discarded: true}, {id: 2, discarded: true}),
    f => f.events.updated.emit(2, {frozen: true}, {id: 2, frozen: true})
  ];
  for (const phase of ['activating-target', 'restoring-keeper', 'native-discard']) {
    for (const mutate of mutations) {
      const f = fixture();
      if (phase === 'activating-target') {
        f.pulse.arm(1, phase);
      }
      else {
        f.pulse.arm(1, 'activating-target');
        f.pulse.confirm(1, {id: 1, active: true});
        f.pulse.setPhase(phase);
      }
      mutate(f);
      assert.ok(f.pulse.interference(), `${phase} mutation must fault`);
      assert.equal(f.pulse.confirm(1, {id: 1, active: true}), false);
      f.pulse.close();
    }
  }
});

test('target lifecycle and window-focus changes abort, while expected native discard does not', () => {
  for (const mutate of [
    f => f.events.removed.emit(1, {windowId: 9}),
    f => f.events.attached.emit(1, {newWindowId: 10}),
    f => f.events.updated.emit(1, {discarded: true}, {id: 1, discarded: true}),
    f => f.events.focus.emit(10)
  ]) {
    const f = fixture();
    f.pulse.arm(1, 'activating-target');
    mutate(f);
    assert.ok(f.pulse.interference());
    f.pulse.close();
  }

  const f = fixture();
  f.pulse.arm(1, 'activating-target');
  f.pulse.confirm(1, {id: 1, active: true});
  assert.equal(f.pulse.setPhase('native-discard'), true);
  f.events.updated.emit(1, {discarded: true}, {id: 1, discarded: true});
  assert.equal(f.pulse.interference(), undefined);
  f.pulse.close();
  assert.equal(Object.values(f.events).every(value => value.listenerCount() === 0), true);
});

test('document pulse probe detects muted media, Picture-in-Picture, focus, and visibility', () => {
  const previous = globalThis.document;
  globalThis.document = {
    hasFocus: () => true,
    pictureInPictureElement: {},
    querySelectorAll: () => [
      {ended: false, muted: true, paused: false, volume: 1},
      {ended: false, muted: false, paused: true, volume: 1}
    ],
    visibilityState: 'visible'
  };
  try {
    assert.deepEqual(inspectDocumentPulseState(), {
      focused: true,
      mediaActive: true,
      mutedMediaActive: true,
      pictureInPicture: true,
      visibility: 'visible'
    });
    assert.deepEqual(normalizePulseState({visibility: 7}), {
      focused: false,
      mediaActive: false,
      mutedMediaActive: false,
      pictureInPicture: false,
      visibility: 'unknown'
    });
  }
  finally {
    globalThis.document = previous;
  }
});
