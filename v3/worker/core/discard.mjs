import {prefs, storage} from './prefs.mjs';
import {log, query} from './utils.mjs';
import {withTimeout} from './promise.mjs';
import {ownership} from './ownership.mjs';

// this list keeps ids of the tabs that are in progress of being discarded
const inprogress = new Set();

const discard = tab => {
  if (inprogress.has(tab.id)) {
    return Promise.resolve(false);
  }
  if (tab.active) {
    log('tab is active', tab);
    return Promise.resolve(false);
  }
  if (tab.discarded) {
    log('already discarded', tab);
    return Promise.resolve(false);
  }

  // https://github.com/rNeomy/auto-tab-discard/issues/248
  inprogress.add(tab.id);

  return storage(prefs).then(prefs => new Promise(resolve => {
    const limit = Math.max(1, Number(prefs['simultaneous-jobs']) || 1);
    if (discard.count >= limit) {
      log('discarding queue for', tab);
      discard.tabs.push({tab, resolve});
      return;
    }

    discard.count += 1;
    let started = false;
    let prepareTimer;
    const next = () => {
      if (started) {
        return;
      }
      started = true;
      clearTimeout(prepareTimer);
      discard.perform(tab).then(resolve).finally(() => {
        discard.count -= 1;
        inprogress.delete(tab.id);
        if (discard.tabs.length) {
          const queued = discard.tabs.shift();
          inprogress.delete(queued.tab.id);
          discard(queued.tab).then(queued.resolve);
        }
      });
    };
    // Favicon preparation relies on page messaging and must never hold the queue forever.
    prepareTimer = setTimeout(next, discard.prepareTimeout);
      // change title or favicon
      if (prefs.prepends || prefs.favicon) {
        const href = tab.favIconUrl || '';
        Promise.race([
          new Promise(resolve => setTimeout(resolve, 1000, [])),
          chrome.scripting.executeScript({
            target: {
              tabId: tab.id,
              allFrames: true
            },
            func: (prefs, src) => {
              window.stop();
              if (window === window.top) {
                if (prefs.prepends) {
                  const title = document.title || location.href || '';
                  if (title.startsWith(prefs.prepends) === false) {
                    document.title = prefs.prepends + ' ' + title;
                  }

                  if (prefs.favicon === false) {
                    return true;
                  }
                }
                if (prefs.favicon) {
                  const observe = (request, sender, response) => {
                    if (request.method === 'fix-favicon') {
                      chrome.runtime.onMessage.removeListener(observe);

                      [...document.querySelectorAll('link[rel*="icon"]')].forEach(link => link.remove());

                      const draw = img => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');

                        if (ctx) {
                          canvas.width = img.width;
                          canvas.height = img.height;
                          ctx.globalAlpha = 0.6;
                          ctx.drawImage(img, 0, 0);

                          ctx.globalAlpha = 1;
                          ctx.beginPath();
                          ctx.fillStyle = '#a1a0a1';
                          ctx.arc(img.width * 0.75, img.height * 0.75, img.width * 0.25, 0, 2 * Math.PI, false);
                          ctx.fill();
                          const href = canvas.toDataURL();
                          document.querySelector('head').appendChild(Object.assign(document.createElement('link'), {
                            rel: 'icon',
                            type: 'image/png',
                            href
                          }));
                          response('done');
                        }
                        else {
                          response('NO_CTX');
                        }
                      };
                      Object.assign(new Image(), {
                        crossOrigin: 'anonymous',
                        src,
                        onerror() { // fallback image
                          Object.assign(new Image(), {
                            src: chrome.runtime.getURL('/data/page.png'),
                            onerror(e) {
                              response(e.message || 'CORS');
                            },
                            onload() {
                              draw(this);
                            }
                          });
                        },
                        onload() {
                          draw(this);
                        }
                      });
                      return true;
                    }
                  };
                  chrome.runtime.onMessage.addListener(observe);
                  return 'async';
                }
              }
              return false;
            },
            args: [prefs, href]
          })
        ]).then(r => {
          if (r.some(o => o.result === 'async')) {
            chrome.tabs.sendMessage(tab.id, {
              method: 'fix-favicon'
            }, reason => {
              chrome.runtime.lastError;
              setTimeout(next, prefs['favicon-delay'], reason);
            });
          }
          else {
            next('one');
          }
        }).catch(e =>next(e.message));
      }
      else {
        next('two');
      }
  }));
};
discard.tabs = [];
discard.count = 0;
discard.prepareTimeout = 5000;
const getTab = id => new Promise(resolve => chrome.tabs.get(id, current => {
  const error = chrome.runtime.lastError;
  resolve(error ? undefined : current);
}));
const nativeDiscard = tab => new Promise(resolve => {
  try {
    chrome.tabs.discard(tab.id, result => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({error: error.message || String(error)});
      }
      else if (result && result.discarded === true) {
        resolve({result, source: 'self', success: true});
      }
      else {
        resolve({ambiguous: result === undefined});
      }
    });
  }
  catch (e) {
    resolve({error: e.message || String(e)});
  }
});

