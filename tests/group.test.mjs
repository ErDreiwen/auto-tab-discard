import test from 'node:test';
import assert from 'node:assert/strict';

import {tabsForGroupCommand, tabsOutsideSelectedGroup} from '../v3/worker/core/group.mjs';

test('selects all and only tabs in the selected Edge/Chromium group', () => {
  const selected = {id: 2, windowId: 10, groupId: 7, highlighted: true};
  const tabs = [
    {id: 1, windowId: 10, groupId: 7, highlighted: false},
    selected,
    {id: 3, windowId: 10, groupId: 8, highlighted: true},
    {id: 4, windowId: 10, groupId: -1, highlighted: true},
    {id: 5, windowId: 11, groupId: 7, highlighted: false}
  ];

  assert.deepEqual(tabsForGroupCommand(tabs, selected).map(tab => tab.id), [1, 2]);
});

test('recognizes Chromium group ID zero', () => {
  const selected = {id: 1, windowId: 10, groupId: 0};
  const tabs = [selected, {id: 2, windowId: 10, groupId: 0}, {id: 3, windowId: 10, groupId: 1}];

  assert.deepEqual(tabsForGroupCommand(tabs, selected).map(tab => tab.id), [1, 2]);
});

test('keeps an ungrouped command scoped to the selected tab', () => {
  const selected = {id: 1, windowId: 10, groupId: -1, highlighted: true};
  const tabs = [selected, {id: 2, windowId: 10, groupId: -1, highlighted: true}];

  assert.deepEqual(tabsForGroupCommand(tabs, selected), [selected]);
});

test('requires an activation keeper outside the selected group', () => {
  const selected = {id: 1, windowId: 10, groupId: 7};
  const tabs = [
    {id: 2, windowId: 10, groupId: 7},
    {id: 3, windowId: 10, groupId: 8},
    {id: 4, windowId: 10, groupId: -1},
    {id: 5, windowId: 11, groupId: 8}
  ];

  assert.deepEqual(tabsOutsideSelectedGroup(tabs, selected).map(tab => tab.id), [3, 4]);
});
