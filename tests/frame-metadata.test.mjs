import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import vm from 'node:vm';

import {
  aggregateProbeValue,
  createFrameMetadataCollector,
  createOptionalFrameEnumerator,
  FRAME_FALLBACK_RETAINED_VALUE_LIMIT,
  FRAME_FALLBACK_VALUE_LIMIT,
  FRAME_MESSAGE_LIMIT,
  FRAME_OUTPUT_LIMIT,
  FRAME_PHYSICAL_SCRIPT_LIMIT,
  FRAME_PROBE_BATCH_SIZE,
  FRAME_PROBE_FRAME_LIMIT,
  FRAME_STRESS_DURATION_LIMIT,
  FRAME_STRESS_RETAINED_BYTES_LIMIT,
  FRAME_WATCH_BATCH_SIZE,
  FRAME_WATCH_LIMIT,
  frameRequirements,
  needsAggregateFrames,
  normalizeFrameEnumeration,
  OPTIONAL_FRAME_PERMISSION,
  probeFrameProtection,
  summarizeFrameProbes
} from '../v3/worker/core/frame-metadata.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const frameDocumentId = frameId => `document-${frameId}`;
const documentedEnumeration = frameIds => ({
  complete: true,
  documents: [0, ...frameIds].map(frameId => ({
    documentId: frameDocumentId(frameId),
    frameId
  })),
  frameIds,
  granted: true
});
const topMetadata = result => ({
  documentId: frameDocumentId(0),
  frameId: 0,
  result
});

const documentFixture = ({controls = [], media = [], pip = false} = {}) => ({
  pictureInPictureElement: pip ? {} : null,
  querySelectorAll(selector) {
    return selector === 'video,audio' ? media : controls;
  },
  readyState: 'complete'
});

const frameFixture = (document = documentFixture(), children = []) => {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    dispatch(type, target) {
      const event = {
        composedPath: () => target ? [target] : [],
        target,
        type
      };
      for (const listener of listeners.get(type) || []) listener(event);
    },
    document,
    frames: children
  };
};

const withFrameGlobals = (top, task) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = top;
  globalThis.document = top.document;
  top.top = top;
  try {
    return task();
  }
  finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
};

test('manifest keeps the permanent watcher top-frame-only and frame enumeration optional', async () => {
  const manifest = JSON.parse(await readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8'));
  const watcher = manifest.content_scripts.find(script => script.js?.includes('/data/inject/watch.js'));
  assert.ok(watcher);
  assert.equal(watcher.all_frames, false);
  assert.deepEqual(manifest.optional_permissions, ['webNavigation']);
  assert.equal(manifest.permissions.includes('webNavigation'), false,
    'frame enumeration must not create a required install permission');
});

test('production code contains no allFrames scripting target', async () => {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (/\.m?js$/.test(entry.name)) files.push(candidate);
    }
  };
  await visit(path.join(repositoryRoot, 'v3'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\ballFrames\s*:/, path.relative(repositoryRoot, file));
  }
});

test('dynamic watcher injection is idempotent within one document', async () => {
  const source = await readFile(new URL('../v3/data/inject/watch.js', import.meta.url), 'utf8');
  const listeners = [];
  const context = vm.createContext({
    addEventListener(type) {
      listeners.push(type);
    },
    clearTimeout,
    console,
    Date,
    document: {querySelectorAll: () => []},
    setTimeout,
    window: {}
  });
  vm.runInContext(source, context);
  const initial = [...listeners];
  vm.runInContext(source, context);
  assert.deepEqual(listeners, initial);
});

test('a late watcher conservatively preserves pre-injection rich-editor state', async () => {
  const source = await readFile(new URL('../v3/data/inject/watch.js', import.meta.url), 'utf8');
  const editor = {
    innerHTML: 'possibly edited before injection',
    isConnected: true,
    isContentEditable: true,
    tagName: 'DIV'
  };
  const extensionWindow = {};
  const context = vm.createContext({
    addEventListener() {},
    clearTimeout,
    console,
    Date,
    document: {
      querySelectorAll: () => [editor],
      readyState: 'complete'
    },
    setTimeout,
    window: extensionWindow
  });
  vm.runInContext(source, context);
  assert.equal(extensionWindow.isReceivingFormInput, true);
});

