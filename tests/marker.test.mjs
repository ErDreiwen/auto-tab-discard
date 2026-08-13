import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkerAttempt,
  prepareDocumentMarker,
  restoreDocumentMarker,
  visualPreparation
} from '../v3/worker/core/marker.mjs';
import {prepareDiscardTargets} from '../v3/worker/core/command-scope.mjs';

test('marker attempts remain strictly ordered when two passes share one millisecond', () => {
  const options = {
    now: () => 1_700_000_000_000,
    preciseNow: () => 1_700_000_000_000,
    random: () => 0.5
  };
  const stopPass = createMarkerAttempt(1000, options);
  const visualPass = createMarkerAttempt(1000, options);

  assert.equal(stopPass.issuedAt, visualPass.issuedAt);
  assert.equal(stopPass.deadline, visualPass.deadline);
  assert.equal(visualPass.generation > stopPass.generation, true);
});

const installMarkerDom = ({favicon = false, imageMode = 'immediate', title = 'Page'} = {}) => {
  const names = [
    'Image',
    '__autoTabDiscardMarkerAttempt',
    '__autoTabDiscardMarkerGeneration',
    '__autoTabDiscardRevokedMarkerAttempts',
    '__autoTabDiscardVisualState',
    'chrome',
    'document',
    'location',
    'window'
  ];
  const missing = Symbol('missing');
  const previous = new Map(names.map(name => [
    name,
    Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : missing
  ]));

  const createNode = tag => {
    const node = {
      children: [],
      dataset: {},
      href: '',
      isConnected: false,
      parentNode: null,
      rel: '',
      tagName: String(tag).toUpperCase(),
      textContent: '',
      type: '',
      appendChild(child) {
        child.remove?.();
        this.children.push(child);
        child.parentNode = this;
        child.isConnected = this.isConnected;
        return child;
      },
      insertBefore(child, next) {
        child.remove?.();
        const index = next ? this.children.indexOf(next) : -1;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
        child.isConnected = this.isConnected;
        return child;
      },
      querySelector(selector) {
        if (selector === 'title') {
          return this.children.find(child => child.tagName === 'TITLE') || null;
        }
        return null;
      },
      remove() {
        if (!this.parentNode) {
          return;
        }
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) {
          this.parentNode.children.splice(index, 1);
        }
        this.parentNode = null;
        this.isConnected = false;
      }
    };
    Object.defineProperty(node, 'nextSibling', {
      get() {
        if (!this.parentNode) {
          return null;
        }
        const index = this.parentNode.children.indexOf(this);
        return this.parentNode.children[index + 1] || null;
      }
    });
    return node;
  };

  const root = createNode('html');
  root.isConnected = true;
  const head = createNode('head');
  root.appendChild(head);
  const titleNode = createNode('title');
  titleNode.textContent = title;
  head.appendChild(titleNode);
  const originalIcon = favicon ? createNode('link') : undefined;
  if (originalIcon) {
    originalIcon.rel = 'icon';
    originalIcon.href = 'https://example.test/original.png';
    head.appendChild(originalIcon);
  }

  const document = {
    documentElement: root,
    head,
    title,
    appendChild: child => child,
    createElement(tag) {
      const node = createNode(tag);
      if (tag === 'canvas') {
        node.getContext = () => ({
          arc() {},
          beginPath() {},
          drawImage() {},
          fill() {},
          fillStyle: '',
          globalAlpha: 1
        });
        node.toDataURL = () => 'data:image/png;base64,bWFya2Vy';
      }
      return node;
    },
    querySelectorAll(selector) {
      if (selector === 'link[rel*="icon"]') {
        return head.children.filter(node => node.tagName === 'LINK' && node.rel.includes('icon'));
      }
      return [];
    }
  };
  const images = [];
  class FakeImage {
    constructor() {
      this.height = 32;
      this.naturalHeight = 32;
      this.naturalWidth = 32;
      this.width = 32;
      images.push(this);
    }
    set src(value) {
      this.currentSrc = value;
      if (imageMode === 'immediate') {
        queueMicrotask(() => this.onload?.());
      }
    }
  }
  const window = {stop() { window.stops += 1; }, stops: 0};
  window.top = window;

  globalThis.document = document;
  globalThis.Image = FakeImage;
  globalThis.location = {href: 'https://example.test/'};
  globalThis.window = window;
  globalThis.chrome = {runtime: {getURL: path => `extension://${path}`}};
  delete globalThis.__autoTabDiscardMarkerAttempt;
  delete globalThis.__autoTabDiscardMarkerGeneration;
  delete globalThis.__autoTabDiscardRevokedMarkerAttempts;
  delete globalThis.__autoTabDiscardVisualState;

  return {
    cleanup() {
      for (const [name, value] of previous) {
        if (value === missing) {
          delete globalThis[name];
        }
        else {
          globalThis[name] = value;
        }
      }
    },
    document,
    head,
    images,
    originalIcon,
    titleNode,
    window
  };
};

