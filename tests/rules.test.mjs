import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  clearRuleCache,
  evaluateRuleList,
  RULE_LIMITS,
  ruleCacheStats,
  validateRuleList
} from '../v3/worker/core/rules.mjs';

test('safe hostname, URL regexp, and trash interval rules retain their matching semantics', () => {
  const standard = [
    'plain.example',
    're:^https?://safe\\.example/(?:articles|docs)/.*$'
  ];
  assert.equal(validateRuleList(standard).ok, true);
  assert.equal(evaluateRuleList(standard, 'plain.example', 'https://plain.example/').matched, true);
  assert.equal(evaluateRuleList(standard, 'other.example',
    'https://safe.example/articles/one').matched, true);
  assert.equal(evaluateRuleList(standard, 'other.example',
    'https://safe.example/private/one').matched, false);

  const trash = evaluateRuleList([
    'plain.example@2h',
    're:^https://safe\\.example/archive/@3d'
  ], 'safe.example', 'https://safe.example/archive/one', {format: 'trash'});
  assert.equal(trash.valid, true);
  assert.equal(trash.matched, true);
  assert.equal(trash.matchedRule.interval, '3d');
});

test('validation conservatively rejects unsafe regexp constructs and invalid syntax', () => {
  const cases = new Map([
    ['re:(a+)+$', 'nested-quantifier'],
    ['re:((a|aa))+$', 'ambiguous-alternation'],
    ['re:(?:a|aa){1,3}$', 'ambiguous-alternation'],
    ['re:a+a+', 'ambiguous-quantifiers'],
    ['re:a+ba+', 'ambiguous-expansive-quantifiers'],
    ['re:a+a{2}', 'ambiguous-quantifiers'],
    ['re:a{0,1000}ba{0,1000}', 'ambiguous-expansive-quantifiers'],
    ['re:.*middle.*', 'ambiguous-wildcards'],
    ['re:(?=secret)secret', 'unsupported-group'],
    ['re:(?!secret)public', 'unsupported-group'],
    ['re:(?<=secret)value', 'unsupported-group'],
    ['re:(?<!secret)value', 'unsupported-group'],
    ['re:(?<name>secret)', 'unsupported-group'],
    ['re:(secret)\\1', 'backreference'],
    ['re:(?<name>secret)\\k<name>', 'unsupported-group'],
    ['re:\\u0061+a+', 'ambiguous-quantifiers'],
    ['re:\\u0000', 'control-character'],
    ['re:\\x61+a+', 'ambiguous-quantifiers'],
    ['re:\\x00', 'control-character'],
    ['re:\\n', 'control-character'],
    ['re:\\cA', 'control-character'],
    ['re:\\p{Letter}+', 'unsupported-escape'],
    ['re:[\\0]', 'backreference'],
    ['re:a{1001}', 'invalid-quantifier'],
    ['re:a{2}{3}', 'nested-quantifier'],
    ['re:()*', 'empty-group'],
    ['re:(^)*', 'invalid-quantifier'],
    ['re:[abc', 'invalid-class'],
    ['re:(abc', 'unbalanced-group'],
    ['re:abc|', 'empty-alternative']
  ]);

  for (const [rule, code] of cases) {
    const result = validateRuleList([rule]);
    assert.equal(result.ok, false, rule);
    assert.equal(result.accepted.length, 0, rule);
    assert.equal(result.rejected[0].code, code, rule);
  }
});

