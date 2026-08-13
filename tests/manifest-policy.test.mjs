import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, readdir} from 'node:fs/promises';

import {lintManifestPolicy, loadAndLintManifestPolicy} from '../scripts/manifest-policy.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('current manifest passes static policy with a distinct fork identity', async () => {
  const {report} = await loadAndLintManifestPolicy(repositoryRoot);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.permissionReport.permissions.added, []);
  assert.deepEqual(report.permissionReport.permissions.removed, []);
  assert.deepEqual(report.permissionReport.hostPermissions.added, []);
  assert.deepEqual(report.permissionReport.hostPermissions.removed, []);
  assert.equal(report.independentSubmissionReady, true);
  assert.deepEqual(report.blockers, []);
});

test('static policy reports permission changes and unsafe store metadata', async () => {
  const {manifest, baseline, policy} = await loadAndLintManifestPolicy(repositoryRoot);
  const changed = structuredClone(manifest);
  changed.name = 'Unexpected Fork Name';
  changed.permissions = [...changed.permissions, 'tabs'];
  changed.host_permissions = [...changed.host_permissions, 'https://example.invalid/*'];
  changed.update_url = 'https://example.invalid/update.xml';
  changed.background.service_worker = 'https://example.invalid/worker.js';
  changed.homepage_url = 'https://webextension.org/listing/tab-discard.html';
  changed.browser_specific_settings.gecko.id = policy.upstreamGeckoId;
  const report = lintManifestPolicy({manifest: changed, baseline, policy});
  assert.ok(report.errors.some(error => error.startsWith('manifest name mismatch:')));
  assert.ok(report.errors.includes('forbidden manifest key: update_url'));
  assert.ok(report.errors.includes('permissions exceed release policy: tabs'));
  assert.ok(report.errors.includes('host_permissions exceed release policy: https://example.invalid/*'));
  assert.ok(report.errors.includes('background.service_worker must be a local ES module'));
  assert.ok(report.permissionReport.permissions.added.includes('tabs'));
  assert.ok(report.permissionReport.hostPermissions.added.includes('https://example.invalid/*'));
  assert.ok(report.blockers.includes('manifest still uses the upstream Gecko ID'));
  assert.ok(report.blockers.includes('manifest does not use the release policy fork Gecko ID'));
  assert.ok(report.blockers.includes('manifest does not use the release policy fork homepage'));
});

test('content code has no page-data network or external-extension egress', async () => {
  const roots = [
    path.join(repositoryRoot, 'v3', 'data', 'inject'),
    path.join(repositoryRoot, 'v3', 'data', 'lazy.js')
  ];
  const files = [];
  for (const root of roots) {
    if (root.endsWith('.js')) files.push(root);
    else for (const name of await readdir(root)) if (/\.m?js$/.test(name)) files.push(path.join(root, name));
  }
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source,
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\bimport\s*\(\s*['"]https?:/,
      path.relative(repositoryRoot, file));
    assert.doesNotMatch(source, /runtime\.sendMessage\s*\(\s*['"][^'"]+@/,
      path.relative(repositoryRoot, file));
  }
});
