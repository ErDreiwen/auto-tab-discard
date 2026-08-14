import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import vm from 'node:vm';

import {
  createFrameMetadataCollector,
  FRAME_MESSAGE_LIMIT,
  FRAME_OUTPUT_LIMIT,
  FRAME_STRESS_DURATION_LIMIT,
  FRAME_STRESS_RETAINED_BYTES_LIMIT,
  FRAME_WATCH_BATCH_SIZE,
  FRAME_WATCH_LIMIT,
  frameRequirements,
  needsAggregateFrames,
  summarizeFrameProbes
} from '../v3/worker/core/frame-metadata.mjs';

test('manifest keeps the permanent watcher top-frame-only', async () => {
  const manifest = JSON.parse(await readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8'));
  const watcher = manifest.content_scripts.find(script => script.js?.includes('/data/inject/watch.js'));
  assert.ok(watcher);
  assert.equal(watcher.all_frames, false);
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
  const collector = createFrameMetadataCollector({
    scripting: {
      async executeScript(details) {
        calls.push(details);
        return [{frameId: 0, result: {ready: true, time: 1}}];
      }
    }
  });
  const requirements = frameRequirements({audio: false, form: false, paused: false});
  assert.equal(needsAggregateFrames(requirements), false);
  assert.deepEqual(await collector.collect(42, requirements), [{ready: true, time: 1}]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, {tabId: 42});
  assert.deepEqual(calls[0].files, ['/data/inject/meta.js']);
});

test('1,000-frame fixture bounds retained output but records the open physical allFrames gap', async () => {
  const secretUrl = 'https://private-frame.invalid/account?token=frame-secret';
  const probes = [{frameId: 0, result: null}];
  for (let frameId = 1; frameId <= 1000; frameId += 1) {
    probes.push({
      documentId: `document-${frameId}`,
      frameId,
      url: `${secretUrl}-${frameId}`,
      result: {
        a: false,
        f: frameId === 1000,
        p: false,
        w: true
      }
    });
  }

  const started = performance.now();
  const summary = summarizeFrameProbes(probes, {audio: true, form: true, paused: true});
  const elapsed = performance.now() - started;
  assert.equal(summary.aggregate.forms, true, 'a protected frame at the tail must survive aggregation');
  assert.equal(summary.candidates[0].frameId, 1000, 'protected watcher candidates have priority');
  assert.equal(summary.candidates.length, FRAME_WATCH_LIMIT);
  assert.ok(elapsed < FRAME_STRESS_DURATION_LIMIT,
    `pure 1,000-frame aggregation took ${elapsed.toFixed(3)}ms`);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < FRAME_STRESS_RETAINED_BYTES_LIMIT,
    'the retained summary must not scale with the input frame count');
  assert.doesNotMatch(JSON.stringify(summary), /private-frame|frame-secret/,
    'browser-returned frame URLs must not enter retained summaries');

  const calls = [];
  let physicalProbeStarts = 0;
  const collector = createFrameMetadataCollector({
    scripting: {
      async executeScript(details) {
        calls.push(details);
        if (details.files?.includes('/data/inject/meta.js')) {
          return [{frameId: 0, result: {ready: true, time: 1}}];
        }
        if (details.func) {
          assert.equal(details.target.allFrames, true,
            'current browser-bound probe still delegates every frame to scripting');
          physicalProbeStarts += probes.length;
          return probes;
        }
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
  assert.ok(calls.length <= FRAME_MESSAGE_LIMIT);
  assert.equal(physicalProbeStarts, 1001,
    'post-result truncation must never be reported as a pre-injection physical cap');
  assert.doesNotMatch(JSON.stringify(result), /private-frame|frame-secret/,
    'worker-facing metadata must not report raw frame URLs');
  const watcherCalls = calls.filter(call => call.files?.includes('/data/inject/watch.js'));
  assert.equal(watcherCalls.length, Math.ceil(FRAME_WATCH_LIMIT / FRAME_WATCH_BATCH_SIZE));
  assert.ok(watcherCalls.some(call => call.target.frameIds.includes(1000)));
  assert.ok(watcherCalls.every(call => call.target.frameIds.length <= FRAME_WATCH_BATCH_SIZE));

  const before = calls.length;
  await collector.collect(7, {audio: true, form: true, paused: true});
  assert.equal(calls.slice(before).filter(call => call.files?.includes('/data/inject/watch.js')).length, 0,
    'known document IDs must not receive duplicate watcher injections');
});

test('frame churn fails closed and never expands the worker-facing result', async () => {
  let probe = true;
  const collector = createFrameMetadataCollector({
    scripting: {
      async executeScript(details) {
        if (details.files?.includes('/data/inject/meta.js')) {
          return [{frameId: 0, result: {ready: true}}];
        }
        if (details.func && probe) {
          probe = false;
          throw Error('frame detached');
        }
        if (details.func) {
          return [{documentId: 'changing', frameId: 9, result: {a: false, f: true, p: false, w: true}}];
        }
        throw Error('frame navigated before watcher injection');
      }
    }
  });

  assert.deepEqual(await collector.collect(8, {audio: true, form: true, paused: true}), [
    {ready: true},
    {audible: true, forms: true, paused: true}
  ]);
  const retried = await collector.collect(8, {audio: false, form: true, paused: false});
  assert.equal(retried.length, FRAME_OUTPUT_LIMIT);
  assert.equal(retried[1].forms, true);
});

test('every deferred watcher injection re-enters the guarded execute adapter', async () => {
  const rawCalls = [];
  let guardedCalls = 0;
  const scripting = {
    async executeScript(details) {
      rawCalls.push(details);
      if (details.files?.includes('/data/inject/meta.js')) {
        return [{frameId: 0, result: {ready: true}}];
      }
      if (details.func) {
        return [{
          documentId: 'late-watcher',
          frameId: 7,
          result: {a: false, f: false, p: false, w: true}
        }];
      }
      assert.fail('a watcher batch must not bypass the guarded adapter');
    }
  };
  const collector = createFrameMetadataCollector({
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
  assert.equal(guardedCalls, 3, 'top, probe, and the deferred watcher each enter the guard');
  assert.equal(rawCalls.length, 2, 'the rejected watcher never reaches raw scripting');
  assert.deepEqual(result, [{ready: true}, {audible: false, forms: false, paused: false}]);
});