test('subframe probes are disabled unless form or media protection needs aggregate state', async () => {
  const calls = [];
  let enumerations = 0;
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => {
      enumerations += 1;
      return {complete: true, frameIds: [1], granted: true};
    },
    scripting: {
      async executeScript(details) {
        calls.push(details);
        return [{frameId: 0, result: {ready: true, subframes: true, time: 1}}];
      }
    }
  });
  const requirements = frameRequirements({audio: false, form: false, paused: false});
  assert.equal(needsAggregateFrames(requirements), false);
  assert.deepEqual(await collector.collect(42, requirements), [{ready: true, subframes: true, time: 1}]);
  assert.equal(enumerations, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, {tabId: 42});
  assert.deepEqual(calls[0].files, ['/data/inject/meta.js']);
  assert.deepEqual(requirements, {audio: false, form: false, paused: false},
    'top-document readiness must not become a new subframe permission requirement');
});

test('frameless pages need no permission check or second renderer script', async () => {
  let enumerations = 0;
  let starts = 0;
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => {
      enumerations += 1;
      throw Error('must not enumerate a frameless document');
    },
    scripting: {
      async executeScript() {
        starts += 1;
        return [{frameId: 0, result: {ready: true, subframes: false}}];
      }
    }
  });
  assert.deepEqual(await collector.collect(3, {audio: true, form: true, paused: true}), [
    {ready: true, subframes: false}
  ]);
  assert.equal(enumerations, 0);
  assert.equal(starts, 1);
});

test('frame enumeration strips URLs, sorts IDs, deduplicates, and rejects malformed snapshots', () => {
  const secret = 'https://private-frame.invalid/account?token=frame-secret';
  const normalized = normalizeFrameEnumeration([
    {frameId: 9, url: secret},
    {frameId: 0, url: `${secret}#top`},
    {frameId: 2, url: `${secret}#two`},
    {frameId: 9, url: `${secret}#duplicate`}
  ]);
  assert.deepEqual(normalized, {complete: false, frameIds: [2, 9]},
    'duplicate raw frame records indicate an unstable snapshot');
  assert.doesNotMatch(JSON.stringify(normalized), /private-frame|frame-secret/);
  assert.deepEqual(normalizeFrameEnumeration([{frameId: 1}, {frameId: 'bad'}]), {
    complete: false,
    frameIds: [1]
  });
  assert.deepEqual(normalizeFrameEnumeration(null), {complete: false, frameIds: []});

  const identified = normalizeFrameEnumeration([
    {documentId: 'child-four', frameId: 4, url: `${secret}#four`},
    {documentId: 'top-document', frameId: 0, url: `${secret}#identified-top`},
    {documentId: 'child-one', frameId: 1, url: `${secret}#one`}
  ]);
  assert.deepEqual(identified, {
    complete: true,
    documents: [
      {documentId: 'top-document', frameId: 0},
      {documentId: 'child-one', frameId: 1},
      {documentId: 'child-four', frameId: 4}
    ],
    frameIds: [1, 4]
  });
  assert.doesNotMatch(JSON.stringify(identified), /private-frame|frame-secret/);
  assert.equal(normalizeFrameEnumeration([
    {documentId: 'same-document', frameId: 0},
    {documentId: 'same-document', frameId: 1}
  ]).complete, false, 'duplicate document identities are not a stable snapshot');
  assert.equal(normalizeFrameEnumeration([
    {documentId: 'top-document', frameId: 0},
    {frameId: 1}
  ]).complete, false, 'mixed identity support must not silently downgrade to frame IDs');
});

