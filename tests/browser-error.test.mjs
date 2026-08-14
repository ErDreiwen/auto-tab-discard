import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

import {
  CATEGORIES,
  classifyBrowserError,
  scriptingFailureDecision
} from '../v3/worker/core/browser-error.mjs';

const corpusUrl = new URL('./fixtures/browser-error-corpus.v1.json', import.meta.url);
const corpusText = fs.readFileSync(fileURLToPath(corpusUrl), 'utf8');
const corpus = JSON.parse(corpusText);

const materialize = template => template
  .replaceAll('{frameId}', '7')
  .replaceAll('{tabId}', '11')
  .replaceAll('{protectedUrl}', ['edge', '://', 'settings'].join(''));

const codedError = ({codeLocation, code, message}) => {
  if (codeLocation === 'cause.code') {
    return {cause: {code}, message};
  }
  return {[codeLocation]: code, message};
};

test('retained corpus is versioned, sanitized, and honest about provenance gaps', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.observations.length, 2);
  assert.deepEqual(
    corpus.observations.map(({browser}) => `${browser.product}-${browser.version}`),
    ['chrome-151.0.7922.34', 'chrome-152.0.7977.42']
  );
  assert.ok(corpus.observations.every(({browser}) => browser.locale === 'not-recorded'));
  assert.ok(corpus.observations.every(({source}) =>
    source.kind === 'passing-sanitized-browser-report' &&
    source.sampleCount > 0 &&
    /^[a-f0-9]{64}$/.test(source.reportSha256)
  ));
  assert.ok(corpus.classifierContractCases.every(({provenance}) =>
    provenance === 'synthetic-classifier-contract'
  ));
  assert.deepEqual(
    corpus.coverageNotes.map(({browser, retainedErrorSamples}) => [browser, retainedErrorSamples]),
    [['chrome', 0], ['edge', 0], ['firefox', 0]]
  );

  // The retained fixture contains templates and digests, never raw browser
  // identifiers, navigable URLs, filesystem paths, error objects, or stacks.
  assert.doesNotMatch(corpusText, /\b(?:frame|tab|window|group)\s+(?:with\s+)?(?:id\s*:?[ ]*)?\d+/i);
  assert.doesNotMatch(corpusText, /\b(?:https?|file|chrome|edge|about|moz-extension):\/\//i);
  assert.doesNotMatch(corpusText, /(?:[a-z]:\\|\\\\|\/users\/|\/home\/)/i);
  assert.doesNotMatch(corpusText, /"(?:error|rawError|stack|path)"\s*:/i);
});

test('prefers retained structured browser codes over localized or unknown messages', () => {
  for (const entry of corpus.structuredCodeCases) {
    const classification = classifyBrowserError(codedError(entry));
    assert.equal(classification.category, entry.expectedCategory, entry.id);
    assert.equal(classification.source, 'code', entry.id);
  }
});

test('classifies retained observations and labeled classifier contracts', () => {
  for (const entry of [...corpus.observations, ...corpus.classifierContractCases]) {
    const classification = classifyBrowserError(Error(materialize(entry.messageTemplate)));
    assert.equal(classification.category, entry.expectedCategory, entry.id);
    assert.equal(classification.source, 'message', entry.id);
  }
});

test('unfamiliar and localized message-only errors fail closed', () => {
  const live = {active: false, discarded: false, frozen: false, status: 'loading'};
  for (const entry of corpus.failClosedCases) {
    const error = Error(materialize(entry.messageTemplate));
    const classification = classifyBrowserError(error);
    assert.equal(classification.category, CATEGORIES.UNKNOWN, entry.id);
    assert.equal(classification.source, 'unknown', entry.id);
    assert.equal(scriptingFailureDecision(error, live).action, 'fail', entry.id);
  }
});

test('post-error state permits only a known transient frame retry', () => {
  const live = {active: false, discarded: false, frozen: false, status: 'loading'};
  const observed = materialize(corpus.observations[0].messageTemplate);
  assert.equal(scriptingFailureDecision(Error(observed), live).action, 'retry');

  for (const message of [
    'Missing host permission for the tab.',
    'Blocked by administrator policy.',
    materialize(corpus.failClosedCases[0].messageTemplate),
    materialize(corpus.failClosedCases.at(-1).messageTemplate)
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
