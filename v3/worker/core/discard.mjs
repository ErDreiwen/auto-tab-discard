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

const remainingTime = deadline => Math.max(0, deadline - Date.now());
const waitBeforeDeadline = async (deadline, interval = discard.takeoverPoll) => {
  const remaining = remainingTime(deadline);
  if (remaining > 0) {
    const delay = Math.min(Math.max(0, interval), remaining);
    // setTimeout(0) is intentional in tests and yields to renderer/event timers;
    // a microtask-only loop can starve a delayed loading transition.
    await new Promise(resolve => setTimeout(resolve, delay));
  }
};
const getTabBeforeDeadline = (id, deadline) => {
  const timeout = Math.min(discard.getTimeout, remainingTime(deadline));
  return timeout > 0 ? withTimeout(getTab(id), timeout, undefined) : Promise.resolve(undefined);
};

const waitForAwake = async (id, token, deadline = Date.now() + discard.takeoverTimeout) => {
  while (Date.now() < deadline && token.cancelled === false) {
    const current = await getTabBeforeDeadline(id, deadline);
    if (!current) {
      return undefined;
    }
    if (current.discarded === false) {
      return current;
    }
    await waitBeforeDeadline(deadline);
  }
};

const observeReload = id => {
  const state = {
    sawLoading: false
  };
  const listener = (tabId, changeInfo, tab) => {
    if (tabId !== id) {
      return;
    }
    const status = changeInfo.status || tab?.status;
    if (status === 'loading') {
      state.sawLoading = true;
    }
  };
  chrome.tabs.onUpdated?.addListener(listener);
  return {
    close: () => chrome.tabs.onUpdated?.removeListener?.(listener),
    state
  };
};

// A takeover has to wake a natively discarded tab before this extension can
// become the physical discarder. Chromium reports discarded:false as soon as
// that navigation starts, not when it is safe to discard again. Discarding the
// still-loading tab can leave a stale tab-strip spinner and a short-lived
// renderer behind, so stop the reload and wait for it to leave "loading" first.
const stopLoadingTab = (id, prepend = '', requireTitle = false) => {
  try {
    return chrome.scripting.executeScript({
      target: {tabId: id},
      injectImmediately: true,
      func: prefix => {
        window.stop();
        if (prefix) {
          const title = document.title || location.href || '';
          if (title.startsWith(prefix) === false) {
            const next = prefix + ' ' + title;
            let root = document.documentElement;
            if (!root) {
              root = document.appendChild(document.createElement('html'));
            }
            let head = document.head;
            if (!head) {
              head = document.createElement('head');
              root.insertBefore(head, root.firstChild);
            }
            let titleElement = head.querySelector('title');
            if (!titleElement) {
              titleElement = head.appendChild(document.createElement('title'));
            }
            titleElement.textContent = next;
            document.title = next;
          }
        }
        return {stopped: true, title: document.title};
      },
      args: [prepend]
    }).then(results => {
      const prepared = results?.find(result => result.result?.stopped === true)?.result;
      if (!prepared) {
        return {error: 'reload stop script did not return a result'};
      }
      if (requireTitle && prepend && prepared.title?.startsWith(prepend) !== true) {
        return {error: `sleep title prefix was not applied (title: ${prepared.title || ''})`};
      }
      return {success: true, title: prepared.title};
    }, error => ({error: error?.message || String(error)}));
  }
  catch (error) {
    return Promise.resolve({error: error?.message || String(error)});
  }
};

const isTransientFrameError = error => /^(?:frame with id \d+ (?:was removed|is not ready)|no frame with id:? \d+(?: in tab(?: with id)? \d+)?)\.?$/i
  .test(String(error || '').trim());