test('optional enumerator supports callback and Promise APIs and never enumerates without a grant', async t => {
  for (const semantics of ['callback', 'promise']) {
    await t.test(semantics, async () => {
      let frameCalls = 0;
      let permissionRequest;
      const browser = {
        permissions: {
          contains(request, callback) {
            permissionRequest = request;
            if (semantics === 'callback') callback(true);
            else return Promise.resolve(true);
          }
        },
        runtime: {},
        webNavigation: {
          getAllFrames(details, callback) {
            frameCalls += 1;
            const value = [
              {documentId: 'child-four', frameId: 4, url: 'https://secret.invalid/four'},
              {documentId: 'top-document', frameId: 0, url: 'https://secret.invalid/top'},
              {documentId: 'child-one', frameId: 1, url: 'https://secret.invalid/one'}
            ];
            if (semantics === 'callback') callback(value);
            else return Promise.resolve(value);
          }
        }
      };
      const enumerate = createOptionalFrameEnumerator(browser);
      assert.deepEqual(await enumerate(77), {
        complete: true,
        documents: [
          {documentId: 'top-document', frameId: 0},
          {documentId: 'child-one', frameId: 1},
          {documentId: 'child-four', frameId: 4}
        ],
        frameIds: [1, 4],
        granted: true
      });
      assert.deepEqual(permissionRequest, OPTIONAL_FRAME_PERMISSION);
      assert.equal(frameCalls, 1);
    });
  }

  let deniedFrameCalls = 0;
  const denied = createOptionalFrameEnumerator({
    permissions: {contains: async () => false},
    runtime: {},
    webNavigation: {getAllFrames: async () => {
      deniedFrameCalls += 1;
      return [];
    }}
  });
  assert.deepEqual(await denied(8), {complete: false, frameIds: [], granted: false});
  assert.equal(deniedFrameCalls, 0);
});

test('no-grant tree probe is useful for bounded same-origin frames and fails closed by branch', () => {
  const safeInput = {
    defaultValue: 'unchanged',
    tagName: 'INPUT',
    type: 'text',
    value: 'unchanged'
  };
  const safeMedia = {currentTime: 0, paused: true};
  const nested = frameFixture(documentFixture({controls: [safeInput], media: [safeMedia]}));
  const child = frameFixture(documentFixture(), [nested]);
  const top = frameFixture(documentFixture(), [child]);
  const requirements = {audio: true, form: true, paused: true};
  const safe = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.deepEqual(safe, {a: false, f: false, p: false, w: true});
  const warmed = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.deepEqual(warmed, {a: false, f: false, p: false, w: false});

  nested.dispatch('input', {tagName: 'DIV'});
  const unrelatedEvent = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.equal(unrelatedEvent.f, false,
    'an unrelated custom input event must not create rich-editor uncertainty');

  safeInput.value = 'edited';
  nested.dispatch('input', safeInput);
  const eventDirty = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.equal(eventDirty.f, true, 'the fallback watcher retains edits after its warm-up scan');

  safeInput.value = safeInput.defaultValue;
  nested.dispatch('input', safeInput);
  const reverted = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.equal(reverted.f, false,
    'a bounded ordinary-control baseline must recognize a real edit reversal');

  safeInput.value = 'unsaved';
  const dirty = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.equal(dirty.f, true, 'same-origin nested form state remains protected without a grant');

  const inaccessible = {frames: []};
  Object.defineProperty(inaccessible, 'document', {
    get() {
      throw Error('cross-origin');
    }
  });
  const crossOriginTop = frameFixture(documentFixture(), [inaccessible]);
  const unknown = withFrameGlobals(crossOriginTop, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.deepEqual(unknown, {a: true, f: true, p: true, w: false});
});

test('no-grant warm-up finds a rich editor after a dirty control and never calls it clean', () => {
  const input = {
    defaultValue: 'original',
    isConnected: true,
    tagName: 'INPUT',
    type: 'text',
    value: 'dirty'
  };
  const editor = {
    isConnected: true,
    isContentEditable: true,
    tagName: 'DIV'
  };
  const child = frameFixture(documentFixture({controls: [input, editor]}));
  const top = frameFixture(documentFixture(), [child]);
  const requirements = {audio: false, form: true, paused: false};
  const first = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  input.value = input.defaultValue;
  child.dispatch('input', input);
  const second = withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.equal(first.f, true);
  assert.equal(second.f, true,
    'late contenteditable uncertainty must survive the earlier control reverting');
});

test('no-grant fallback ignores an explicitly inert contenteditable=false element', () => {
  const inert = {
    getAttribute(name) {
      return name === 'contenteditable' ? 'false' : null;
    },
    isContentEditable: false,
    tagName: 'DIV'
  };
  const child = frameFixture(documentFixture({controls: [inert]}));
  const top = frameFixture(documentFixture(), [child]);
  const requirements = {audio: false, form: true, paused: false};
  const probe = () => withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {controls: 64, frames: FRAME_PROBE_FRAME_LIMIT, media: 32},
    'tree'
  ));
  assert.deepEqual(probe(), {a: false, f: false, p: false, w: false});
  assert.deepEqual(probe(), {a: false, f: false, p: false, w: false});
});

