import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {
  TERMINATION_BOUNDARIES,
  WorkerDebugger,
  breakpointLines
} = require('../e2e/edge-direct-native-races.cjs');

const extension = fileURLToPath(new URL('../v3/', import.meta.url));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const workerInfo = Object.freeze({
  targetId: 'worker-target',
  type: 'service_worker',
  url: `chrome-extension://${extensionId}/worker/core.mjs`
});

const stageDefinitions = lines => {
  const definitions = new Map();
  for (const definition of Object.values(lines)) {
    const url = `chrome-extension://${extensionId}/${definition.relative}`;
    const lineNumbers = definitions.get(url) || new Set();
    lineNumbers.add(definition.lineNumber);
    definitions.set(url, lineNumbers);
  }
  return definitions;
};

class FakeRawCdp {
  constructor({
    deferBreakpointResponse,
    earlyResolutions = false,
    locations = 'empty',
    requireRuntimeStarted = false,
    targetInfoError = false,
    targetInfos = [],
    validateLines = false
  } = {}) {
    this.deferBreakpointResponse = deferBreakpointResponse;
    this.deferredBreakpointResponse = undefined;
    this.earlyResolutions = earlyResolutions;
    this.handlers = new Map();
    this.locations = locations;
    this.requireRuntimeStarted = requireRuntimeStarted;
    this.targetInfoError = targetInfoError;
    this.targetInfos = targetInfos;
    this.validateLines = validateLines;
    this.expectedLines = stageDefinitions(breakpointLines(extension));
    this.breakpointCalls = [];
    this.breakpointSequence = 0;
    this.sent = [];
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  emit(method, params, sessionId) {
    for (const handler of this.handlers.get(method) || []) handler(params, sessionId);
  }

  async send(method, params = {}, sessionId) {
    this.sent.push({method, params, sessionId});
    if (method === 'Runtime.evaluate') {
      if (this.requireRuntimeStarted && !this.sent.some(entry =>
        entry.method === 'Runtime.runIfWaitingForDebugger' && entry.sessionId === sessionId)) {
        return {result: {value: {executeScript: false, reload: false}}};
      }
      return {result: {value: {executeScript: true, reload: true}}};
    }
    if (method === 'Target.getTargetInfo') {
      if (this.targetInfoError) throw Error('No target with given id found');
      return {targetInfo: this.targetInfos.find(info => info.targetId === params.targetId)};
    }
    if (method === 'Target.getTargets') return {targetInfos: this.targetInfos};
    if (method === 'ServiceWorker.stopWorker') {
      this.targetInfos = [];
      return {};
    }
    if (method !== 'Debugger.setBreakpointByUrl') return {};

    const expectedLines = this.expectedLines.get(params.url);
    if (this.validateLines && !expectedLines?.has(params.lineNumber)) {
      throw Error(`fake CDP rejected line ${params.lineNumber}; expected ${[...expectedLines || []]}`);
    }

    const breakpointId = `breakpoint-${++this.breakpointSequence}`;
    const call = {breakpointId, params, sessionId};
    this.breakpointCalls.push(call);
    if (this.earlyResolutions) this.resolve(call);
    if (this.deferBreakpointResponse === this.breakpointSequence) {
      await new Promise(resolve => this.deferredBreakpointResponse = resolve);
    }
    const returnedLocations = this.locations === 'empty' ? [] : [{
      columnNumber: params.columnNumber,
      lineNumber: params.lineNumber + (this.locations === 'wrong' ? 1 : 0),
      scriptId: `script-${this.breakpointSequence}`
    }];
    return {
      breakpointId,
      locations: returnedLocations
    };
  }

  resolve(call, overrides = {}) {
    this.emit('Debugger.breakpointResolved', {
      breakpointId: call.breakpointId,
      location: {
        columnNumber: call.params.columnNumber,
        lineNumber: call.params.lineNumber,
        scriptId: `resolved-${call.breakpointId}`,
        ...overrides
      }
    }, call.sessionId);
  }

  releaseBreakpointResponse() {
    assert.equal(typeof this.deferredBreakpointResponse, 'function',
      'a fake breakpoint response is waiting');
    const release = this.deferredBreakpointResponse;
    this.deferredBreakpointResponse = undefined;
    release();
  }
}

const configure = (debuggerGate, sessionId = 'session-1') =>
  debuggerGate.configure(sessionId, workerInfo, false);

const waitForCalls = async (raw, count = TERMINATION_BOUNDARIES.length) => {
  for (let attempts = 0; attempts < 100 && raw.breakpointCalls.length < count; attempts += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(raw.breakpointCalls.length, count, 'fake CDP received every breakpoint request');
};

test('empty accepted breakpoint locations never make a worker debugger ready', async () => {
  const raw = new FakeRawCdp();
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const configuration = configure(debuggerGate);
  await waitForCalls(raw);

  await assert.rejects(debuggerGate.awaitReady(40),
    /timed out waiting for extension worker debugger readiness/);
  assert.equal(debuggerGate.checkpoint().readySessions, 0);

  // Resolve the pending fake configuration so the test leaves no ten-second timer behind.
  for (const call of raw.breakpointCalls) raw.resolve(call);
  await configuration;
});

test('three delayed breakpointResolved events are all required before readiness', async () => {
  const raw = new FakeRawCdp();
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const configuration = configure(debuggerGate);
  await waitForCalls(raw);

  raw.resolve(raw.breakpointCalls[0]);
  raw.resolve(raw.breakpointCalls[1]);
  assert.equal(debuggerGate.checkpoint().readySessions, 0);

  raw.resolve(raw.breakpointCalls[2]);
  await configuration;
  await debuggerGate.awaitReady(100);
  assert.deepEqual(debuggerGate.checkpoint(), {
    beforeNativeHits: 0,
    configurationErrors: 0,
    executedNativeCalls: 0,
    readySessions: 1,
    resolvedBreakpointStages: 3,
    unexpectedPauses: 0
  });
});

test('late resolutions for a detached session cannot make it or a replacement ready', async () => {
  const raw = new FakeRawCdp({locations: 'exact'});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  await configure(debuggerGate, 'stale-session');
  await waitForCalls(raw);
  const staleCalls = [...raw.breakpointCalls];

  raw.emit('Target.detachedFromTarget', {sessionId: 'stale-session'});
  for (const call of staleCalls) raw.resolve(call);
  await assert.rejects(debuggerGate.awaitReady(40),
    /timed out waiting for extension worker debugger readiness/);

  raw.locations = 'empty';
  const replacementConfiguration = configure(debuggerGate, 'replacement-session');
  await waitForCalls(raw, TERMINATION_BOUNDARIES.length * 2);
  const replacementCalls = raw.breakpointCalls.slice(TERMINATION_BOUNDARIES.length);

  for (const call of staleCalls) raw.resolve(call);
  assert.equal(debuggerGate.checkpoint().readySessions, 0,
    'stale session events do not satisfy the replacement session keys');

  for (const call of replacementCalls) raw.resolve(call);
  await replacementConfiguration;
  await debuggerGate.awaitReady(100);
  assert.equal(debuggerGate.checkpoint().readySessions, 1);
});

test('exact locations configure telemetry only after a held worker has started', async () => {
  const raw = new FakeRawCdp({locations: 'exact', requireRuntimeStarted: true});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);

  await configure(debuggerGate);
  await debuggerGate.awaitReady(100);

  assert.equal(raw.breakpointCalls.length, TERMINATION_BOUNDARIES.length);
  assert.equal(debuggerGate.checkpoint().resolvedBreakpointStages,
    TERMINATION_BOUNDARIES.length);
  assert.equal(debuggerGate.checkpoint().readySessions, 1);
  const telemetry = raw.sent.find(entry => entry.method === 'Runtime.evaluate');
  const resume = raw.sent.findIndex(entry => entry.method === 'Runtime.runIfWaitingForDebugger');
  assert.ok(telemetry, 'count-only worker API telemetry is installed');
  assert.match(telemetry.params.expression, /executeScript/);
  assert.match(telemetry.params.expression, /reload/);
  assert.equal(telemetry.params.expression.includes('tabs.discard'), false,
    'the original native discard remains measured only by source-derived breakpoints');
  assert.ok(resume < raw.sent.indexOf(telemetry),
    'telemetry is installed only after extension API bindings become available');
});

test('a wrong returned source line is rejected when location validation is available', async () => {
  const raw = new FakeRawCdp({locations: 'wrong'});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);

  await assert.rejects(configure(debuggerGate),
    /Edge bound the before-native-invocation breakpoint to the wrong source line/);
  assert.equal(debuggerGate.checkpoint().readySessions, 0);
});