test('computes title and favicon preparation completeness independently', () => {
  assert.deepEqual(visualPreparation({favicon: false, prepends: ''}), {
    complete: true,
    favicon: true,
    title: true
  });
  assert.deepEqual(visualPreparation({favicon: true, prepends: 'sleep'}, {
    faviconApplied: true,
    titleApplied: false
  }), {
    complete: false,
    favicon: true,
    title: false
  });
  assert.deepEqual(visualPreparation({favicon: true, prepends: 'sleep'}, {
    faviconApplied: false,
    faviconError: 'CORS',
    stale: true,
    titleApplied: true
  }), {
    complete: false,
    favicon: false,
    faviconError: 'CORS',
    stale: true,
    title: true
  });
});

test('page marker function is self-contained and checks its generation deadline before DOM writes', () => {
  const source = prepareDocumentMarker.toString();
  assert.match(source, /__autoTabDiscardMarkerAttempt/);
  assert.match(source, /__autoTabDiscardMarkerGeneration/);
  assert.match(source, /Date\.now\(\) <= deadline/);
  assert.match(source, /if \(!ownsAttempt\(\)\)/);
  assert.doesNotMatch(source, /markerAttempt|visualPreparation/);
});

test('an expired page marker attempt cannot stop or mutate the document', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let stops = 0;
  globalThis.window = {
    stop() {
      stops += 1;
    }
  };
  globalThis.window.top = globalThis.window;
  globalThis.document = {
    title: 'unchanged'
  };

  try {
    const result = await prepareDocumentMarker({
      favicon: false,
      prepends: 'sleep'
    }, '', {
      deadline: Date.now() - 1,
      token: 'expired'
    });
    assert.equal(result.stale, true);
    assert.equal(stops, 0);
    assert.equal(document.title, 'unchanged');
    assert.equal(globalThis.__autoTabDiscardMarkerAttempt, undefined);
  }
  finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    }
    else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    }
    else {
      globalThis.document = previousDocument;
    }
  }
});

test('rollback before a delayed preparation starts revokes its exact token', async () => {
  const env = installMarkerDom({favicon: true});
  try {
    const attempt = {
      deadline: Date.now() + 10_000,
      generation: 7,
      token: 'cancel-before-start'
    };
    const rollback = restoreDocumentMarker(attempt);
    assert.equal(rollback.tokenRevoked, true);
    assert.equal(rollback.restored, false, 'there is no marker to restore yet');

    const delayed = await prepareDocumentMarker({
      favicon: true,
      faviconDelay: 0,
      prepends: 'ðŸ’¤'
    }, 'https://example.test/original.png', attempt);
    assert.equal(delayed.stale, true);
    assert.equal(env.window.stops, 0, 'revoked delayed work must not call window.stop');
    assert.equal(env.document.title, 'Page');
    assert.deepEqual(env.document.querySelectorAll('link[rel*="icon"]'), [env.originalIcon]);
    assert.equal(globalThis.__autoTabDiscardVisualState, undefined);

    const later = await prepareDocumentMarker({
      favicon: false,
      prepends: 'REST'
    }, '', {
      deadline: Date.now() + 10_000,
      generation: 8,
      token: 'later-attempt'
    });
    assert.equal(later.complete, true, 'revocation is exact-token, not a tab-wide ban');
    assert.equal(env.document.title, 'REST Page');
  }
  finally {
    env.cleanup();
  }
});

test('a preparation issued for an older document cannot stop or mark a newly committed navigation', async () => {
  const env = installMarkerDom({title: 'New document'});
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const issuedAt = Date.now() - 100;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: {timeOrigin: issuedAt + 50},
    writable: true
  });
  try {
    const result = await prepareDocumentMarker({
      favicon: false,
      prepends: '💤'
    }, '', {
      deadline: Date.now() + 10_000,
      generation: 1,
      issuedAt,
      token: 'old-document'
    });
    assert.equal(result.stale, true);
    assert.equal(env.window.stops, 0);
    assert.equal(env.document.title, 'New document');
    assert.equal(globalThis.__autoTabDiscardMarkerAttempt, undefined);
    assert.equal(globalThis.__autoTabDiscardVisualState, undefined);
  }
  finally {
    env.cleanup();
    if (performanceDescriptor) {
      Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    }
    else {
      delete globalThis.performance;
    }
  }
});