test('no-grant fallback prunes detached baselines but fails closed on oversized retained values', () => {
  const controls = Array.from({length: FRAME_PROBE_FRAME_LIMIT}, (_, index) => ({
    defaultValue: `value-${index}`,
    isConnected: true,
    tagName: 'INPUT',
    type: 'text',
    value: `value-${index}`
  }));
  const child = frameFixture(documentFixture({controls}));
  const top = frameFixture(documentFixture(), [child]);
  const requirements = {audio: false, form: true, paused: false};
  const probe = () => withFrameGlobals(top, () => probeFrameProtection(
    requirements,
    {
      controls: FRAME_PROBE_FRAME_LIMIT,
      frames: FRAME_PROBE_FRAME_LIMIT,
      media: 32,
      retainedValueChars: FRAME_FALLBACK_RETAINED_VALUE_LIMIT,
      valueChars: FRAME_FALLBACK_VALUE_LIMIT
    },
    'tree'
  ));
  assert.equal(probe().w, true);
  assert.equal(probe().f, false);

  controls[0].isConnected = false;
  const replacement = {
    defaultValue: 'replacement',
    isConnected: true,
    tagName: 'INPUT',
    type: 'text',
    value: 'replacement'
  };
  controls[0] = replacement;
  child.dispatch('beforeinput', replacement);
  replacement.value = 'edited';
  child.dispatch('input', replacement);
  assert.equal(probe().f, true);
  replacement.value = replacement.defaultValue;
  child.dispatch('input', replacement);
  assert.equal(probe().f, false,
    'detached controls must release one bounded baseline slot for a reversible replacement');

  const oversized = 'x'.repeat(FRAME_FALLBACK_VALUE_LIMIT + 1);
  controls[1].isConnected = false;
  const oversizedControl = {
    defaultValue: oversized,
    isConnected: true,
    tagName: 'INPUT',
    type: 'text',
    value: oversized
  };
  controls[1] = oversizedControl;
  assert.equal(probe().f, true,
    'a value too large to retain within the fixed baseline budget must fail closed');
  assert.equal(probe().f, true, 'retention overflow remains fail closed for this document');
});

test('no-grant collector warms one bounded watcher scan then keeps a safe framed page eligible', async () => {
  const calls = [];
  let installed = false;
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => ({complete: false, frameIds: [], granted: false}),
    scripting: {
      async executeScript(details) {
        calls.push(details);
        if (details.files?.includes('/data/inject/meta.js')) {
          return [{frameId: 0, result: {ready: true, subframes: true}}];
        }
        assert.deepEqual(details.target, {tabId: 19});
        assert.equal(details.args[2], 'tree');
        const w = !installed;
        installed = true;
        return [{frameId: 0, result: {a: false, f: false, p: false, w}}];
      }
    }
  });
  assert.deepEqual(await collector.collect(19, {audio: true, form: true, paused: true}), [
    {ready: true, subframes: true},
    {audible: false, forms: true, paused: false}
  ]);
  assert.deepEqual(await collector.collect(19, {audio: true, form: true, paused: true}), [
    {ready: true, subframes: true},
    {audible: false, forms: false, paused: false}
  ]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => !Object.hasOwn(call.target, 'allFrames')));
});