test('rule, expression, input, nesting, and cache limits are enforced', () => {
  clearRuleCache();
  assert.equal(validateRuleList(Array(RULE_LIMITS.rules + 1).fill('example.test')).rejected[0].code,
    'too-many-rules');
  assert.equal(validateRuleList([`re:${'a'.repeat(RULE_LIMITS.patternLength + 1)}`]).rejected[0].code,
    'pattern-too-long');
  assert.equal(validateRuleList([null]).rejected[0].code, 'rule-not-string');
  assert.equal(validateRuleList('example.test').rejected[0].code, 'list-not-array');
  assert.equal(validateRuleList([`re:${'('.repeat(RULE_LIMITS.groupDepth + 1)}a${')'.repeat(
    RULE_LIMITS.groupDepth + 1)}`]).rejected[0].code, 'group-limit');

  const longInput = `https://example.test/${'x'.repeat(RULE_LIMITS.inputLength)}`;
  const inputResult = evaluateRuleList(['re:example'], 'example.test', longInput);
  assert.equal(inputResult.valid, false);
  assert.equal(inputResult.rejected[0].code, 'input-rejected');
  assert.deepEqual(ruleCacheStats(), {compilations: 0, hits: 0, misses: 0, size: 0});

  clearRuleCache();
  for (let index = 0; index < RULE_LIMITS.cacheEntries + 10; index += 1) {
    evaluateRuleList([`re:^https://cache-${index}\\.example/$`], 'cache.example',
      'https://cache.example/');
  }
  assert.equal(ruleCacheStats().size, RULE_LIMITS.cacheEntries);
});

test('validated patterns compile once per ruleset revision and rejected patterns are never compiled or tested', () => {
  const OriginalRegExp = globalThis.RegExp;
  let constructions = 0;
  globalThis.RegExp = class CountingRegExp extends OriginalRegExp {
    constructor(...args) {
      constructions += 1;
      super(...args);
    }
  };
  try {
    clearRuleCache();
    const validation = validateRuleList(['re:^https://cached\\.example/.*$']);
    assert.equal(validation.ok, true);
    assert.equal(constructions, 0,
      'the options/import hook must validate without compiling executable patterns');
    const rules = ['re:^https://cached\\.example/.*$'];
    evaluateRuleList(rules, 'cached.example', 'https://cached.example/one');
    evaluateRuleList([...rules], 'cached.example', 'https://cached.example/two');
    assert.equal(constructions, 1);
    assert.deepEqual(ruleCacheStats(), {
      compilations: 1,
      hits: 1,
      misses: 1,
      size: 1
    });

    constructions = 0;
    clearRuleCache();
    const result = evaluateRuleList(['re:(a+)+$'], 'example.test', `${'a'.repeat(2000)}!`);
    assert.equal(result.valid, false);
    assert.equal(result.matched, false);
    assert.equal(constructions, 0);
  }
  finally {
    globalThis.RegExp = OriginalRegExp;
  }
});

test('one rejected entry rejects the entire ruleset before any accepted expression is evaluated', () => {
  const result = evaluateRuleList([
    're:^https://safe\\.example/',
    're:(a+)+$'
  ], 'safe.example', 'https://safe.example/');

  assert.equal(result.valid, false);
  assert.equal(result.matched, false);
  assert.equal(result.rejected[0].index, 1);
});

test('the pure options/import hook returns position, code, rule, and reason', () => {
  clearRuleCache();
  const result = validateRuleList(['safe.example', 're:(a+)+$']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejected[0], {
    code: 'nested-quantifier',
    index: 1,
    reason: 'nested quantifiers are not allowed',
    rule: 're:(a+)+$'
  });
  assert.equal(validateRuleList(['re:^https://safe\\.example/$']).ok, true);
  assert.equal('regexp' in validateRuleList(['re:^https://safe\\.example/$']).accepted[0], false);
  assert.deepEqual(ruleCacheStats(), {compilations: 0, hits: 0, misses: 0, size: 0});
});

test('every runtime rule consumer uses the shared validator and no longer constructs user regexps', async () => {
  const [utils, suspended, trash] = await Promise.all([
    readFile(new URL('../v3/worker/core/utils.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/core/suspended-protection.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/plugins/trash/core.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(utils, /evaluateRuleList\(list, hostname, href\)/);
  assert.match(suspended, /evaluateRuleList/);
  assert.match(trash, /evaluateRuleList\(list, hostname, href, \{format: 'trash'\}\)/);
  assert.doesNotMatch(`${utils}\n${suspended}\n${trash}`, /new RegExp\s*\(/);
});