test('a completed newer generation permanently fences a delayed older preparation in that document', async () => {
  const env = installMarkerDom();
  try {
    const deadline = Date.now() + 10_000;
    const newer = await prepareDocumentMarker({
      favicon: false,
      prepends: '💤'
    }, '', {deadline, generation: 2, token: 'newer'});
    assert.equal(newer.complete, true);
    assert.equal(env.document.title, '💤 Page');
    assert.equal(env.window.stops, 1);
    assert.equal(globalThis.__autoTabDiscardMarkerAttempt, undefined);

    const delayed = await prepareDocumentMarker({
      favicon: false,
      prepends: 'old'
    }, '', {deadline, generation: 1, token: 'older'});
    assert.equal(delayed.stale, true);
    assert.equal(env.window.stops, 1, 'the delayed invocation must not call window.stop');
    assert.equal(env.document.title, '💤 Page');
    assert.equal(globalThis.__autoTabDiscardVisualState.token, 'newer');

    const latest = await prepareDocumentMarker({
      favicon: false,
      prepends: 'REST'
    }, '', {deadline, generation: 3, token: 'latest'});
    assert.equal(latest.complete, true);
    assert.equal(env.document.title, 'REST Page', 'a changed preference must replace, not stack, our prefix');

    const restored = restoreDocumentMarker({token: 'latest'});
    assert.equal(restored.titleRestored, true);
    assert.equal(env.document.title, 'Page');
  }
  finally {
    env.cleanup();
  }
});

test('a newer generation cancels the older favicon listener and the loser cannot mutate later', async () => {
  const env = installMarkerDom({favicon: true, imageMode: 'manual'});
  try {
    const issuedAt = Date.now();
    const olderPromise = prepareDocumentMarker({
      favicon: true,
      faviconDelay: 0,
      prepends: '💤'
    }, 'https://example.test/slow.png', {
      deadline: issuedAt + 10_000,
      issuedAt,
      token: 'older'
    });
    await Promise.resolve();
    const olderImage = env.images[0];
    assert.equal(typeof olderImage.onload, 'function');

    const newer = await prepareDocumentMarker({
      favicon: false,
      prepends: '💤'
    }, '', {
      // A later attempt with a shorter timeout is still the newer generation.
      deadline: issuedAt + 1_000,
      issuedAt: issuedAt + 1,
      token: 'newer'
    });
    assert.equal(newer.complete, true);
    assert.equal(olderImage.onload, null);
    assert.equal(olderImage.onerror, null);

    // Even a late network completion has no listener and therefore no DOM
    // authority. The original favicon is still the only icon.
    olderImage.onload?.();
    const older = await olderPromise;
    assert.equal(older.stale, true);
    assert.deepEqual(env.document.querySelectorAll('link[rel*="icon"]'), [env.originalIcon]);
    assert.equal(env.document.title, '💤 Page');
    assert.equal(env.window.stops, 2);
  }
  finally {
    env.cleanup();
  }
});

test('rollback restores the exact original title and favicon when extension writes are unchanged', async () => {
  const env = installMarkerDom({favicon: true, title: 'Cafe\u0301'});
  try {
    const attempt = {deadline: Date.now() + 10_000, generation: 1, token: 'restore-me'};
    const prepared = await prepareDocumentMarker({
      favicon: true,
      faviconDelay: 0,
      prepends: '💤'
    }, 'https://example.test/original.png', attempt);
    assert.equal(prepared.complete, true);
    assert.equal(prepared.originalTitle, 'Cafe\u0301');
    assert.equal(env.document.title, '💤 Café');
    assert.equal(env.originalIcon.isConnected, false);
    assert.equal(env.document.querySelectorAll('link[rel*="icon"]').length, 1);

    const restored = restoreDocumentMarker(attempt);
    assert.equal(restored.restored, true);
    assert.equal(restored.titleRestored, true);
    assert.equal(restored.faviconRestored, true);
    assert.equal(env.document.title, 'Cafe\u0301');
    assert.equal(env.originalIcon.isConnected, true);
    assert.deepEqual(env.document.querySelectorAll('link[rel*="icon"]'), [env.originalIcon]);
    assert.equal(globalThis.__autoTabDiscardVisualState, undefined);
  }
  finally {
    env.cleanup();
  }
});