test('1,000-subframe enumeration starts no subframe script and returns protected unknown', async () => {
  const secretUrl = 'https://private-frame.invalid/account?token=frame-secret';
  const rawFrames = [{documentId: frameDocumentId(0), frameId: 0, url: secretUrl}];
  for (let frameId = 1; frameId <= 1000; frameId += 1) {
    rawFrames.push({
      documentId: frameDocumentId(frameId),
      frameId,
      url: `${secretUrl}-${frameId}`
    });
  }
  const enumeration = {granted: true, ...normalizeFrameEnumeration(rawFrames)};
  let physicalStarts = 0;
  const calls = [];
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => enumeration,
    scripting: {
      async executeScript(details) {
        calls.push(details);
        physicalStarts += details.target.frameIds?.length || 1;
        assert.deepEqual(details.target, {tabId: 7},
          'over-cap enumeration must not start a targeted probe');
        return [topMetadata({ready: true, subframes: true})];
      }
    }
  });
  const result = await collector.collect(7, {audio: true, form: true, paused: true});
  assert.deepEqual(result, [
    {ready: true, subframes: true},
    {audible: true, forms: true, paused: true}
  ]);
  assert.equal(calls.length, 1);
  assert.equal(physicalStarts, 1);
  assert.ok(physicalStarts <= FRAME_PHYSICAL_SCRIPT_LIMIT);
  assert.doesNotMatch(JSON.stringify({enumeration, result}), /private-frame|frame-secret/);
});

test('64-subframe boundary has an exact 97-start end-to-end cap and preserves tail protection', async () => {
  const calls = [];
  let physicalStarts = 0;
  let enumerations = 0;
  const frameIds = Array.from({length: FRAME_PROBE_FRAME_LIMIT}, (_, index) => index + 1);
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => {
      enumerations += 1;
      return documentedEnumeration(frameIds);
    },
    scripting: {
      async executeScript(details) {
        calls.push(details);
        physicalStarts += details.target.frameIds?.length || 1;
        assert.equal(Object.hasOwn(details.target, 'allFrames'), false);
        if (details.files?.includes('/data/inject/meta.js')) {
          return [topMetadata({ready: true, subframes: true, time: 1})];
        }
        if (details.func) {
          assert.equal(details.args[2], 'frame');
          assert.ok(details.target.frameIds.length <= FRAME_PROBE_BATCH_SIZE);
          return details.target.frameIds.map(frameId => ({
            documentId: `document-${frameId}`,
            frameId,
            result: {
              a: false,
              f: frameId === FRAME_PROBE_FRAME_LIMIT,
              p: false,
              w: frameId < FRAME_WATCH_LIMIT || frameId === FRAME_PROBE_FRAME_LIMIT
            }
          }));
        }
        assert.ok(details.target.frameIds.length <= FRAME_WATCH_BATCH_SIZE);
        return details.target.frameIds.map(frameId => ({
          documentId: `document-${frameId}`,
          frameId,
          result: undefined
        }));
      }
    }
  });
  const result = await collector.collect(7, {audio: true, form: true, paused: true});
  assert.equal(result.length, FRAME_OUTPUT_LIMIT);
  assert.equal(result[1].forms, true);
  assert.equal(calls.length, FRAME_MESSAGE_LIMIT);
  assert.equal(physicalStarts, FRAME_PHYSICAL_SCRIPT_LIMIT);
  assert.equal(enumerations, 2, 'the exact frame set is revalidated after batched probes');
  const watcherCalls = calls.filter(call => call.files?.includes('/data/inject/watch.js'));
  assert.equal(watcherCalls.length, Math.ceil(FRAME_WATCH_LIMIT / FRAME_WATCH_BATCH_SIZE));
  assert.ok(watcherCalls.some(call => call.target.frameIds.includes(FRAME_PROBE_FRAME_LIMIT)),
    'the protected tail frame must receive a watcher before clean candidates');
});

test('targeted probe churn fails closed and starts zero watcher scripts', async () => {
  const calls = [];
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => documentedEnumeration([1, 2, 3]),
    scripting: {
      async executeScript(details) {
        calls.push(details);
        if (details.files?.includes('/data/inject/meta.js')) {
          return [topMetadata({ready: true, subframes: true})];
        }
        if (details.func) {
          return [1, 2].map(frameId => ({
            documentId: frameDocumentId(frameId),
            frameId,
            result: {a: false, f: false, p: false, w: true}
          }));
        }
        assert.fail('an incomplete probe must not inject any watcher');
      }
    }
  });
  assert.deepEqual(await collector.collect(8, {audio: true, form: true, paused: true}), [
    {ready: true, subframes: true},
    {audible: true, forms: true, paused: true}
  ]);
  assert.equal(calls.filter(call => call.files?.includes('/data/inject/watch.js')).length, 0);
});