test('breakpointResolved events that beat their command responses are buffered until all three map', async () => {
  const raw = new FakeRawCdp({
    deferBreakpointResponse: TERMINATION_BOUNDARIES.length,
    earlyResolutions: true
  });
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const configuration = configure(debuggerGate);
  await waitForCalls(raw);

  const lastCall = raw.breakpointCalls.at(-1);
  assert.equal(debuggerGate.checkpoint().readySessions, 0,
    'the session cannot become ready before the final response maps its breakpoint id');
  assert.equal(debuggerGate.pendingBreakpointLocations.has(lastCall.breakpointId), true,
    'the early final resolution is buffered by breakpoint id');

  raw.releaseBreakpointResponse();
  await configuration;
  await debuggerGate.awaitReady(100);

  assert.equal(debuggerGate.pendingBreakpointLocations.size, 0);
  assert.equal(debuggerGate.checkpoint().resolvedBreakpointStages,
    TERMINATION_BOUNDARIES.length);
  assert.equal(debuggerGate.checkpoint().readySessions, 1);
});

test('worker URL parsing accepts only the exact extension host and worker path', () => {
  const raw = new FakeRawCdp();
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const accepted = [
    `chrome-extension://${extensionId}/worker/core.mjs`,
    `edge-extension://${extensionId}/worker/core.mjs`,
    `chrome-extension://${extensionId}/worker/core.mjs?generation=2`,
    `edge-extension://${extensionId}/worker/core.mjs#startup`
  ];
  const rejected = [
    `chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/worker/core.mjs`,
    `chrome-extension://${extensionId}/worker/core.mjs/extra`,
    `chrome-extension://${extensionId}/worker/Core.mjs`,
    `chrome-extension://${extensionId}/worker/core.mjsx`,
    `https://${extensionId}/worker/core.mjs`,
    'not a URL'
  ];

  for (const url of accepted) {
    assert.equal(debuggerGate.matchesWorkerURL(url), true, url);
    assert.equal(debuggerGate.isWorker({type: 'service_worker', url}), true, url);
  }
  for (const url of rejected) {
    assert.equal(debuggerGate.matchesWorkerURL(url), false, url);
    assert.equal(debuggerGate.isWorker({type: 'service_worker', url}), false, url);
  }
  assert.equal(debuggerGate.isWorker({
    type: 'page',
    url: accepted[0]
  }), false, 'an exact URL is insufficient without the service_worker target type');
});

