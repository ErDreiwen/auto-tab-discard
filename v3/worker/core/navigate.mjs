import {query} from './utils.mjs';

const update = (id, properties) => new Promise((resolve, reject) => chrome.tabs.update(id, properties, tab => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message));
  }
  else {
    resolve(tab);
  }
}));
const remove = id => new Promise((resolve, reject) => chrome.tabs.remove(id, () => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message));
  }
  else {
    resolve();
  }
}));

const navigate = async (method, discarded = false) => {
  const tbs = await query({currentWindow: true});
  const active = tbs.filter(tbs => tbs.active).shift();
  if (!active) {
    return false;
  }
  const next = tbs.filter(t => t.discarded === discarded && t.index > active.index);
  const previous = tbs.filter(t => t.discarded === discarded && t.index < active.index);
  let ntab;
  if (method === 'move-next') {
    ntab = next.length ? next.shift() : previous.shift();
  }
  else {
    ntab = previous.length ? previous.pop() : next.pop();
  }

  if (ntab) {
    await update(ntab.id, {active: true});
    if (method === 'close') {
      await remove(active.id);
    }
    return true;
  }
  // prevent infinite loop
  else if (discarded === false) {
    // https://github.com/rNeomy/auto-tab-discard/issues/41#issuecomment-422923307
    return navigate(method, true);
  }

  // https://github.com/rNeomy/auto-tab-discard/issues/264#issuecomment-1001410665
  if (method === 'close' && !ntab && tbs.length === 1 && tbs[0].active) {
    await remove(active.id);
    return true;
  }

  return false;
};

export {navigate};