test('malformed probe values and inexact top/fallback cardinality fail closed', async () => {
  const requirements = {audio: true, form: true, paused: true};
  assert.deepEqual(aggregateProbeValue({}, requirements), {
    audible: true,
    forms: true,
    paused: true
  });
  const malformed = summarizeFrameProbes([
    {frameId: 1, result: {}}
  ], requirements, {expectedFrameIds: [1]});
  assert.equal(malformed.incomplete, true);
  assert.deepEqual(malformed.aggregate, {
    audible: true,
    forms: true,
    paused: true
  });

  let enumerations = 0;
  const invalidTop = createFrameMetadataCollector({
    enumerateFrames: async () => {
      enumerations += 1;
      return {complete: false, frameIds: [], granted: false};
    },
    scripting: {
      async executeScript() {
        return [
          {frameId: 0, result: {ready: true, subframes: true}},
          {frameId: 1, result: {ready: true, subframes: false}}
        ];
      }
    }
  });
  await assert.rejects(invalidTop.collect(90, requirements), error =>
    error?.code === 'FRAME_TOP_METADATA_INCOMPLETE' &&
    error.message === 'top-frame metadata result was incomplete');
  assert.equal(enumerations, 0);

  let calls = 0;
  const invalidFallback = createFrameMetadataCollector({
    enumerateFrames: async () => ({complete: false, frameIds: [], granted: false}),
    scripting: {
      async executeScript(details) {
        calls += 1;
        return details.files ?
          [{frameId: 0, result: {ready: true, subframes: true}}] :
          [{frameId: 2, result: {a: false, f: false, p: false, w: false}}];
      }
    }
  });
  assert.deepEqual(await invalidFallback.collect(91, requirements), [
    {ready: true, subframes: true},
    {audible: true, forms: true, paused: true}
  ]);
  assert.equal(calls, 2);
});

test('watcher rejection or result-set mismatch protects forms and commits no new watcher cache', async () => {
  let watcherAttempt = 0;
  let probeAttempt = 0;
  let installed = false;
  const calls = [];
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => documentedEnumeration([5]),
    scripting: {
      async executeScript(details) {
        calls.push(details);
        if (details.files?.includes('/data/inject/meta.js')) {
          return [topMetadata({ready: true, subframes: true})];
        }
        if (details.func) {
          probeAttempt += 1;
          return [{
            documentId: frameDocumentId(5),
            frameId: 5,
            result: {a: false, f: false, p: false, w: !installed}
          }];
        }
        watcherAttempt += 1;
        if (watcherAttempt === 1) {
          return [];
        }
        installed = true;
        return [{frameId: 5, documentId: frameDocumentId(5)}];
      }
    }
  });
  const first = await collector.collect(22, {audio: false, form: true, paused: false});
  assert.equal(first[1].forms, true, 'an inexact watcher result cannot leave a clean form decision');
  const second = await collector.collect(22, {audio: false, form: true, paused: false});
  assert.equal(second[1].forms, true,
    'even a successful first watcher leaves this scan protected against the pre-injection race');
  const third = await collector.collect(22, {audio: false, form: true, paused: false});
  assert.equal(third[1].forms, false);
  assert.equal(watcherAttempt, 2,
    'the failed first watcher must not be cached as installed');
  assert.equal(probeAttempt, 3);
});

test('Chrome 102 granted snapshots without document IDs fail closed before subframe scripts', async () => {
  const frameIds = Array.from({length: FRAME_WATCH_LIMIT + 1}, (_, index) => index + 1);
  let starts = 0;
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => ({complete: true, frameIds, granted: true}),
    scripting: {
      async executeScript(details) {
        starts += details.target.frameIds?.length || 1;
        if (details.files?.includes('/data/inject/meta.js')) {
          return [{frameId: 0, result: {ready: true, subframes: true}}];
        }
        assert.fail('identity-less granted enumeration must not start a subframe script');
      }
    }
  });
  assert.deepEqual(await collector.collect(23, {audio: true, form: true, paused: true}), [
    {ready: true, subframes: true},
    {audible: true, forms: true, paused: true}
  ]);
  assert.equal(starts, 1,
    'Chrome 102 compatibility stays safe without consuming the subframe script budget');
});