test('a blank service-worker attachment stays paused until its exact worker version is identified', async () => {
  const raw = new FakeRawCdp({locations: 'exact'});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const targetId = 'blank-worker-target';
  const sessionId = 'blank-worker-session';
  const targetInfo = {targetId, type: 'service_worker', url: ''};

  raw.emit('Target.attachedToTarget', {sessionId, targetInfo});
  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), true);
  assert.equal(raw.sent.some(entry => entry.method === 'Debugger.enable'), false);
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger'), false,
    'the unidentified worker remains held at startup');

  raw.emit('ServiceWorker.workerRegistrationUpdated', {registrations: [{
    isDeleted: false,
    registrationId: 'registration-1',
    scopeURL: `chrome-extension://${extensionId}/`
  }]});
  raw.emit('ServiceWorker.workerVersionUpdated', {versions: [{
    registrationId: 'registration-1',
    scriptURL: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/worker/core.mjs',
    targetId,
    versionId: 'wrong-version'
  }]}, 'control-session');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), true,
    'a version for a different extension cannot release the blank worker');
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger'), false);

  raw.emit('ServiceWorker.workerVersionUpdated', {versions: [{
    registrationId: 'registration-1',
    runningStatus: 'running',
    scriptURL: `chrome-extension://${extensionId}/worker/core.mjs?startup=1#version`,
    status: 'activated',
    targetId,
    versionId: 'exact-version'
  }]}, 'control-session');
  await debuggerGate.awaitReady(100);

  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), false);
  assert.equal(debuggerGate.workerVersions.get(targetId)?.versionId, 'exact-version');
  assert.equal(debuggerGate.sessions.get(sessionId)?.workerURL,
    `chrome-extension://${extensionId}/worker/core.mjs?startup=1#version`,
  'version identity is retained on the debugger session even when attachment URL was blank');
  assert.equal(raw.sent.some(entry => entry.method === 'Debugger.enable' &&
    entry.sessionId === sessionId), true);
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger' &&
    entry.sessionId === sessionId), true,
  'the exact version mapping configures every breakpoint before releasing the held worker');
});

