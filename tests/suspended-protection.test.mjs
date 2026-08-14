import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySuspendedTarget,
  matchesRule,
  partitionSuspendedTargets,
  tabLocation
} from '../v3/worker/core/suspended-protection.mjs';

const safePolicy = Object.freeze({
  audio: false,
  form: false,
  mode: 'time-based',
  paused: false,
  period: 0,
  pinned: false,
  whitelist: [],
  'notification.permission': false,
  'whitelist-url': [],
  'whitelist.session': []
});

const suspended = (overrides = {}) => ({
  id: 1,
  active: false,
  audible: false,
  autoDiscardable: true,
  discarded: false,
  frozen: true,
  lastAccessed: 1,
  pinned: false,
  url: 'https://eligible.example/article',
  ...overrides
});

const externallyDiscarded = (overrides = {}) => suspended({
  discarded: true,
  frozen: false,
  ...overrides
});

test('an explicitly safe suspended target is eligible for takeover', () => {
  const tab = suspended();
  const result = classifySuspendedTarget(tab, safePolicy, {now: 1000});

  assert.deepEqual(result, {
    action: 'allow',
    allowed: true,
    bypassed: false,
    protected: false,
    reasons: [],
    tab
  });
});

test('external discards retain every static protection without inventing destroyed renderer state', () => {
  const tab = externallyDiscarded({
    audible: true,
    autoDiscardable: false,
    lastAccessed: undefined,
    pinned: true,
    url: 'https://protected.example/draft'
  });
  const result = classifySuspendedTarget(tab, {
    ...safePolicy,
    audio: true,
    form: true,
    paused: true,
    period: 600,
    pinned: true,
    whitelist: ['protected.example'],
    'notification.permission': true
  }, {now: 1000});

  assert.equal(result.action, 'protect');
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('tab URL is protected by the whitelist'));
  assert.ok(result.reasons.includes('tab is not automatically discardable'));
  assert.ok(result.reasons.includes('pinned-tab protection is enabled'));
  assert.ok(result.reasons.includes('tab is audible'));
  assert.equal(result.reasons.some(reason => /cannot be verified/.test(reason)), false,
    'the already-destroyed renderer has no surviving form/PiP state to probe');

  const active = classifySuspendedTarget(externallyDiscarded({active: true}), safePolicy);
  assert.equal(active.action, 'protect');
  assert.deepEqual(active.reasons, ['tab is active']);
});

test('normal commands protect URL rules, pinned tabs, and non-discardable tabs', () => {
  const cases = [
    [
      suspended({url: 'https://whitelist.example/page'}),
      {...safePolicy, whitelist: ['whitelist.example']},
      'tab URL is protected by the whitelist'
    ],
    [
      suspended({url: 'https://session.example/page'}),
      {...safePolicy, 'whitelist.session': ['re:^https://session\\.example/']},
      'tab URL is protected by the whitelist'
    ],
    [
      suspended({url: 'https://outside.example/page'}),
      {...safePolicy, mode: 'url-based', 'whitelist-url': ['allowed.example']},
      'tab URL is outside the URL-based discard list'
    ],
    [
      suspended({pinned: true}),
      {...safePolicy, pinned: true},
      'pinned-tab protection is enabled'
    ],
    [
      suspended({autoDiscardable: false}),
      safePolicy,
      'tab is not automatically discardable'
    ]
  ];

  for (const [tab, policy, reason] of cases) {
    const result = classifySuspendedTarget(tab, policy, {now: 1000});
    assert.equal(result.action, 'protect', reason);
    assert.equal(result.allowed, false, reason);
    assert.equal(result.reason, reason, reason);
    assert.ok(result.reasons.includes(reason), reason);
  }

  for (const [tab, policy, reason] of cases) {
    const result = classifySuspendedTarget({...tab, discarded: true, frozen: false}, policy, {now: 1000});
    assert.equal(result.action, 'protect', `external: ${reason}`);
    assert.ok(result.reasons.includes(reason), `external: ${reason}`);
  }
});

test('renderer-only protections fail closed for every suspended medium', () => {
  const media = suspended();
  const cases = [
    ['form', 'unsaved-form state cannot be verified while suspended'],
    ['audio', 'picture-in-picture state cannot be verified while suspended'],
    ['paused', 'paused-media state cannot be verified while suspended'],
    ['notification.permission', 'notification permission cannot be verified while suspended']
  ];

  for (const [preference, reason] of cases) {
    const result = classifySuspendedTarget(media, {
      ...safePolicy,
      [preference]: true
    }, {now: 1000});
    assert.equal(result.action, 'protect', preference);
    assert.ok(result.reasons.includes(reason), preference);
  }

  const audible = classifySuspendedTarget(suspended({audible: true}), {
    ...safePolicy,
    audio: true
  }, {now: 1000});
  assert.ok(audible.reasons.includes('tab is audible'));
});