test('granted document identities bind top metadata, every probe, and the verified snapshot', async t => {
  const requirements = {audio: true, form: true, paused: true};
  const expectedUnknown = [
    {ready: true, subframes: true},
    {audible: true, forms: true, paused: true}
  ];

  await t.test('top document changed before enumeration', async () => {
    let starts = 0;
    const collector = createFrameMetadataCollector({
      enumerateFrames: async () => documentedEnumeration([1]),
      scripting: {
        async executeScript(details) {
          starts += details.target.frameIds?.length || 1;
          if (details.files?.includes('/data/inject/meta.js')) {
            return [{
              documentId: 'top-before-navigation',
              frameId: 0,
              result: {ready: true, subframes: true}
            }];
          }
          assert.fail('a stale top result must stop before subframe probing');
        }
      }
    });
    assert.deepEqual(await collector.collect(24, requirements), expectedUnknown);
    assert.equal(starts, 1);
  });

  for (const [label, probeDocumentId] of [
    ['missing probe identity', undefined],
    ['mismatched probe identity', 'replacement-before-probe']
  ]) {
    await t.test(label, async () => {
      let enumerations = 0;
      let watcherStarts = 0;
      const collector = createFrameMetadataCollector({
        enumerateFrames: async () => {
          enumerations += 1;
          return documentedEnumeration([1]);
        },
        scripting: {
          async executeScript(details) {
            if (details.files?.includes('/data/inject/meta.js')) {
              return [topMetadata({ready: true, subframes: true})];
            }
            if (details.func) {
              return [{
                ...(probeDocumentId === undefined ? {} : {documentId: probeDocumentId}),
                frameId: 1,
                result: {a: false, f: false, p: false, w: true}
              }];
            }
            watcherStarts += details.target.frameIds.length;
            return [];
          }
        }
      });
      assert.deepEqual(await collector.collect(25, requirements), expectedUnknown);
      assert.equal(enumerations, 1, 'an unbound probe must stop before the second snapshot');
      assert.equal(watcherStarts, 0);
    });
  }

  await t.test('same frame ID replaced after probe', async () => {
    let enumerations = 0;
    let watcherStarts = 0;
    const collector = createFrameMetadataCollector({
      enumerateFrames: async () => {
        const enumeration = documentedEnumeration([1]);
        if (++enumerations === 2) {
          enumeration.documents[1] = {
            documentId: 'replacement-after-probe',
            frameId: 1
          };
        }
        return enumeration;
      },
      scripting: {
        async executeScript(details) {
          if (details.files?.includes('/data/inject/meta.js')) {
            return [topMetadata({ready: true, subframes: true})];
          }
          if (details.func) {
            return [{
              documentId: frameDocumentId(1),
              frameId: 1,
              result: {a: false, f: false, p: false, w: true}
            }];
          }
          watcherStarts += details.target.frameIds.length;
          return [];
        }
      }
    });
    assert.deepEqual(await collector.collect(26, requirements), expectedUnknown);
    assert.equal(enumerations, 2);
    assert.equal(watcherStarts, 0,
      'document replacement must fail closed before any watcher injection');
  });
});