const quiesceReload = async (
  id,
  token,
  initial,
  observation,
  prepend,
  deadline = Date.now() + discard.takeoverTimeout,
  frameRetries = {count: 0}
) => {
  let current = initial || await getTabBeforeDeadline(id, deadline);
  if (!current || current.discarded !== false) {
    return current;
  }

  let completeSince;
  while (Date.now() < deadline && token.cancelled === false) {
    if (!current || current.discarded !== false || current.active === true) {
      return current;
    }
    if (current.status === 'complete') {
      completeSince ||= Date.now();
      const stableFor = observation?.state.sawLoading ?
        discard.quiesceDwell : discard.reloadStartGrace;
      if (Date.now() - completeSince >= stableFor) {
        return current;
      }
      await waitBeforeDeadline(deadline);
      current = await getTabBeforeDeadline(id, deadline);
      continue;
    }

    completeSince = undefined;
    if (current.status !== 'loading') {
      await waitBeforeDeadline(deadline);
      current = await getTabBeforeDeadline(id, deadline);
      continue;
    }

    // discarded:false can precede the new renderer/document commit. A single
    // immediate injection can therefore stop the outgoing document and miss
    // the new load. Retry only after the prior injection resolved successfully;
    // a timed-out operation is left in flight, so fail the takeover and never
    // queue a second stop behind it.
    const stopTimeout = {};
    const stopLimit = Math.min(discard.stopTimeout, remainingTime(deadline));
    const stopped = stopLimit > 0 ?
      await withTimeout(stopLoadingTab(id, prepend), stopLimit, stopTimeout) : stopTimeout;
    if (stopped === stopTimeout) {
      throw Error(`timed out stopping the reload on tab ${id}`);
    }
    if (stopped?.error) {
      // During a renderer commit Chrome can reject an otherwise valid
      // executeScript call because the outgoing main frame disappeared. The
      // promise has settled, so it is safe to reread the tab and retry against
      // the replacement frame. Keep permission and closed-tab errors fatal.
      if (isTransientFrameError(stopped.error)) {
        if (frameRetries.count >= discard.transientFrameRetries) {
          throw Error(`cannot stop the reload on tab ${id}: transient frame retry limit reached`);
        }
        frameRetries.count += 1;
        current = await getTabBeforeDeadline(id, deadline);
        if (!current || current.discarded !== false || current.active === true) {
          return current;
        }
        await waitBeforeDeadline(deadline);
        current = await getTabBeforeDeadline(id, deadline);
        continue;
      }
      throw Error(`cannot stop the reload on tab ${id}: ${stopped.error}`);
    }
    current = await getTabBeforeDeadline(id, deadline);
    if (!current || current.discarded !== false || current.active === true) {
      return current;
    }
    await waitBeforeDeadline(deadline);
    current = await getTabBeforeDeadline(id, deadline);
  }
};

const waitForUnloaded = async (id, token) => {
  const deadline = Date.now() + discard.nativeSettleTimeout;
  let current;
  while (Date.now() < deadline && token.cancelled === false) {
    // Never trust the tabs.discard() callback snapshot as the ownership
    // boundary. A user activation can wake the live tab before finalization.
    current = await getTabBeforeDeadline(id, deadline);
    if (!current) {
      return undefined;
    }
    if (current.discarded === true && current.active !== true && current.status === 'unloaded') {
      return current;
    }
    if (current.discarded !== true || current.active === true) {
      return current;
    }
    await waitBeforeDeadline(deadline);
  }
  return current;
};

const waitForPreparedTitle = async (
  id,
  token,
  prepend,
  initial,
  deadline = Date.now() + discard.titleSettleTimeout
) => {
  if (!prepend) {
    return initial;
  }
  let current = initial;
  while (Date.now() < deadline && token.cancelled === false) {
    if (!current || current.discarded !== false || current.active === true || current.status !== 'complete') {
      return current;
    }
    if (current.title?.startsWith(prepend)) {
      return current;
    }
    await waitBeforeDeadline(deadline);
    current = await getTabBeforeDeadline(id, deadline);
  }
  return current;
};

