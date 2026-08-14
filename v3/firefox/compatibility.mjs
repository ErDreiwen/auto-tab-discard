const installed = new WeakMap();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const BRIDGE_METHOD = 'firefox-tabs-compat';
const PROTECTED_IDS_KEY = 'firefox.protectedTabIds';
const MAX_PROTECTED_IDS = 100_000;
const MAX_BRIDGE_TABS = 100_000;
const POPUP_PATH = '/data/popup/index.html';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, expected) => record(value) &&
  Object.keys(value).length === expected.length && expected.every(key => own(value, key));
const validTabId = value => Number.isSafeInteger(value) && value >= 0;
const validTab = value => record(value) && validTabId(value.id);
// The popup currently needs only three query shapes. Keep this bridge narrower
// than chrome.tabs.query so another extension page cannot turn it into a broad
// background API proxy if its own UI realm is ever compromised.
const validQuery = value => record(value) && (
  exactKeys(value, ['active', 'currentWindow']) &&
    typeof value.active === 'boolean' && typeof value.currentWindow === 'boolean' ||
  exactKeys(value, ['currentWindow', 'highlighted']) &&
    typeof value.currentWindow === 'boolean' && typeof value.highlighted === 'boolean' ||
  exactKeys(value, ['active', 'windowType']) &&
    typeof value.active === 'boolean' && value.windowType === 'normal' ||
  exactKeys(value, ['active', 'windowId', 'windowType']) &&
    typeof value.active === 'boolean' && validTabId(value.windowId) && value.windowType === 'normal' ||
  exactKeys(value, ['active', 'currentWindow', 'windowType']) &&
    typeof value.active === 'boolean' && typeof value.currentWindow === 'boolean' &&
      value.windowType === 'normal'
);
const validUpdate = value => exactKeys(value, ['autoDiscardable']) &&
  typeof value.autoDiscardable === 'boolean';

const splitCallback = args => {
  const values = [...args];
  const callback = typeof values.at(-1) === 'function' ? values.pop() : undefined;
  return {callback, values};
};

const errorFrom = (value, fallback = 'Firefox tab compatibility call failed') => {
  const error = value instanceof Error ? value : Error(value?.message || String(value || fallback));
  if (value?.code !== undefined && error.code === undefined) {
    error.code = value.code;
  }
  return error;
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
      finish(reject, errorFrom(error));
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
      finish(reject, errorFrom(promiseError || callbackError));
      return;
    }
  }

  if (returned && typeof returned.then === 'function') {
    returned.then(value => finish(resolve, value), error => finish(reject, errorFrom(error)));
  }
  else if (returned !== undefined) {
    finish(resolve, returned);
  }
});

// Callback callers retain the native undefined return shape. A second callback
// argument carries compatibility-layer failures because runtime.lastError is
// read-only and is only populated by the browser's own callback dispatch.
const complete = (operation, callback) => {
  if (!callback) {
    return operation;
  }
  operation.then(value => callback(value), error => callback(undefined, errorFrom(error)));
};

const popupContext = () => {
  const href = typeof location === 'undefined' ? '' : location.href;
  return /\/data\/popup\//.test(href);
};

const bridgeRequest = (operation, values) => {
  if (operation === 'query' && values.length === 1 && validQuery(values[0])) {
    return {method: BRIDGE_METHOD, operation, queryInfo: {...values[0]}};
  }
  if (operation === 'update' && values.length === 2 && validTabId(values[0]) &&
      validUpdate(values[1])) {
    return {
      method: BRIDGE_METHOD,
      operation,
      properties: {...values[1]},
      tabId: values[0]
    };
  }
  throw Error(`Invalid Firefox popup tabs.${operation} request`);
};

const validBridgeRequest = request => request?.method === BRIDGE_METHOD && (
  request.operation === 'query' ?
    exactKeys(request, ['method', 'operation', 'queryInfo']) && validQuery(request.queryInfo) :
    request.operation === 'update' ?
      exactKeys(request, ['method', 'operation', 'properties', 'tabId']) &&
        validTabId(request.tabId) && validUpdate(request.properties) : false
);