test('rollback preserves concurrent page title and favicon updates instead of clobbering them', async () => {
  const env = installMarkerDom({favicon: true});
  try {
    const attempt = {deadline: Date.now() + 10_000, generation: 1, token: 'page-wins'};
    await prepareDocumentMarker({
      favicon: true,
      faviconDelay: 0,
      prepends: '💤'
    }, 'https://example.test/original.png', attempt);

    env.document.title = 'Live page update';
    env.titleNode.textContent = 'Live page update';
    const liveIcon = env.document.createElement('link');
    liveIcon.rel = 'icon';
    liveIcon.href = 'https://example.test/live.png';
    env.head.appendChild(liveIcon);

    const restored = restoreDocumentMarker(attempt);
    assert.equal(restored.titleRestored, false);
    assert.equal(restored.titlePreserved, true);
    assert.equal(restored.faviconRestored, false);
    assert.equal(restored.faviconPreserved, true);
    assert.equal(env.document.title, 'Live page update');
    assert.equal(liveIcon.isConnected, true);
    assert.equal(env.originalIcon.isConnected, false);
    assert.deepEqual(env.document.querySelectorAll('link[rel*="icon"]'), [liveIcon]);
  }
  finally {
    env.cleanup();
  }
});

test('normalized-empty marker input is a bounded no-op with no duplicate-prefix loop', async () => {
  const env = installMarkerDom({title: 'Page'});
  try {
    const prepared = await prepareDocumentMarker({
      favicon: false,
      prepends: '\u202e \u202c'
    }, '', {deadline: Date.now() + 10_000, generation: 1, token: 'empty'});
    assert.equal(prepared.complete, true);
    assert.equal(prepared.titleApplied, true);
    assert.equal(env.document.title, 'Page');
    assert.equal(globalThis.__autoTabDiscardVisualState, undefined);
  }
  finally {
    env.cleanup();
  }
});

test('an explicitly incomplete self-owned discard is scheduled for one marker repair takeover', async () => {
  const tab = {
    id: 7,
    active: false,
    discarded: true,
    url: 'https://marker-repair.example/'
  };
  const incomplete = await prepareDiscardTargets('discard-tabs', [tab], async current => ({
    marker: {
      state: 'owned',
      source: 'self',
      visual: {complete: false, favicon: false, repair: true, title: true}
    },
    state: 'discarded',
    tab: current
  }));
  assert.deepEqual(incomplete.alreadyOwned, []);
  assert.deepEqual(incomplete.markerRepairs.map(entry => entry.id), [7]);
  assert.deepEqual(incomplete.takeovers.map(entry => entry.id), [7]);

  const legacy = await prepareDiscardTargets('discard-tabs', [tab], async current => ({
    marker: {state: 'owned', source: 'self'},
    state: 'discarded',
    tab: current
  }));
  assert.deepEqual(legacy.alreadyOwned.map(entry => entry.id), [7]);
  assert.deepEqual(legacy.markerRepairs, []);
  assert.deepEqual(legacy.takeovers, []);
});

test('a later live title loss repairs one physically self-owned discard', async () => {
  const resolve = title => async current => ({
    marker: {
      state: 'owned',
      source: 'self',
      visual: {
        complete: true,
        favicon: true,
        repair: true,
        title: true,
        titleMarker: '💤'
      }
    },
    state: 'discarded',
    tab: {...current, title}
  });
  const tab = {
    id: 8,
    active: false,
    discarded: true,
    title: '💤 Original',
    url: 'https://marker-loss.example/'
  };

  const intact = await prepareDiscardTargets('discard-tabs', [tab], resolve('💤 Original'));
  assert.deepEqual(intact.alreadyOwned.map(entry => entry.id), [8]);
  assert.deepEqual(intact.markerRepairs, []);

  const lost = await prepareDiscardTargets('discard-tabs', [tab], resolve('Site replaced title'));
  assert.deepEqual(lost.alreadyOwned, []);
  assert.deepEqual(lost.markerRepairs.map(entry => entry.id), [8]);
  assert.deepEqual(lost.takeovers.map(entry => entry.id), [8]);
});
