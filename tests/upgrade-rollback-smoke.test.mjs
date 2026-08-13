import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../e2e/upgrade-rollback-smoke.cjs', import.meta.url), 'utf8');

test('upgrade gate uses an isolated artifact copy and exact browser restarts', () => {
  assert.match(source, /copyTree\(baselineSource, baseline\)/);
  assert.match(source, /copyTree\(baseline, live\)/);
  assert.match(source, /overlayTree\(source, live\)/);
  assert.match(source, /overlayTree\(baseline, live\)/);
  assert.match(source, /Target\.closeTarget/);
  assert.match(source, /Browser\.close/);
  assert.match(source, /terminate\(child\)/);
  assert.match(source, /fs\.rmSync\(root/);
  assert.match(source, /ATD isolated upgrade controller/);
  assert.match(source, /chrome\.management\.getAll/);
  assert.match(source, /endsWith\('\/worker\.js'\)/);
});

test('upgrade gate proves safe reconciliation, no reload storm, restart, and rollback', () => {
  assert.match(source, /baseline-seeded/);
  assert.match(source, /updated-and-reconciled/);
  assert.match(source, /source === 'self'\)\.length, 0/);
  assert.match(source, /source === 'claimed'\)\.length, 3/);
  assert.match(source, /worker-restarted/);
  assert.match(source, /browser-restarted/);
  assert.match(source, /rolled-back/);
  assert.match(source, /counts\[label\] < 1 \|\| counts\[label\] > 2/);
  assert.match(source, /assert\.deepEqual\(fixture\.counts\(\), stableRestartCounts\)/);
  assert.match(source, /browserRestoreRequests/);
  assert.match(source, /requestTotals: fixture\.counts\(\)/);
  assert.match(source, /upgrade-canary/);
});

test('upgrade report omits extension IDs, tab IDs, profile paths, and fixture URLs', () => {
  const reportBlock = source.slice(source.indexOf('report = {', source.indexOf("outcome: 'passed'") - 500));
  assert.doesNotMatch(reportBlock, /extensionId|restoredTabs|restartedOwnership|urls|profile[,\n]/);
  assert.match(reportBlock, /profileRemoved: true/);
});

test('strict release gate requires Chrome and Edge artifact upgrade evidence', async () => {
  const gate = await readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  const invocation = id => {
    const start = gate.indexOf(`id: '${id}'`);
    assert.notEqual(start, -1, `${id} invocation is missing`);
    const end = gate.indexOf('}));', start);
    assert.notEqual(end, -1, `${id} invocation is unterminated`);
    return gate.slice(start, end + 4);
  };
  const chrome = invocation('chrome-upgrade-rollback');
  const edge = invocation('edge-upgrade-rollback');

  for (const block of [chrome, edge]) {
    assert.match(block, /upgrade-rollback-smoke\.cjs/);
    assert.match(block, /'--extension', extractedRoot, '--baseline', baselineRoot/);
    assert.match(block, /report\.baselineTreeSha256 !== baselineInventory\.treeSha256/);
  }
  assert.match(edge, /'--allow-edge'/);
  assert.match(gate, /materializeUpgradeBaseline/);
  assert.ok(gate.indexOf('materializeUpgradeBaseline({') <
    gate.indexOf("id: 'chrome-upgrade-rollback'"));
  assert.doesNotMatch(gate, /scenario is not implemented/);
});
