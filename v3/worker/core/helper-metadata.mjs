const KEY_PREFIX = '__blankHelperMetadata:';
const DEFAULT_TTL = 30_000;
const TITLE_LIMIT = 512;
const FAVICON_LIMIT = 4096;

const safeText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const safeFavicon = value => {
  value = safeText(value, FAVICON_LIMIT);
  if (!value) {
    return '';
  }
  try {
    const url = new URL(value);
    return ['data:', 'http:', 'https:', 'chrome-extension:', 'moz-extension:'].includes(url.protocol) ? value : '';
  }
  catch (error) {
    return '';
  }
};

const callArea = (area, method, argument) => new Promise((resolve, reject) => {
  let settled = false;
  const done = value => {
    if (settled) {
      return;
    }
    settled = true;
    const error = globalThis.chrome?.runtime?.lastError;
    error ? reject(Error(error.message || String(error))) : resolve(value);
  };
  try {
    const operation = area[method](argument, done);
    if (operation?.then) {
      operation.then(done, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const createHelperMetadataStore = ({
  area = () => chrome.storage.session || chrome.storage.local,
  now = () => Date.now(),
  nonce = () => crypto.randomUUID(),
  ttl = DEFAULT_TTL
} = {}) => {
  const keyFor = value => `${KEY_PREFIX}${value}`;
  const validNonce = value => typeof value === 'string' && /^[a-z\d-]{16,80}$/i.test(value);

  const put = async metadata => {
    const id = nonce();
    if (!validNonce(id)) {
      throw Error('helper metadata nonce is invalid');
    }
    await callArea(area(), 'set', {
      [keyFor(id)]: {
        expiresAt: now() + ttl,
        favicon: safeFavicon(metadata?.favicon),
        title: safeText(metadata?.title, TITLE_LIMIT)
      }
    });
    return id;
  };

  const remove = async id => {
    if (!validNonce(id)) {
      return false;
    }
    await callArea(area(), 'remove', keyFor(id));
    return true;
  };

  const take = async id => {
    if (!validNonce(id)) {
      return undefined;
    }
    const key = keyFor(id);
    const values = await callArea(area(), 'get', {[key]: undefined});
    // Delete before using the value so page errors, reloads, and duplicate
    // helper pages cannot retain or replay private source-tab metadata.
    await callArea(area(), 'remove', key);
    const record = values?.[key];
    if (!record || typeof record !== 'object' || record.expiresAt <= now()) {
      return undefined;
    }
    return {
      favicon: safeFavicon(record.favicon),
      title: safeText(record.title, TITLE_LIMIT)
    };
  };

  const cleanup = async () => {
    const values = await callArea(area(), 'get', null);
    const expired = Object.entries(values || {})
      .filter(([key, record]) => key.startsWith(KEY_PREFIX) &&
        (!record || typeof record !== 'object' || record.expiresAt <= now()))
      .map(([key]) => key);
    if (expired.length) {
      await callArea(area(), 'remove', expired);
    }
    return expired.length;
  };

  return {cleanup, put, remove, take};
};

const helperMetadata = createHelperMetadataStore();

export {
  createHelperMetadataStore,
  DEFAULT_TTL,
  helperMetadata,
  KEY_PREFIX
};