test('missing, invalid, and non-web URLs are protected conservatively', () => {
  const cases = [
    [suspended({url: undefined}), 'tab URL is unavailable'],
    [suspended({url: 'not a url'}), 'invalid tab URL: not a url'],
    [suspended({url: 'edge://settings/'}), 'tab URL is not renderer-safe: edge:'],
    [suspended({url: 'file:///draft.txt'}), 'tab URL is not renderer-safe: file:']
  ];

  for (const [tab, reason] of cases) {
    const result = classifySuspendedTarget(tab, safePolicy, {now: 1000});
    assert.equal(result.reason, reason);
  }
});

test('normal commands preserve active, recent, and unknown-age targets', () => {
  const recent = classifySuspendedTarget(suspended({lastAccessed: 950}), {
    ...safePolicy,
    period: 1
  }, {now: 1000});
  assert.ok(recent.reasons.includes('tab is not old enough'));

  const unknown = classifySuspendedTarget(suspended({lastAccessed: undefined}), {
    ...safePolicy,
    period: 1
  }, {now: 1000});
  assert.ok(unknown.reasons.includes('last-accessed time is unavailable'));

  const active = classifySuspendedTarget(suspended({active: true}), safePolicy, {now: 1000});
  assert.ok(active.reasons.includes('tab is active'));
});

test('Shift is an explicit bypass and retains every audited reason', () => {
  const tab = suspended({
    active: true,
    autoDiscardable: false,
    pinned: true,
    url: 'edge://settings/'
  });
  const result = classifySuspendedTarget(tab, {
    ...safePolicy,
    form: true,
    pinned: true
  }, {
    now: 1000,
    shiftKey: true
  });

  assert.equal(result.action, 'bypass');
  assert.equal(result.allowed, true);
  assert.equal(result.bypassed, true);
  assert.equal(result.protected, false);
  assert.ok(result.reasons.length >= 4);
  assert.ok(result.reasons.includes('tab URL is not renderer-safe: edge:'));
  assert.ok(result.reasons.includes('tab is not automatically discardable'));
  assert.ok(result.reasons.includes('pinned-tab protection is enabled'));
  assert.ok(result.reasons.includes('unsaved-form state cannot be verified while suspended'));
});

test('partitioning keeps normal protection and Shift bypass deterministic', () => {
  const eligible = suspended({id: 1});
  const whitelisted = suspended({id: 2, url: 'https://protected.example/'});
  const pinned = suspended({id: 3, pinned: true});
  const policy = {
    ...safePolicy,
    pinned: true,
    whitelist: ['protected.example']
  };

  const normal = partitionSuspendedTargets([eligible, whitelisted, pinned], policy, {now: 1000});
  assert.deepEqual(normal.allowed.map(tab => tab.id), [1]);
  assert.deepEqual(normal.protected.map(entry => entry.tab.id), [2, 3]);
  assert.deepEqual(normal.bypassed, []);

  const forced = partitionSuspendedTargets([eligible, whitelisted, pinned], policy, {
    now: 1000,
    shiftKey: true
  });
  assert.deepEqual(forced.allowed.map(tab => tab.id), [1, 2, 3]);
  assert.deepEqual(forced.protected, []);
  assert.deepEqual(forced.bypassed.map(entry => entry.tab.id), [2, 3]);
});

test('URL parsing and regex matching are safe and deterministic', () => {
  assert.deepEqual(tabLocation({pendingUrl: 'https://next.example/', url: 'https://old.example/'}), {
    href: 'https://next.example/',
    hostname: 'next.example'
  });
  assert.equal(matchesRule(['example.test'], 'example.test', 'https://example.test/'), true);
  assert.equal(matchesRule(['re:^https://example\\.test/private'], 'other',
    'https://example.test/private/one'), true);
  assert.equal(matchesRule(['re:['], 'other', 'https://example.test/'), false);
});

test('rejected rules fail closed with an auditable suspended-protection reason', () => {
  const unsafeWhitelist = classifySuspendedTarget(suspended(), {
    ...safePolicy,
    whitelist: ['re:(a+)+$']
  }, {now: 1000});
  assert.equal(unsafeWhitelist.action, 'protect');
  assert.match(unsafeWhitelist.reason, /whitelist rules were rejected: nested quantifiers/);

  const unsafeAllowList = classifySuspendedTarget(suspended(), {
    ...safePolicy,
    mode: 'url-based',
    'whitelist-url': ['re:(a|aa)+$']
  }, {now: 1000});
  assert.equal(unsafeAllowList.action, 'protect');
  assert.match(unsafeAllowList.reasons[0],
    /URL-based discard rules were rejected: quantified alternation/);

  const oversized = classifySuspendedTarget(suspended(), {
    ...safePolicy,
    whitelist: Array(129).fill('example.test')
  }, {now: 1000});
  assert.equal(oversized.action, 'protect');
  assert.match(oversized.reason, /exceeds 128 entries/);
});
