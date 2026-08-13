import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  classifyBrowserError,
  scriptingFailureDecision
} from '../v3/worker/core/browser-error.mjs';

test('prefers structured browser codes over localized messages', () => {
  assert.equal(classifyBrowserError({
    code: 'FRAME_REMOVED',
    message: 'localized text'
  }).category, CATEGORIES.TRANSIENT);
  assert.equal(classifyBrowserError({
    name: 'MissingHostPermissionError',
    message: 'localized text'
  }).category, CATEGORIES.PERMISSION);
  assert.equal(classifyBrowserError({
    cause: {code: 'BLOCKED_BY_POLICY'},
    message: 'localized text'
  }).category, CATEGORIES.POLICY);
});

test('classifies the sanitized cross-browser message corpus', () => {
  const corpus = [
    ['Frame with ID 0 was removed.', CATEGORIES.TRANSIENT],
    ['Frame with ID 12 is not ready.', CATEGORIES.TRANSIENT],
    ['No frame with id 0 in tab with id 123', CATEGORIES.TRANSIENT],
    ['Missing host permission for the tab.', CATEGORIES.PERMISSION],
    ['Cannot access contents of url "edge://settings".', CATEGORIES.PERMISSION],
    ['No tab with id: 42.', CATEGORIES.CLOSED],
    ['Blocked by enterprise policy.', CATEGORIES.POLICY]
  ];
  for (const [message, category] of corpus) {
    assert.equal(classifyBrowserError(Error(message)).category, category, message);
  }
});

test('post-error state permits only a known transient frame retry', () => {
  const live = {active: false, discarded: false, frozen: false, status: 'loading'};
  assert.equal(scriptingFailureDecision(Error('Frame with ID 0 was removed.'), live).action, 'retry');

  for (const message of [
    'Cannot access contents of url "https://example.invalid".',
    'Blocked by administrator policy.',
    'Frame with ID 0 is showing error page.',
    'completely unfamiliar localized error'
  ]) {
    assert.equal(scriptingFailureDecision(Error(message), live).action, 'fail', message);
  }
});

test('post-error live state settles safely without another native discard', () => {
  const unknown = Error('unfamiliar error');
  assert.equal(scriptingFailureDecision(unknown, null).classification.category, CATEGORIES.CLOSED);
  assert.equal(scriptingFailureDecision(unknown, {
    active: false,
    discarded: true,
    frozen: false
  }).action, 'settled');
  assert.equal(scriptingFailureDecision(unknown, {
    active: true,
    discarded: false,
    frozen: false
  }).action, 'settled');
});