const popupSender = (runtime, sender) => {
  if (!runtime?.id || sender?.id !== runtime.id || typeof runtime.getURL !== 'function' ||
      typeof sender?.url !== 'string') {
    return false;
  }
  try {
    const expected = new URL(runtime.getURL(POPUP_PATH));
    const actual = new URL(sender.url);
    return actual.protocol === expected.protocol && actual.origin === expected.origin &&
      actual.pathname === expected.pathname;
  }
  catch (error) {
    return false;
  }
};

const bridgeError = error => ({
  code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ?
    error.code : 'FIREFOX_TAB_API_FAILED',
  message: 'Firefox tab compatibility operation failed'
});

const unwrapBridgeResponse = (response, operation) => {
  if (exactKeys(response, ['ok', 'value']) && response.ok === true) {
    const valid = operation === 'query' ? Array.isArray(response.value) &&
      response.value.length <= MAX_BRIDGE_TABS && response.value.every(validTab) :
      validTab(response.value);
    if (valid) {
      return response.value;
    }
    throw Error('Firefox tab compatibility bridge returned malformed tab data');
  }
  if (exactKeys(response, ['error', 'ok']) && response.ok === false &&
      exactKeys(response.error, ['code', 'message']) &&
      typeof response.error.code === 'string' && typeof response.error.message === 'string') {
    const error = Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }
  throw Error('Firefox tab compatibility bridge returned a malformed response');
};

const installPopupProxies = chromeApi => {
  const tabs = chromeApi.tabs;
  const runtime = chromeApi.runtime;
  if (typeof runtime?.sendMessage !== 'function') {
    throw Error('Firefox popup compatibility requires runtime messaging');
  }
  for (const method of ['update', 'query']) {
    const original = tabs[method];
    if (typeof original !== 'function') {
      throw Error(`Firefox popup compatibility requires tabs.${method}`);
    }
    tabs[method] = new Proxy(original, {
      apply(target, self, args) {
        const {callback, values} = splitCallback(args);
        let operation;
        try {
          const request = bridgeRequest(method, values);
          operation = invoke(chromeApi, runtime.sendMessage, runtime, [request])
            .then(response => unwrapBridgeResponse(response, method));
        }
        catch (error) {
          operation = Promise.reject(errorFrom(error));
        }
        return complete(operation, callback);
      }
    });
  }
  return {context: 'popup'};
};

const protectedIdStore = (chromeApi, protectedIds) => {
  const area = chromeApi.storage?.session;
  const persistent = typeof area?.get === 'function' && typeof area?.set === 'function';
  const hydrate = persistent ? invoke(chromeApi, area.get, area, [[PROTECTED_IDS_KEY]])
    .then(values => {
      const stored = values?.[PROTECTED_IDS_KEY];
      if (stored === undefined) {
        return;
      }
      if (!Array.isArray(stored) || stored.length > MAX_PROTECTED_IDS ||
          stored.some(id => !validTabId(id))) {
        throw Error('Firefox protected-tab session state is malformed');
      }
      for (const id of new Set(stored)) {
        protectedIds.add(id);
      }
    }) : Promise.resolve();
  let serial = hydrate;

  const write = () => persistent ? invoke(chromeApi, area.set, area, [{
    [PROTECTED_IDS_KEY]: [...protectedIds].sort((a, b) => a - b)
  }]) : Promise.resolve();
  const mutate = task => {
    const operation = serial.then(async () => {
      const changed = task();
      if (changed) {
        await write();
      }
    });
    // A failed hydration/write is retained so later reads cannot silently use
    // a cache whose browser-session durability is unknown.
    serial = operation;
    return operation;
  };

  return {
    ready: () => serial,
    remember(id, autoDiscardable) {
      if (!validTabId(id)) {
        return Promise.reject(Error('Firefox protected-tab update has an invalid tab ID'));
      }
      return mutate(() => {
        const wasProtected = protectedIds.has(id);
        if (autoDiscardable === false) {
          protectedIds.add(id);
        }
        else {
          protectedIds.delete(id);
        }
        return wasProtected !== protectedIds.has(id);
      });
    },
    remove(id) {
      return validTabId(id) ? mutate(() => protectedIds.delete(id)) : Promise.resolve();
    },
    replace(addedId, removedId) {
      if (!validTabId(addedId) || !validTabId(removedId)) {
        return Promise.resolve();
      }
      return mutate(() => {
        if (!protectedIds.delete(removedId)) {
          return false;
        }
        protectedIds.add(addedId);
        return true;
      });
    }
  };
};

