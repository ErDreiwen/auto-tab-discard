import assert from 'node:assert/strict';
import test from 'node:test';

import {
  correlationToken,
  createDiagnosticClient,
  projectEvent,
  responseCounts
} from '../v3/data/common/diagnostic-client.mjs';

test('projects only fixed diagnostic UI fields and bounded aggregate counts', () => {
  assert.deepEqual(projectEvent({
    action: 'COMMAND_CONTROL',
    code: 'CONTROL_ACTIVATED',
    counts: {failed: 47, leaked: 99, skipped: 19, total: 66},
    error: 'secret browser error',
    hostname: 'private.example',
    outcome: 'STARTED',
    phase: 'CLICK',
    tabId: 42,
    title: 'Secret title',
    type: 'UI_ACTION',
    url: 'https://private.example/path'
  }), {
    action: 'COMMAND_CONTROL',
    code: 'CONTROL_ACTIVATED',
    counts: {failed: 47, skipped: 19, total: 66},
    outcome: 'STARTED',
    phase: 'CLICK',
    type: 'UI_ACTION'
  });
  assert.equal(projectEvent({type: 'RAW_BROWSER_EVENT'}), undefined);
  assert.equal(projectEvent({type: 'UI_ACTION', action: 'PRIVATE_CONTROL_NAME'}), undefined);
});

test('creates opaque bounded correlations without browser or tab identifiers', () => {
  const token = correlationToken({
    getRandomValues(bytes) {
      bytes.forEach((value, index) => bytes[index] = index + 1);
      return bytes;
    }
  });
  assert.equal(token, 'ATDC-0102030405060708090A');
  assert.match(token, /^ATDC-[A-Z0-9]{16,40}$/);
});

test('emits click, request, and aggregate response without blocking the action', async () => {
  const requests = [];
  const runtime = {
    sendMessage(request, callback) {
      requests.push(structuredClone(request));
      callback({ok: true, value: {accepted: true}});
    }
  };
  const client = createDiagnosticClient({
    authorization: () => ({tabId: 7, windowId: 9, url: 'not forwarded'}),
    cryptoObject: {
      getRandomValues(bytes) {
        bytes.fill(10);
        return bytes;
      }
    },
    runtime
  });
  const span = client.start({command: 'discard-window'});
  span.click();
  span.request();
  span.succeeded({counts: {failed: 0, skipped: 19, success: 47, total: 66}});
  await new Promise(resolve => setTimeout(resolve));

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.event.type), [
    'UI_ACTION', 'REQUEST', 'RESPONSE'
  ]);
  assert.ok(requests.every(request => request.correlation === 'ATDC-0A0A0A0A0A0A0A0A0A0A'));
  assert.ok(requests.every(request => request.tabId === 7 && request.windowId === 9));
  assert.ok(requests.every(request => JSON.stringify(request).includes('not forwarded') === false));
  assert.deepEqual(requests[2].event.counts, {
    failed: 0,
    skipped: 19,
    success: 47,
    total: 66
  });
});

test('extracts only settled aggregate response counts', () => {
  assert.deepEqual(responseCounts({
    value: {
      completed: 66,
      summary: {failed: 47, skipped: 19, success: 0},
      total: 66
    }
  }), {
    attempted: 66,
    failed: 47,
    skipped: 19,
    success: 0,
    total: 66
  });
  assert.equal(responseCounts({value: {summary: {hostname: 'private.example'}}}), undefined);
});

test('records an authoritative no-op as skipped instead of successful', async () => {
  const requests = [];
  const client = createDiagnosticClient({
    runtime: {
      sendMessage(request, callback) {
        requests.push(structuredClone(request));
        callback({ok: true, value: {accepted: true}});
      }
    }
  });
  client.start({command: 'move-next'}).skipped();
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(requests.at(-1).event, {
    code: 'NO_CHANGE',
    command: 'move-next',
    outcome: 'SKIPPED',
    phase: 'RESPONSE',
    type: 'RESPONSE'
  });
});

test('reports a transient dropped-event count on the next accepted record', async () => {
  const requests = [];
  let calls = 0;
  const client = createDiagnosticClient({
    runtime: {
      sendMessage(request, callback) {
        requests.push(structuredClone(request));
        calls += 1;
        callback(calls === 1 ? {ok: false} : {ok: true, value: {accepted: true}});
      }
    }
  });
  assert.equal(await client.emit({
    code: 'CONTROL_ACTIVATED',
    outcome: 'STARTED',
    phase: 'CLICK',
    type: 'UI_ACTION'
  }), false);
  assert.equal(await client.emit({
    code: 'REQUEST_SENT',
    outcome: 'STARTED',
    phase: 'SEND',
    type: 'REQUEST'
  }), true);
  assert.deepEqual(requests[1].event.counts, {dropped: 1});
});

test('out-of-order responses cannot erase a concurrent dropped event', async () => {
  const requests = [];
  const callbacks = [];
  const client = createDiagnosticClient({
    runtime: {
      sendMessage(request, callback) {
        requests.push(structuredClone(request));
        callbacks.push(callback);
      }
    }
  });
  const first = client.emit({
    code: 'CONTROL_ACTIVATED', outcome: 'STARTED', phase: 'CLICK', type: 'UI_ACTION'
  });
  const second = client.emit({
    code: 'REQUEST_SENT', outcome: 'STARTED', phase: 'SEND', type: 'REQUEST'
  });
  callbacks[0]({ok: false});
  callbacks[1]({ok: true, value: {accepted: true}});
  assert.deepEqual(await Promise.all([first, second]), [false, true]);

  const third = client.emit({
    code: 'REQUEST_FAILED', outcome: 'FAILED', phase: 'RESPONSE', type: 'RESPONSE'
  });
  callbacks[2]({ok: true, value: {accepted: true}});
  assert.equal(await third, true);
  assert.deepEqual(requests[2].event.counts, {dropped: 1});
});
