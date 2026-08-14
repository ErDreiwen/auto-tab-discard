import {prefs, storage} from './prefs.mjs';

const starters = {
  ready: false,
  cache: [],
  push(c) {
    if (starters.ready) {
      return c();
    }
    starters.cache.push(c);
  }
};

const browserStarters = {
  cache: [],
  push(c) {
    browserStarters.cache.push(c);
  }
};

{
  let pending;
  // Preferences are only up-to-date on the first run. For all other needs call storage().then().
  const once = () => {
    if (starters.ready) {
      return Promise.resolve(prefs);
    }
    if (pending) {
      return pending;
    }

    pending = storage(prefs).then(ps => {
      Object.assign(prefs, ps);

      starters.ready = true;
      const cache = starters.cache.splice(0);
      return Promise.allSettled(cache.map(c => Promise.resolve().then(c))).then(() => prefs);
    }).catch(e => {
      pending = undefined;
      throw e;
    });

    return pending;
  };

  chrome.runtime.onStartup.addListener(() => once().then(() => {
    const cache = browserStarters.cache.splice(0);
    return Promise.allSettled(cache.map(c => Promise.resolve().then(c)));
  }));
  chrome.runtime.onInstalled.addListener(once);

  // Manifest V3 workers can be restarted for any event, without onStartup firing again.
  once().catch(e => console.error('startup initialization failed', e));
}

export {starters, browserStarters};