const installBackgroundProxies = chromeApi => {
  const tabs = chromeApi.tabs;
  const native = {
    get: tabs.get,
    query: tabs.query,
    update: tabs.update
  };
  const protectedIds = new Set();
  const protection = protectedIdStore(chromeApi, protectedIds);

  const decorate = tab => tab && typeof tab === 'object' ? {
    ...tab,
    autoDiscardable: protectedIds.has(tab.id) === false
  } : tab;
  const readTab = id => {
    if (validTabId(id) && typeof native.get === 'function') {
      return invoke(chromeApi, native.get, tabs, [id]);
    }
    return invoke(chromeApi, native.query, tabs, [{active: true, currentWindow: true}])
      .then(results => {
        if (!Array.isArray(results)) {
          throw Error('Firefox tabs.query returned malformed tab data');
        }
        return results[0];
      });
  };

  tabs.update = new Proxy(native.update, {
    apply(target, self, args) {
      const {callback, values} = splitCallback(args);
      const hasId = validTabId(values[0]);
      const id = hasId ? values[0] : undefined;
      const supplied = values[hasId ? 1 : 0];
      const properties = supplied && typeof supplied === 'object' ? {...supplied} : {};
      const emulatesAutoDiscardable = own(properties, 'autoDiscardable');
      const autoDiscardable = properties.autoDiscardable !== false;
      delete properties.autoDiscardable;

      const operation = protection.ready().then(async () => {
        let current;
        if (Object.keys(properties).length) {
          const nativeArgs = hasId ? [id, properties] : [properties];
          current = await invoke(chromeApi, target, tabs, nativeArgs);
        }
        else if (emulatesAutoDiscardable) {
          // Do not leave callback callers hanging (or Promise callers pending)
          // when autoDiscardable is the only, Firefox-emulated property.
          current = await readTab(id);
        }
        else {
          throw Error('tabs.update requires at least one update property');
        }

        if (!current && validTabId(id)) {
          current = await readTab(id);
        }
        if (!validTab(current)) {
          throw Error('Firefox tabs.update did not return a valid tab');
        }
        if (emulatesAutoDiscardable) {
          await protection.remember(validTabId(id) ? id : current.id, autoDiscardable);
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

      const operation = protection.ready()
        .then(() => invoke(chromeApi, target, tabs, [queryInfo]))
        .then(results => {
          if (!Array.isArray(results) || results.some(tab => !validTab(tab))) {
            throw Error('Firefox tabs.query returned malformed tab data');
          }
          let found = results;
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

  tabs.onRemoved?.addListener(id => {
    void protection.remove(id).catch(error =>
      console.error('Firefox protected-tab close pruning failed', error));
  });
  tabs.onReplaced?.addListener((addedId, removedId) => {
    void protection.replace(addedId, removedId).catch(error =>
      console.error('Firefox protected-tab replacement migration failed', error));
  });

  let bridgeListener;
  if (typeof chromeApi.runtime?.onMessage?.addListener === 'function') {
    bridgeListener = (request, sender, sendResponse) => {
      if (!validBridgeRequest(request) || !popupSender(chromeApi.runtime, sender)) {
        return undefined;
      }
      const send = payload => {
        try {
          sendResponse(payload);
        }
        catch (error) {}
      };
      Promise.resolve().then(() => request.operation === 'query' ?
        tabs.query(request.queryInfo) : tabs.update(request.tabId, request.properties)
      ).then(value => send({ok: true, value}), error =>
        send({error: bridgeError(error), ok: false}));
      return true;
    };
    chromeApi.runtime.onMessage.addListener(bridgeListener);
  }
  return {bridgeListener, context: 'background', protectedIds, ready: protection.ready};
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