const reloadTab = id => new Promise(resolve => {
  try {
    chrome.tabs.reload(id, {bypassCache: false}, () => {
      const error = chrome.runtime.lastError;
      resolve(error ? {error: error.message || String(error)} : {success: true});
    });
  }
  catch (e) {
    resolve({error: e.message || String(e)});
  }
});

const waitForAwake = async (id, token) => {
  const deadline = Date.now() + discard.takeoverTimeout;
  while (Date.now() < deadline && token.cancelled === false) {
    const current = await withTimeout(getTab(id), discard.getTimeout, undefined);
    if (!current) {
      return undefined;
    }
    if (current.discarded === false) {
      return current;
    }
    await new Promise(resolve => setTimeout(resolve, discard.takeoverPoll));
  }
};

const waitForOwnership = async (id, token) => {
  const deadline = Date.now() + discard.takeoverTimeout;
  while (Date.now() < deadline && token.cancelled === false) {
    const state = await ownership.status(id);
    if (!state.attemptId) {
      return state.marker?.state === 'owned' && state.marker.source === 'self';
    }
    await new Promise(resolve => setTimeout(resolve, discard.takeoverPoll));
  }
  throw Error(`timed out waiting for existing discard attempt on tab ${id}`);
};

const takeoverOnce = async (tab, token) => {
  const id = tab.id;
  const current = await withTimeout(getTab(id), discard.getTimeout, undefined);
  const initialState = await ownership.status(id);
  const recovering = current?.discarded === false && initialState.marker?.state === 'takeover-recovery';
  if (!current || current.active === true || (current.discarded !== true && recovering === false)) {
    throw Error(`tab ${id} is no longer an inactive takeover target`);
  }

  const attemptId = await ownership.beginTakeover(current);
  if (!attemptId) {
    if (await waitForOwnership(id, token)) {
      return true;
    }
    throw Error(`cannot start discard takeover for tab ${id}`);
  }

  let finished = false;
  try {
    let awake = current;
    if (current.discarded === true) {
      const reloadTimeout = {};
      const reload = await withTimeout(reloadTab(id), discard.takeoverTimeout, reloadTimeout);
      if (reload === reloadTimeout || reload.error) {
        throw Error(reload.error || `timed out waking tab ${id}`);
      }
      awake = await waitForAwake(id, token);
    }
    if (token.cancelled) {
      throw Error(`discard takeover cancelled for tab ${id}`);
    }
    if (!awake || awake.discarded !== false || awake.active === true) {
      throw Error(`tab ${id} did not wake as an inactive tab`);
    }
    if (!ownership.isCurrent(id, attemptId)) {
      throw Error(`discard takeover became stale for tab ${id}`);
    }

    const nativeTimeout = {};
    const nativeOperation = nativeDiscard(awake);
    let outcome = await withTimeout(nativeOperation, discard.nativeTimeout, nativeTimeout);
    if (outcome === nativeTimeout) {
      const fenceTimeout = {};
      outcome = await withTimeout(nativeOperation, discard.takeoverFenceTimeout, fenceTimeout);
      if (outcome === fenceTimeout) {
        outcome = nativeTimeout;
      }
    }
    const strong = outcome !== nativeTimeout && outcome.success === true && outcome.source === 'self' &&
      outcome.result?.discarded === true;
    const finalTab = outcome?.result || await withTimeout(getTab(id), discard.getTimeout, undefined) || awake;
    const owned = await ownership.finish(finalTab, attemptId, strong ? 'self' : undefined, {
      allowClaimed: false
    });
    finished = true;

    if (strong && owned) {
      return true;
    }
    const reason = outcome === nativeTimeout ? 'native discard timed out' :
      outcome?.error || 'another discarder won before the native discard';
    throw Error(`discard takeover failed for tab ${id}: ${reason}`);
  }
  catch (e) {
    if (!finished && ownership.isCurrent(id, attemptId)) {
      const finalTab = await withTimeout(getTab(id), discard.getTimeout, undefined) || {
        ...current,
        discarded: false
      };
      await ownership.finish(finalTab, attemptId, undefined, {allowClaimed: false}).catch(() => {
        return ownership.invalidate(id);
      });
    }
    throw e;
  }
};

const takeoverJobs = new Map();
let takeoverTail = Promise.resolve();