test('targetInfoChanged consumes a blank worker only after its exact URL appears', async () => {
  const raw = new FakeRawCdp({locations: 'exact'});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  const targetId = 'target-info-worker';
  const sessionId = 'target-info-session';

  raw.emit('Target.attachedToTarget', {
    sessionId,
    targetInfo: {targetId, type: 'service_worker', url: ''}
  });
  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), true);
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger'), false);

  raw.emit('Target.targetInfoChanged', {targetInfo: {
    targetId,
    type: 'service_worker',
    url: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/worker/core.mjs'
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), true,
    'a URL for another extension cannot consume the held attachment');
  assert.equal(raw.sent.some(entry => entry.method === 'Debugger.enable'), false);
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger'), false);

  raw.emit('Target.targetInfoChanged', {targetInfo: {
    targetId,
    type: 'service_worker',
    url: `edge-extension://${extensionId}/worker/core.mjs?startup=1#exact`
  }});
  await debuggerGate.awaitReady(100);

  assert.equal(debuggerGate.pendingWorkerAttachments.has(targetId), false);
  assert.equal(raw.sent.some(entry => entry.method === 'Debugger.enable' &&
    entry.sessionId === sessionId), true);
  assert.equal(raw.sent.some(entry => entry.method === 'Runtime.runIfWaitingForDebugger' &&
    entry.sessionId === sessionId), true,
  'the exact URL configures all breakpoints before resuming the original held session');
});

test('configuration inherits exact worker URL from a version mapped before blank discovery', async () => {
  const raw = new FakeRawCdp({locations: 'exact'});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  raw.emit('ServiceWorker.workerRegistrationUpdated', {registrations: [{
    isDeleted: false,
    registrationId: 'registration-before-discovery',
    scopeURL: `chrome-extension://${extensionId}/`
  }]});
  raw.emit('ServiceWorker.workerVersionUpdated', {versions: [{
    registrationId: 'registration-before-discovery',
    runningStatus: 'running',
    scriptURL: workerInfo.url,
    status: 'activated',
    targetId: workerInfo.targetId,
    versionId: 'version-before-discovery'
  }]}, 'control-session');

  await debuggerGate.configure('blank-discovery-session', {
    targetId: workerInfo.targetId,
    type: 'service_worker',
    url: ''
  }, false);
  assert.equal(debuggerGate.sessions.get('blank-discovery-session')?.workerURL, workerInfo.url);
});

test('a targetless version can stop one exact paused session after its target disappears', async () => {
  const raw = new FakeRawCdp({
    locations: 'exact',
    targetInfoError: true,
    targetInfos: [workerInfo]
  });
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  raw.emit('ServiceWorker.workerVersionUpdated', {versions: [{
    registrationId: 'registration-targetless',
    runningStatus: 'running',
    scriptURL: workerInfo.url,
    status: 'activated',
    versionId: 'version-targetless'
  }]}, 'control-session');
  raw.emit('ServiceWorker.workerRegistrationUpdated', {registrations: [{
    isDeleted: false,
    registrationId: 'registration-targetless',
    scopeURL: `chrome-extension://${extensionId}/`
  }]});
  await configure(debuggerGate, 'targetless-session');
  debuggerGate.hold(['after-replacement-settlement']);
  const settlementBreakpoint = debuggerGate.sessions.get('targetless-session')
    .breakpoints.get('after-replacement-settlement');
  const paused = debuggerGate.waitForPause('after-replacement-settlement');
  raw.emit('Debugger.paused', {
    hitBreakpoints: [settlementBreakpoint],
    reason: 'other'
  }, 'targetless-session');
  const pause = await paused;
  raw.emit('Target.detachedFromTarget', {sessionId: 'targetless-session'});

  await debuggerGate.terminate(pause, 'control-session');

  assert.deepEqual(raw.sent.find(entry => entry.method === 'ServiceWorker.stopWorker')?.params,
    {versionId: 'version-targetless'});
});

test('two targetless active versions fail closed without stopping either worker', async () => {
  const raw = new FakeRawCdp({locations: 'exact', targetInfos: [workerInfo]});
  const debuggerGate = new WorkerDebugger(raw, extensionId, extension);
  raw.emit('ServiceWorker.workerRegistrationUpdated', {registrations: [{
    isDeleted: false,
    registrationId: 'registration-ambiguous',
    scopeURL: `chrome-extension://${extensionId}/`
  }]});
  raw.emit('ServiceWorker.workerVersionUpdated', {versions: ['one', 'two'].map(versionId => ({
    registrationId: 'registration-ambiguous',
    runningStatus: 'running',
    scriptURL: workerInfo.url,
    status: 'activated',
    versionId
  }))}, 'control-session');
  await configure(debuggerGate, 'ambiguous-session');

  await assert.rejects(debuggerGate.terminate({
    sessionId: 'ambiguous-session',
    stage: 'after-replacement-settlement',
    targetId: workerInfo.targetId
  }, 'control-session'), /had 2 eligible service-worker versions/);
  assert.equal(raw.sent.some(entry => entry.method === 'ServiceWorker.stopWorker'), false);
});
