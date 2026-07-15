import {prefs, storage} from './prefs.mjs';
import {log} from './utils.mjs';
import {withTimeout} from './promise.mjs';

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
    const next = () => {
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
            }, reason => setTimeout(next, prefs['favicon-delay'], reason));
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
discard.perform = tab => withTimeout(new Promise(resolve => {
  try {
    chrome.tabs.discard(tab.id, result => {
      const error = chrome.runtime.lastError;
      if (error) {
        log('discarding failed', error.message || error);
        resolve(false);
      }
      else if (result === undefined) {
        // Firefox does not return a Tab; Chromium can also omit it for a skipped discard.
        chrome.tabs.get(tab.id, current => {
          const getError = chrome.runtime.lastError;
          resolve(Boolean(!getError && current && current.discarded));
        });
      }
      else {
        resolve(Boolean(result.discarded));
      }
    });
  }
  catch (e) {
    log('discarding failed', e);
    resolve(false);
  }
}), 5000, false);

export {discard, inprogress};
