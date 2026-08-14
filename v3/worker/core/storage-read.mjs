const STORAGE_READ_TIMEOUT = 2000;
const MANAGED_STORAGE_READ_TIMEOUT = 10_000;
const FIREFOX_MANAGED_MANIFEST_MISSING = 'Managed storage manifest not found';

const storageReadError = error => {
  if (error instanceof Error) {
    return error;
  }
  const message = error?.message || (error ? String(error) : 'storage read failed');
  return Error(message);
};

// A storage read is part of the extension's safety policy. Defaults describe
// what a successful read should return for absent keys; they must never turn a
// missing API, browser error, rejected Promise, or hung callback into a
// successful policy read.
const readStorageArea = (area, query, {timeoutMs = STORAGE_READ_TIMEOUT} = {}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const fail = error => finish(reject, storageReadError(error));
    const accept = values => {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        fail(Error('storage read returned malformed data'));
      }
      else {
        finish(resolve, values);
      }
    };

    if (typeof area?.get !== 'function') {
      fail(Error('storage area is unavailable'));
      return;
    }

    const boundedTimeout = Math.max(1, Number(timeoutMs) || STORAGE_READ_TIMEOUT);
    timer = setTimeout(() => fail(Error('storage read timed out')), boundedTimeout);
    try {
      const operation = area.get(query, (values, compatibilityError) => {
        // runtime.lastError must be consumed inside the callback. Some browser
        // compatibility layers instead deliver the same failure as argument 2.
        const error = globalThis.chrome?.runtime?.lastError || compatibilityError;
        error ? fail(error) : accept(values);
      });
      if (operation?.then) {
        operation.then(accept, fail);
      }
    }
    catch (error) {
      fail(error);
    }
  });

// Firefox exposes storage.managed even when the administrator has installed no
// policy manifest, then reports this one fixed absence condition as an error.
// It is semantically the empty managed layer—not a failed read. Every other
// error channel remains fail-closed, including the same text outside Firefox.
const readManagedStorageArea = async (area, query, {
  firefox = /\bFirefox\//.test(globalThis.navigator?.userAgent || ''),
  timeoutMs = MANAGED_STORAGE_READ_TIMEOUT
} = {}) => {
  try {
    return await readStorageArea(area, query, {timeoutMs});
  }
  catch (error) {
    if (firefox === true && error?.message === FIREFOX_MANAGED_MANIFEST_MISSING) {
      return {};
    }
    throw error;
  }
};

export {
  FIREFOX_MANAGED_MANIFEST_MISSING,
  MANAGED_STORAGE_READ_TIMEOUT,
  readManagedStorageArea,
  readStorageArea,
  STORAGE_READ_TIMEOUT
};