test('post-probe frame-set churn and watcher document replacement both fail closed', async t => {
  await t.test('frame set changed', async () => {
    let enumerations = 0;
    let watcherStarts = 0;
    const collector = createFrameMetadataCollector({
      enumerateFrames: async () => documentedEnumeration(
        ++enumerations === 1 ? [1] : [1, 2]
      ),
      scripting: {
        async executeScript(details) {
          if (details.files?.includes('/data/inject/meta.js')) {
            return [topMetadata({ready: true, subframes: true})];
          }
          if (details.func) {
            return [{
              documentId: frameDocumentId(1),
              frameId: 1,
              result: {a: false, f: false, p: false, w: true}
            }];
          }
          watcherStarts += details.target.frameIds.length;
          return [];
        }
      }
    });
    const result = await collector.collect(31, {audio: false, form: true, paused: false});
    assert.equal(result[1].forms, true);
    assert.equal(watcherStarts, 0);
  });

  await t.test('document changed at watcher boundary', async () => {
    const collector = createFrameMetadataCollector({
      enumerateFrames: async () => documentedEnumeration([4]),
      scripting: {
        async executeScript(details) {
          if (details.files?.includes('/data/inject/meta.js')) {
            return [topMetadata({ready: true, subframes: true})];
          }
          if (details.func) {
            return [{
              documentId: frameDocumentId(4),
              frameId: 4,
              result: {a: false, f: false, p: false, w: true}
            }];
          }
          return [{documentId: 'replacement-document', frameId: 4}];
        }
      }
    });
    const result = await collector.collect(32, {audio: false, form: true, paused: false});
    assert.equal(result[1].forms, true);
  });
});

test('enumeration errors fail closed without falling through to a tree or partial probe', async () => {
  const calls = [];
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => {
      throw Error('permission state changed');
    },
    scripting: {
      async executeScript(details) {
        calls.push(details);
        return [{frameId: 0, result: {ready: true, subframes: true}}];
      }
    }
  });
  assert.deepEqual(await collector.collect(11, {audio: false, form: true, paused: false}), [
    {ready: true, subframes: true},
    {audible: false, forms: true, paused: false}
  ]);
  assert.equal(calls.length, 1);
});

test('pure 1,000-result aggregation remains bounded and omits browser-returned URLs', () => {
  const secretUrl = 'https://private-frame.invalid/account?token=frame-secret';
  const probes = [];
  for (let frameId = 1; frameId <= 1000; frameId += 1) {
    probes.push({
      documentId: `document-${frameId}`,
      frameId,
      url: `${secretUrl}-${frameId}`,
      result: {a: false, f: frameId === 1000, p: false, w: true}
    });
  }
  const started = performance.now();
  const summary = summarizeFrameProbes(probes, {audio: true, form: true, paused: true});
  const elapsed = performance.now() - started;
  assert.equal(summary.aggregate.forms, true);
  assert.equal(summary.candidates[0].frameId, 1000);
  assert.equal(summary.candidates.length, FRAME_PROBE_FRAME_LIMIT);
  assert.ok(elapsed < FRAME_STRESS_DURATION_LIMIT,
    `pure 1,000-frame aggregation took ${elapsed.toFixed(3)}ms`);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < FRAME_STRESS_RETAINED_BYTES_LIMIT);
  assert.doesNotMatch(JSON.stringify(summary), /private-frame|frame-secret/);
});

test('every deferred watcher injection re-enters the guarded execute adapter', async () => {
  const rawCalls = [];
  let guardedCalls = 0;
  const scripting = {
    async executeScript(details) {
      rawCalls.push(details);
      if (details.files?.includes('/data/inject/meta.js')) {
        return [topMetadata({ready: true, subframes: true})];
      }
      if (details.func) {
        return [{
          documentId: frameDocumentId(7),
          frameId: 7,
          result: {a: false, f: false, p: false, w: true}
        }];
      }
      assert.fail('a watcher batch must not bypass the guarded adapter');
    }
  };
  const collector = createFrameMetadataCollector({
    enumerateFrames: async () => documentedEnumeration([7]),
    execute: details => {
      guardedCalls += 1;
      if (guardedCalls > 2) {
        return Promise.reject(Object.assign(Error('orphan fence appeared'), {
          code: 'DIRECT_NATIVE_ORPHAN_BLOCKED'
        }));
      }
      return scripting.executeScript(details);
    },
    scripting
  });

  const result = await collector.collect(88, {audio: false, form: true, paused: false});
  assert.equal(guardedCalls, 3, 'top, probe, and deferred watcher each enter the guard');
  assert.equal(rawCalls.length, 2, 'the rejected watcher never reaches raw scripting');
  assert.deepEqual(result, [
    {ready: true, subframes: true},
    {audible: false, forms: true, paused: false}
  ]);
});
