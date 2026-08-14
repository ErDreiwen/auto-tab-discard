const FORK_REPOSITORY = 'https://github.com/ErDreiwen/auto-tab-discard';
const RELEASE_NOTES = version => `${FORK_REPOSITORY}/releases/tag/v${encodeURIComponent(version)}`;
const FEEDBACK = `${FORK_REPOSITORY}/issues/new`;

const acceptedLifecycleUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === 'https://github.com' &&
      (url.pathname === '/ErDreiwen/auto-tab-discard/issues/new' ||
        /^\/ErDreiwen\/auto-tab-discard\/releases\/tag\/v[^/]+$/.test(url.pathname)) &&
      url.username === '' && url.password === '' && url.hash === '' && url.search === '';
  }
  catch (error) {
    return false;
  }
};

const setUninstall = (runtime, url) => new Promise((resolve, reject) => {
  let settled = false;
  const done = () => {
    if (settled) {
      return;
    }
    settled = true;
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message || String(error))) : resolve();
  };
  try {
    const operation = runtime.setUninstallURL(url, done);
    if (operation?.then) {
      operation.then(done, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const createLifecycleNavigation = ({
  getPreferences,
  getSelf,
  now = () => Date.now(),
  runtime,
  tabs
}) => {
  const defaults = {
    faqs: true,
    'last-update': 0,
    'lifecycle-feedback': false
  };

  const configureUninstall = async supplied => {
    const preferences = supplied || await getPreferences(defaults);
    const url = preferences['lifecycle-feedback'] === true ? FEEDBACK : '';
    if (url && !acceptedLifecycleUrl(url)) {
      throw Error('lifecycle feedback URL is outside the fixed allowlist');
    }
    await setUninstall(runtime, url);
    return url;
  };

  const installed = async ({reason, previousVersion} = {}) => {
    const self = await getSelf();
    if (self?.installType !== 'normal') {
      return {opened: false, reason: 'non-store install'};
    }
    const preferences = await getPreferences(defaults);
    if (preferences['lifecycle-feedback'] !== true || preferences.faqs !== true) {
      return {opened: false, reason: 'disabled'};
    }
    if (reason !== 'install' && reason !== 'update') {
      return {opened: false, reason: 'unsupported lifecycle event'};
    }
    if (reason === 'update' && previousVersion === runtime.getManifest().version) {
      return {opened: false, reason: 'same version'};
    }
    if (reason === 'update' && (now() - Number(preferences['last-update'] || 0)) < 45 * 86400_000) {
      return {opened: false, reason: 'update notice throttled'};
    }

    const url = RELEASE_NOTES(runtime.getManifest().version);
    if (!acceptedLifecycleUrl(url)) {
      throw Error('release-notes URL is outside the fixed allowlist');
    }
    await tabs.create({active: reason === 'install', url});
    return {opened: true, url};
  };

  return {configureUninstall, installed};
};

export {
  acceptedLifecycleUrl,
  createLifecycleNavigation,
  FEEDBACK,
  FORK_REPOSITORY,
  RELEASE_NOTES
};
