import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  acceptedLifecycleUrl,
  createLifecycleNavigation,
  FEEDBACK,
  RELEASE_NOTES
} from '../v3/worker/core/lifecycle.mjs';

test('lifecycle URLs are fixed HTTPS fork destinations without identity parameters', () => {
  assert.equal(acceptedLifecycleUrl(FEEDBACK), true);
  assert.equal(acceptedLifecycleUrl(RELEASE_NOTES('0.6.9.2')), true);
  for (const rejected of [
    'http://github.com/ErDreiwen/auto-tab-discard/issues/new',
    'https://github.com/rNeomy/auto-tab-discard/issues/new',
    `${FEEDBACK}?name=private&version=1`,
    'https://example.com/'
  ]) {
    assert.equal(acceptedLifecycleUrl(rejected), false, rejected);
  }
});

test('every possible outbound lifecycle navigation is documented', () => {
  const documentation = fs.readFileSync(
    new URL('../docs/LIFECYCLE_NAVIGATION.md', import.meta.url), 'utf8'
  );
  assert.match(documentation, /disabled by default/i);
  assert.match(documentation, /lifecycle-feedback/);
  assert.match(documentation, /github\.com\/ErDreiwen\/auto-tab-discard\/releases\/tag/);
  assert.match(documentation, /github\.com\/ErDreiwen\/auto-tab-discard\/issues\/new/);
  assert.match(documentation, /no query, fragment, version, install reason, extension ID, tab data/i);
});

test('disabled lifecycle feedback emits no tab or uninstall navigation', async () => {
  const created = [];
  const uninstall = [];
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const lifecycle = createLifecycleNavigation({
      getPreferences: async defaults => ({...defaults, faqs: true, 'lifecycle-feedback': false}),
      getSelf: async () => ({installType: 'normal'}),
      runtime: {
        getManifest: () => ({version: '0.6.9.2'}),
        setUninstallURL: (url, callback) => {
          uninstall.push(url);
          callback();
        }
      },
      tabs: {create: async options => created.push(options)}
    });

    assert.deepEqual(await lifecycle.installed({reason: 'install'}), {opened: false, reason: 'disabled'});
    assert.equal(await lifecycle.configureUninstall(), '');
    assert.deepEqual(created, []);
    assert.deepEqual(uninstall, ['']);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('enabled lifecycle navigation discloses only fixed release and feedback URLs', async () => {
  const created = [];
  const uninstall = [];
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const lifecycle = createLifecycleNavigation({
      getPreferences: async defaults => ({
        ...defaults,
        faqs: true,
        'last-update': 0,
        'lifecycle-feedback': true
      }),
      getSelf: async () => ({installType: 'normal'}),
      now: () => 100 * 86400_000,
      runtime: {
        getManifest: () => ({version: '0.6.9.2', name: 'private name'}),
        setUninstallURL: (url, callback) => {
          uninstall.push(url);
          callback();
        }
      },
      tabs: {create: async options => created.push(options)}
    });

    const result = await lifecycle.installed({reason: 'update', previousVersion: 'private-version'});
    assert.deepEqual(result, {opened: true, url: RELEASE_NOTES('0.6.9.2')});
    assert.deepEqual(created, [{active: false, url: RELEASE_NOTES('0.6.9.2')}]);
    assert.equal(await lifecycle.configureUninstall(), FEEDBACK);
    assert.deepEqual(uninstall, [FEEDBACK]);
    assert.doesNotMatch(JSON.stringify({created, uninstall}), /private/i);
  }
  finally {
    delete globalThis.chrome;
  }
});
