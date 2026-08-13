import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeUpgradeBaseline} from '../scripts/upgrade-baseline.mjs';

test('materializes the actual immutable 0.6.9.1 tag without the working tree', async t => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'atd-upgrade-baseline-'));
  t.after(() => rm(temporary, {force: true, recursive: true}));
  const result = await materializeUpgradeBaseline({
    outputDirectory: temporary,
    repositoryRoot: root
  });
  assert.equal(result.ref, 'v0.6.9.1');
  assert.equal(result.version, '0.6.9.1');
  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  assert.ok(result.files > 20);
  const manifest = JSON.parse(await readFile(path.join(temporary, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Auto Tab Discard (suspend)');
  await assert.rejects(materializeUpgradeBaseline({
    outputDirectory: temporary,
    ref: 'HEAD',
    repositoryRoot: root
  }), /fixed version tag/);
});
