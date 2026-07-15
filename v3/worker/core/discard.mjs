import {prefs, storage} from './prefs.mjs';
import {log} from './utils.mjs';
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

export {discard, inprogress};
