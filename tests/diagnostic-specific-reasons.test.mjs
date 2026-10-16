import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  FAILURE_CAUSES,
  matchesFailureCausePolicy,
  matchesProtectionRulePolicy,
  PROTECTION_RULES,
  protectionRuleFor,
  protectionRuleFrom
} from '../v3/worker/core/failure-causes.mjs';
import {projectDiagnosticIncident} from '../v3/worker/core/diagnostic-journal.mjs';

const runtime = {manifest: {version: '0.6.9.2'}, userAgent: 'Mozilla/5.0 Edg/155.0.0.0'};

// Every protection reason the extension writes must name a specific rule, so a
// reworded reason cannot silently collapse back into PROTECTION_RULE.
const protectionReasons = async () => {
  const reasons = [];
  const literal = /(?:'([^'\\]*)'|`([^`\\]*)`)/;
  const number = await readFile('v3/worker/modes/number.mjs', 'utf8');
  for (const match of number.matchAll(/classify\('protected',\s*[\w.]+,\s*((?:'[^']*'|`[^`]*`))/g)) {
    reasons.push(match[1]);
  }
  const scan = await readFile('v3/worker/core/metadata-scan.mjs', 'utf8');
  const frozen = scan.slice(scan.indexOf('const frozenProtectionReason'));
  for (const match of frozen.matchAll(/return ('[^']*');/g)) reasons.push(match[1]);
  for (const match of scan.matchAll(/protectedTabs\.push\(\{tab, reason: ('[^']*'|`[^`]*`)/g)) {
    reasons.push(match[1]);
  }
  const suspended = await readFile('v3/worker/core/suspended-protection.mjs', 'utf8');
  for (const match of suspended.matchAll(/reasons\.push\(('[^']*')\)/g)) reasons.push(match[1]);
  return reasons.map(value => {
    const [, single, template] = value.match(literal);
    return (single ?? template).replace(/\$\{[^}]*\}/g, 'X');
  });
};

test('every protection reason in the extension maps to a specific protection rule', async () => {
  const reasons = await protectionReasons();
  assert.ok(reasons.length >= 30, `expected the full protection reason set, found ${reasons.length}`);
  for (const reason of reasons) {
    assert.notEqual(protectionRuleFor(reason), PROTECTION_RULES.UNSPECIFIED, reason);
  }
  assert.equal(protectionRuleFor('unsaved-form state cannot be verified while frozen'),
    PROTECTION_RULES.STATE_UNVERIFIABLE);
  assert.equal(protectionRuleFor('tab has unsaved form input'), PROTECTION_RULES.FORM_INPUT);
  assert.equal(protectionRuleFor('some future reason'), PROTECTION_RULES.UNSPECIFIED);
});

test('protection rules and failure causes stay in separate allowlists', () => {
  for (const rule of Object.values(PROTECTION_RULES)) {
    assert.equal(matchesProtectionRulePolicy('eligibility', rule), true, rule);
    assert.equal(matchesFailureCausePolicy('eligibility', rule), false, rule);
  }
  assert.equal(matchesProtectionRulePolicy('eligibility', FAILURE_CAUSES.UNSUPPORTED_PAGE), false);
  assert.equal(protectionRuleFrom({protectionRule: 'https://example.com/'}), PROTECTION_RULES.UNSPECIFIED);
  for (const cause of ['TAKEOVER_OWNERSHIP_FAILED', 'TAKEOVER_PREPARE_FAILED',
    'TAKEOVER_TARGET_CHANGED', 'TAKEOVER_WAKE_FAILED']) {
    assert.equal(matchesFailureCausePolicy('takeover', cause), true, cause);
  }
});

test('incidents group protected tabs by their specific rule and drop forged rules', () => {
  const incident = projectDiagnosticIncident({
    command: 'discard-window',
    endedAt: 1_792_000_006_000,
    incidentId: 'ATD-TEST-1',
    outcomes: {
      1: {code: 'TAB_PROTECTED', protectionRule: 'PROTECTED_STATE_UNVERIFIABLE', status: 'skipped', tabId: 1},
      2: {code: 'TAB_PROTECTED', protectionRule: 'PROTECTED_STATE_UNVERIFIABLE', status: 'skipped', tabId: 2},
      3: {code: 'TAB_PROTECTED', protectionRule: 'PROTECTED_FORM_INPUT', status: 'skipped', tabId: 3},
      4: {code: 'TAB_PROTECTED', protectionRule: 'tab title leaked here', status: 'skipped', tabId: 4},
      5: {code: 'TAB_FAILED', failureCause: 'TAKEOVER_WAKE_FAILED', status: 'failed', tabId: 5}
    },
    startedAt: 1_792_000_000_000,
    state: 'partial',
    total: 5
  }, runtime);
  const groups = Object.fromEntries(incident.groups.map(group => [group.reasonCode, group.count]));
  assert.deepEqual(groups, {
    PROTECTED_FORM_INPUT: 1,
    PROTECTED_STATE_UNVERIFIABLE: 2,
    PROTECTION_RULE: 1,
    TAKEOVER_WAKE_FAILED: 1
  });
  assert.ok(incident.groups.filter(group => group.code === 'TAB_PROTECTED')
    .every(group => group.stage === 'eligibility'));
});

test('takeover failures are labeled with the step that was running', async () => {
  const source = await readFile('v3/worker/core/discard.mjs', 'utf8');
  const takeover = source.slice(source.indexOf('const takeoverOnce = async'),
    source.indexOf('const takeoverJobs = new Map()'));
  assert.match(takeover, /let step = FAILURE_CAUSES\.TAKEOVER_FAILED;/);
  assert.match(takeover, /step = FAILURE_CAUSES\.TAKEOVER_WAKE_FAILED;\s*awake = await runPhase\('network'/);
  assert.match(takeover, /step = FAILURE_CAUSES\.TAKEOVER_PREPARE_FAILED;\s*return await runPhase\('cpu'/);
  assert.match(takeover, /!safeFailureCause\(e\.failureCause\)\) \{\s*e\.failureCause = step;/);
  assert.match(takeover, /no longer an inactive takeover target`,\s*FAILURE_CAUSES\.TAKEOVER_TARGET_CHANGED/);
  assert.match(takeover, /cannot start discard takeover for tab \$\{id\}`,\s*FAILURE_CAUSES\.TAKEOVER_OWNERSHIP_FAILED/);
});
