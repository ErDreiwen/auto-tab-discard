import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

import {
  announcementKey,
  responseErrorText,
  statusText
} from '../v3/data/popup/messages.mjs';

const localeRoot = new URL('../v3/_locales/', import.meta.url);
const required = [
  'popup_title', 'popup_cancel', 'popup_retry', 'popup_progress', 'popup_result_summary',
  'popup_status_cancelling', 'popup_status_cancelled', 'popup_status_complete',
  'popup_status_failed', 'popup_status_interrupted', 'popup_status_partial', 'popup_error_busy',
  'popup_error_command_failed', 'popup_error_no_active_tab', 'popup_error_target_changed',
  'popup_visual_unavailable_warning', 'popup_no_safe_keeper_warning',
  'popup_release_remains_frozen_warning'
];

test('every locale has popup result keys and exact placeholder parity', async () => {
  const directories = await readdir(localeRoot);
  const catalogs = await Promise.all(directories.map(async directory => [
    directory,
    JSON.parse(await readFile(new URL(`${directory}/messages.json`, localeRoot), 'utf8'))
  ]));
  const english = catalogs.find(([directory]) => directory === 'en')[1];

  for (const [directory, catalog] of catalogs) {
    for (const key of required) {
      assert.equal(typeof catalog[key]?.message, 'string', `${directory} is missing ${key}`);
      assert.ok(catalog[key].message.length > 0, `${directory}.${key} must not be empty`);
      assert.deepEqual(
        Object.keys(catalog[key].placeholders || {}).sort(),
        Object.keys(english[key].placeholders || {}).sort(),
        `${directory}.${key} placeholders differ from the default locale`
      );
      for (const [name, placeholder] of Object.entries(english[key].placeholders || {})) {
        assert.equal(catalog[key].placeholders[name]?.content, placeholder.content,
          `${directory}.${key}.${name} has a different substitution position`);
      }
    }
  }
});

test('internal codes are localized and duplicate snapshots have one announcement identity', () => {
  const strings = {
    popup_error_command_failed: 'generic',
    popup_error_target_changed: 'target changed',
    popup_progress: '$1/$2 done',
    popup_result_summary: '$1 ok $2 skip $3 bad',
    popup_status_cancelled: 'cancelled',
    popup_status_complete: 'complete',
    popup_status_failed: 'failed',
    popup_status_interrupted: 'interrupted',
    popup_status_partial: 'partial',
    popup_no_safe_keeper_warning: '$1 stayed loaded: choose another tab and retry',
    popup_release_remains_frozen_warning: '$1 remained frozen after release; retry',
    popup_visual_unavailable_warning: '$1 visually unavailable'
  };
  const getMessage = (key, substitutions = []) => (strings[key] || '').replace(
    /\$(\d)/g,
    (match, index) => substitutions[Number(index) - 1]
  );
  const snapshot = {
    completed: 12,
    errorCode: undefined,
    jobId: 'job-1',
    state: 'complete',
    summary: {failed: 2, skipped: 3, success: 7},
    total: 12
  };
  assert.equal(statusText(snapshot, getMessage), 'complete 7 ok 3 skip 2 bad');
  const warned = {
    ...snapshot,
    outcomes: {
      1: {code: 'TAB_DISCARDED_VISUAL_UNAVAILABLE', status: 'success', tabId: 1},
      2: {code: 'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE', status: 'skipped', tabId: 2}
    }
  };
  assert.equal(statusText(warned, getMessage),
    'complete 7 ok 3 skip 2 bad 2 visually unavailable');
  assert.notEqual(announcementKey(snapshot), announcementKey(warned));
  assert.equal(statusText({...snapshot, state: 'partial'}, getMessage),
    'partial 7 ok 3 skip 2 bad');
  const noKeeper = {
    ...snapshot,
    outcomes: {
      1: {code: 'TAB_NO_SAFE_KEEPER', status: 'skipped', tabId: 1}
    },
    state: 'partial'
  };
  assert.equal(statusText(noKeeper, getMessage),
    'partial 7 ok 3 skip 2 bad 1 stayed loaded: choose another tab and retry');
  assert.notEqual(announcementKey(snapshot), announcementKey(noKeeper));
  const retainedFrozen = {
    ...snapshot,
    outcomes: {
      1: {code: 'TAB_RELEASE_REMAINS_FROZEN', status: 'failed', tabId: 1}
    },
    state: 'failed'
  };
  assert.equal(statusText(retainedFrozen, getMessage),
    'failed 7 ok 3 skip 2 bad 1 remained frozen after release; retry');
  assert.notEqual(announcementKey(snapshot), announcementKey(retainedFrozen));
  assert.equal(announcementKey(snapshot), announcementKey(structuredClone(snapshot)));
  assert.notEqual(announcementKey(snapshot), announcementKey({...snapshot, completed: 13}));
  assert.equal(responseErrorText({code: 'POPUP_TARGET_CHANGED'}, getMessage), 'target changed');
  assert.equal(responseErrorText({code: 'UNKNOWN'}, getMessage), 'generic');
});

test('long pseudo-localized and RTL popup text uses wrapping and logical layout', async () => {
  const [script, css, html] = await Promise.all([
    readFile(new URL('../v3/data/popup/index.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/data/popup/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../v3/data/popup/index.html', import.meta.url), 'utf8')
  ]);
  const pseudo = (key, substitutions = []) => `⟦${key.repeat(5)} ${substitutions.join(' ')}⟧`;
  const text = statusText({
    completed: 50,
    jobId: 'long',
    state: 'complete',
    summary: {failed: 1, skipped: 2, success: 47},
    total: 50
  }, pseudo);
  assert.ok(text.length > 100);
  assert.match(script, /getMessage\('@@bidi_dir'\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /margin-inline-(?:start|end)/);
  assert.match(css, /inline-size:\s*100%/);
  assert.match(css, /text-align:\s*start/);
  assert.match(html, /id="activity-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(script, /key !== renderedAnnouncement/);
  assert.match(script, /'partial'/);
  assert.doesNotMatch(script, /['"](?:Action|Command) failed['"]/);
});