discard.takeover = (tab, {manual = false} = {}) => {
  const id = tab && tab.id;
  if (!Number.isInteger(id)) {
    return Promise.reject(Error('invalid tab for discard takeover'));
  }
  const existing = takeoverJobs.get(id);
  if (existing) {
    return existing.promise;
  }

  const token = {cancelled: false};
  const job = {started: false, token};
  const execute = async () => {
    job.started = true;
    let lastError;
    for (let pass = 0; pass < discard.takeoverRetries && token.cancelled === false; pass += 1) {
      const state = await ownership.status(id);
      if (state.marker?.source === 'contended' && manual !== true) {
        throw Error(`automatic discard takeover stopped after contention on tab ${id}`);
      }
      if (!state.attemptId && state.marker?.state === 'owned' && state.marker.source === 'self') {
        return true;
      }
      if (state.attemptId) {
        try {
          if (await waitForOwnership(id, token)) {
            return true;
          }
        }
        catch (e) {
          lastError = e;
          continue;
        }
      }
      try {
        if (await takeoverOnce(tab, token)) {
          return true;
        }
      }
      catch (e) {
        lastError = e;
      }
    }
    if (!token.cancelled) {
      const current = await withTimeout(getTab(id), discard.getTimeout, undefined);
      if (current?.discarded === true) {
        await ownership.deferTakeover(id);
      }
    }
    throw lastError || Error(`discard takeover cancelled for tab ${id}`);
  };

  const running = takeoverTail.then(execute, execute);
  takeoverTail = running.then(() => undefined, () => undefined);
  job.promise = running.finally(() => {
    if (takeoverJobs.get(id) === job) {
      takeoverJobs.delete(id);
    }
  });
  takeoverJobs.set(id, job);
  return job.promise;
};

discard.cancelTakeover = async id => {
  const job = takeoverJobs.get(id);
  if (!job) {
    return false;
  }
  job.token.cancelled = true;
  await ownership.invalidate(id);
  // A queued job has not woken or touched the tab yet. Its cancellation token
  // makes it safe to release immediately instead of waiting behind unrelated
  // takeovers in the global serialization queue.
  if (job.started === false) {
    if (takeoverJobs.get(id) === job) {
      takeoverJobs.delete(id);
    }
    return true;
  }
  await job.promise.catch(() => false);
  return true;
};

// Only resume a takeover that this worker had already woken before MV3 stopped
// it. Do not sweep and reload every pre-existing external discard at startup.
discard.recoverTakeovers = async () => {
  const tabs = await query({
    url: '*://*/*',
    active: false
  });
  const targets = (await Promise.all(tabs.map(async tab => {
    const state = await ownership.status(tab.id);
    return tab.discarded === false && state.marker?.state === 'takeover-recovery' ? tab : undefined;
  }))).filter(Boolean);
  return Promise.all(targets.map(tab => discard.takeover(tab).catch(e => {
    log('discard takeover failed', e);
    return false;
  })));
};

chrome.tabs.onRemoved?.addListener(id => {
  const job = takeoverJobs.get(id);
  if (job) {
    job.token.cancelled = true;
  }
});
chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
  const job = takeoverJobs.get(removedId);
  if (job) {
    job.token.cancelled = true;
  }
});

discard.perform = async tab => {
  let attemptId;
  try {
    // The pending tag is persisted before Chromium receives the discard call.
    attemptId = await ownership.begin(tab);
  }
  catch (e) {
    log('discard ownership tagging failed', e);
    return false;
  }
  if (!attemptId) {
    return false;
  }

  const timeout = {};
  const outcome = await withTimeout(nativeDiscard(tab), discard.nativeTimeout, timeout);
  let current = outcome.result;
  let source = outcome.source;
  let success = outcome.success === true;

  if (!current) {
    current = await withTimeout(getTab(tab.id), discard.getTimeout, undefined);
    if (current && current.discarded === true) {
      // No strong native result means another discarder may have won the race.
      // Claim the final state without falsely labeling it as a self-discard.
      source = 'claimed';
      success = outcome.ambiguous === true;
    }
  }
  if (outcome.error) {
    log('discarding failed', outcome.error);
  }
  else if (outcome === timeout) {
    log('discarding failed', 'native discard timed out');
  }

  try {
    const owned = await ownership.finish(current || tab, attemptId, source);
    if (source && owned === false) {
      return false;
    }
  }
  catch (e) {
    log('discard ownership finalization failed', e);
    return false;
  }
  return success;
};
discard.nativeTimeout = 5000;
discard.getTimeout = 1000;
discard.takeoverTimeout = 5000;
discard.takeoverPoll = 50;
discard.takeoverRetries = 1;
discard.takeoverFenceTimeout = 10000;
discard.takeoverJobs = takeoverJobs;

export {discard, inprogress};