const prepareAwakeTab = async (id, token, initial, observation, prepend, deadline) => {
  const frameRetries = {count: 0};
  let current = initial;
  while (Date.now() < deadline && token.cancelled === false) {
    current = await quiesceReload(
      id, token, current, observation, prepend, deadline, frameRetries
    );
    if (!current || current.discarded !== false || current.active === true || current.status !== 'complete') {
      return current;
    }

    // A final pass makes the physical takeover visually consistent with an
    // ordinary extension discard. If Chrome swaps the main frame here, return
    // through quiescence and retry against the replacement renderer.
    const prepareTimeout = {};
    const prepareLimit = Math.min(discard.stopTimeout, remainingTime(deadline));
    const prepared = prepareLimit > 0 ?
      await withTimeout(stopLoadingTab(id, prepend, true), prepareLimit, prepareTimeout) : prepareTimeout;
    if (prepared === prepareTimeout) {
      throw Error(`timed out preparing the awakened tab ${id}`);
    }
    if (prepared?.error) {
      if (isTransientFrameError(prepared.error)) {
        if (frameRetries.count >= discard.transientFrameRetries) {
          throw Error(`cannot prepare the awakened tab ${id}: transient frame retry limit reached`);
        }
        frameRetries.count += 1;
        current = await getTabBeforeDeadline(id, deadline);
        if (!current || current.discarded !== false || current.active === true) {
          return current;
        }
        await waitBeforeDeadline(deadline);
        current = await getTabBeforeDeadline(id, deadline);
        continue;
      }
      throw Error(`cannot prepare the awakened tab ${id}: ${prepared.error}`);
    }

    current = await getTabBeforeDeadline(id, deadline);
    const titleDeadline = Math.min(deadline, Date.now() + discard.titleSettleTimeout);
    return waitForPreparedTitle(id, token, prepend, current, titleDeadline);
  }
  return current;
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
  let reloadObservation;
  try {
    const takeoverPrefs = await storage({prepends: prefs.prepends});
    const prepend = takeoverPrefs.prepends || '';
    const takeoverDeadline = Date.now() + discard.takeoverTimeout;
    let awake = current;
    if (current.discarded === true) {
      reloadObservation = observeReload(id);
      const reloadTimeout = {};
      const reloadLimit = remainingTime(takeoverDeadline);
      const reload = reloadLimit > 0 ?
        await withTimeout(reloadTab(id), reloadLimit, reloadTimeout) : reloadTimeout;
      if (reload === reloadTimeout || reload.error) {
        throw Error(reload.error || `timed out waking tab ${id}`);
      }
      awake = await waitForAwake(id, token, takeoverDeadline);
    }
    awake = await prepareAwakeTab(id, token, awake, reloadObservation, prepend, takeoverDeadline);
    if (token.cancelled) {
      throw Error(`discard takeover cancelled for tab ${id}`);
    }
    if (!awake || awake.discarded !== false || awake.active === true || awake.status !== 'complete') {
      throw Error(`tab ${id} did not wake as a quiescent inactive tab`);
    }
    if (prepend && awake.title?.startsWith(prepend) !== true) {
      throw Error(`tab ${id} did not expose its prepared sleep title`);
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
    const nativeStrong = outcome !== nativeTimeout && outcome.success === true && outcome.source === 'self' &&
      outcome.result?.discarded === true;
    let finalTab = outcome?.result || await withTimeout(getTab(id), discard.getTimeout, undefined) || awake;
    if (nativeStrong) {
      // A missing/timed-out live read is a failed takeover, never permission to
      // fall back to the callback's potentially stale discarded snapshot.
      finalTab = await waitForUnloaded(id, token);
    }
    const strong = nativeStrong && finalTab?.discarded === true && finalTab.active !== true &&
      finalTab.status === 'unloaded';
    const owned = await ownership.finish(finalTab || {...awake, discarded: false}, attemptId,
      strong ? 'self' : undefined, {
      allowClaimed: false
    });
    finished = true;

    if (strong && owned) {
      if (await ownership.confirmSelf(id, attemptId)) {
        return true;
      }
      throw Error(`discard takeover failed for tab ${id}: tab woke during ownership finalization`);
    }
    const reason = outcome === nativeTimeout ? 'native discard timed out' : outcome?.error ||
      (nativeStrong ? 'native discard did not settle in the unloaded state' :
        'another discarder won before the native discard');
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
  finally {
    reloadObservation?.close();
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

// Popup adoption commands can join the exact physical job instead of relying
// on a duplicated timeout that cannot account for queue or storage latency.
discard.waitForTakeover = id => takeoverJobs.get(id)?.promise;

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
discard.nativeSettleTimeout = 5000;
discard.quiesceDwell = 100;
discard.reloadStartGrace = 250;
discard.stopTimeout = 1000;
discard.titleSettleTimeout = 1000;
discard.transientFrameRetries = 2;
discard.takeoverJobs = takeoverJobs;

export {discard, inprogress};
