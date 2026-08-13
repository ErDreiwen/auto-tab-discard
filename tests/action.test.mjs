import test from 'node:test';
import assert from 'node:assert/strict';

import {actionCommand, actionPopup} from '../v3/worker/core/action.mjs';

test('reads and normalizes the toolbar action from extension storage', async () => {
  let defaults;
  const command = await actionCommand(async values => {
    defaults = values;
    return {click: 'click.discard-tabs'};
  });

  assert.deepEqual(defaults, {click: 'click.popup'});
  assert.equal(command, 'discard-tabs');
});

test('keeps a legacy normalized toolbar action', async () => {
  const command = await actionCommand(async () => ({click: 'discard-window'}));

  assert.equal(command, 'discard-window');
});

test('falls back to the popup action for an invalid value', async () => {
  const command = await actionCommand(async () => ({click: null}));

  assert.equal(command, 'popup');
});

test('falls back to the popup action for an unknown string', async () => {
  const command = await actionCommand(async () => ({click: 'click.not-a-command'}));

  assert.equal(command, 'popup');
  assert.equal(actionPopup('click.not-a-command'), '/data/popup/index.html');
});

test('uses one extension-root-relative popup path for Firefox and Chromium', () => {
  assert.equal(actionPopup('click.popup'), '/data/popup/index.html');
  assert.equal(actionPopup('popup'), '/data/popup/index.html');
  assert.equal(actionPopup('click.discard-tab'), '');
});
