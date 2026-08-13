const installed = new WeakMap();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const splitCallback = args => {
  const values = [...args];
  const callback = typeof values.at(-1) === 'function' ? values.pop() : undefined;
  return {callback, values};
};

// Firefox's chrome namespace has supported both callback- and Promise-shaped
// APIs over time. Normalize the native side to one Promise without calling an
// operation twice when it already accepts the compatibility callback.
const invoke = (chromeApi, target, self, args) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (method, value) => {
    if (settled === false) {
      settled = true;
      method(value);
    }
  };
  const callback = value => {
    const error = chromeApi.runtime?.lastError;
    if (error) {
      finish(reject, Error(error.message || String(error)));
    }
    else {
      finish(resolve, value);
    }
  };

  let returned;
  try {
    returned = Reflect.apply(target, self, [...args, callback]);
  }
  catch (callbackError) {
    try {
      returned = Reflect.apply(target, self, args);
    }
    catch (promiseError) {
      finish(reject, promiseError || callbackError);
      return;
    }
  }

  if (returned && typeof returned.then === 'function') {
    returned.then(value => finish(resolve, value), error => finish(reject, error));
  }
  else if (returned !== undefined) {
    finish(resolve, returned);
  }
});

const complete = (operation, callback) => {
  if (!callback) {
    return operation;
  }
  operation.then(callback, error => {
    console.error('Firefox tab compatibility call failed', error);
    callback(undefined);
  });
};

const popupContext = () => {
  const href = typeof location === 'undefined' ? '' : location.href;
  return /\/data\/popup\//.test(href);
};

const backgroundPage = chromeApi => {
  const getBackgroundPage = chromeApi.runtime?.getBackgroundPage;
  if (typeof getBackgroundPage !== 'function') {
    return Promise.reject(Error('Firefox background page is unavailable'));
  }
  return invoke(chromeApi, getBackgroundPage, chromeApi.runtime, []);
};

const installPopupProxies = chromeApi => {
  const tabs = chromeApi.tabs;
  for (const method of ['update', 'query']) {
    const original = tabs[method];
    tabs[method] = new Proxy(original, {
      apply(target, self, args) {
        const {callback, values} = splitCallback(args);
        const operation = backgroundPage(chromeApi).then(background => {
          const remoteTabs = background?.chrome?.tabs;
          if (!remoteTabs || typeof remoteTabs[method] !== 'function') {
            throw Error(`Firefox background tabs.${method} is unavailable`);
          }
          return Reflect.apply(remoteTabs[method], remoteTabs, values);
        });
        return complete(operation, callback);
      }
    });
  }
  return {context: 'popup'};
};

const installBackgroundProxies = chromeApi => {
  const tabs = chromeApi.tabs;
  const native = {
    get: tabs.get,
    query: tabs.query,
    update: tabs.update
  };
  const protectedIds = new Set();

  const decorate = tab => tab && typeof tab === 'object' ? {
    ...tab,
    autoDiscardable: protectedIds.has(tab.id) === false
  } : tab;
  const readTab = id => {
    if (Number.isInteger(id) && typeof native.get === 'function') {
      return invoke(chromeApi, native.get, tabs, [id]);
    }
    return invoke(chromeApi, native.query, tabs, [{active: true, currentWindow: true}])
      .then(results => results?.[0]);
  };
  const remember = (id, autoDiscardable) => {
    if (!Number.isInteger(id)) {
      return;
    }
    if (autoDiscardable === false) {
      protectedIds.add(id);
    }
    else {
      protectedIds.delete(id);
    }
  };

  tabs.update = new Proxy(native.update, {
    apply(target, self, args) {
      const {callback, values} = splitCallback(args);
      const hasId = Number.isInteger(values[0]);
      const id = hasId ? values[0] : undefined;
      const supplied = values[hasId ? 1 : 0];
      const properties = supplied && typeof supplied === 'object' ? {...supplied} : {};
      const emulatesAutoDiscardable = own(properties, 'autoDiscardable');
      const autoDiscardable = properties.autoDiscardable !== false;
      delete properties.autoDiscardable;

      let operation;
      if (Object.keys(properties).length) {
        const nativeArgs = hasId ? [id, properties] : [properties];
        operation = invoke(chromeApi, target, tabs, nativeArgs);
      }
      else if (emulatesAutoDiscardable) {
        // Do not leave callback callers hanging (or Promise callers pending)
        // when autoDiscardable is the only, Firefox-emulated property.
        operation = readTab(id);
      }
      else {
        operation = Promise.reject(Error('tabs.update requires at least one update property'));
      }

      operation = operation.then(async tab => {
        let current = tab;
        if (!current && Number.isInteger(id)) {
          current = await readTab(id);
        }
        if (!current) {
          throw Error('Firefox tabs.update did not return a tab');
        }
        if (emulatesAutoDiscardable) {
          remember(Number.isInteger(id) ? id : current.id, autoDiscardable);
        }
        return decorate(current);
      });
      return complete(operation, callback);
    }
  });

  tabs.query = new Proxy(native.query, {
    apply(target, self, args) {
      const {callback, values} = splitCallback(args);
      const supplied = values[0];
      const queryInfo = supplied && typeof supplied === 'object' ? {...supplied} : {};
      const filtersAutoDiscardable = own(queryInfo, 'autoDiscardable');
      const autoDiscardable = queryInfo.autoDiscardable !== false;
      const filtersStatus = own(queryInfo, 'status');
      const status = queryInfo.status;
      delete queryInfo.autoDiscardable;
      delete queryInfo.status;

      const operation = invoke(chromeApi, target, tabs, [queryInfo]).then(results => {
        let found = Array.isArray(results) ? results : [];
        if (filtersAutoDiscardable) {
          found = found.filter(tab => protectedIds.has(tab.id) !== autoDiscardable);
        }
        if (filtersStatus) {
          found = found.filter(tab => tab.status === status);
        }
        return found.map(decorate);
      });
      return complete(operation, callback);
    }
  });

  tabs.onRemoved?.addListener(id => protectedIds.delete(id));
  return {context: 'background', protectedIds};
};

const installFirefoxCompatibility = (chromeApi, {popup = popupContext()} = {}) => {
  if (!chromeApi?.tabs) {
    throw Error('Firefox tab compatibility requires chrome.tabs');
  }
  if (installed.has(chromeApi.tabs)) {
    return installed.get(chromeApi.tabs);
  }
  const state = popup ? installPopupProxies(chromeApi) : installBackgroundProxies(chromeApi);
  installed.set(chromeApi.tabs, state);
  return state;
};

if (typeof navigator !== 'undefined' && /Firefox/.test(navigator.userAgent) &&
    typeof chrome !== 'undefined') {
  installFirefoxCompatibility(chrome);
}

export {installFirefoxCompatibility};
