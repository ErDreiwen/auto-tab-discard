import {overwrite, release} from '../loader.mjs';
import {helperRegistry} from '../../core/helper-registry.mjs';
import {helperMetadata} from '../../core/helper-metadata.mjs';
import {createBlankPreparer} from '../../core/blank-helper.mjs';
import {inprogress} from '../../core/discard.mjs';
import {ownership} from '../../core/ownership.mjs';
import {log, query} from '../../core/utils.mjs';

const createTab = options => new Promise((resolve, reject) => {
  try {
    const operation = chrome.tabs.create(options, tab => {
      const error = chrome.runtime.lastError;
      error ? reject(Error(error.message || error)) : resolve(tab);
    });
    if (operation?.then) {
      operation.then(resolve, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const helperOptions = (tab, active = false, nonce = '') => {
  return {
    active,
    index: tab.index,
    url: `/worker/plugins/blank/blank.html#${nonce}`,
    windowId: tab.windowId
  };
};

const createHelper = async (tab, {active = false, transactionId} = {}) => {
  const nonce = await helperMetadata.put({
    favicon: tab.favIconUrl,
    title: tab.title
  });
  let helper;
  try {
    helper = await ownership.withNativeMutationGuard(() =>
      createTab(helperOptions(tab, active, nonce)),
    tab.id);
    await helperRegistry.add(helper, {transactionId, openerTabId: tab.id});
    return helper;
  }
  catch (error) {
    await helperMetadata.remove(nonce).catch(() => false);
    if (Number.isInteger(helper?.id)) {
      await helperRegistry.close(helper.id).catch(() => false);
    }
    throw error;
  }
};

const helperPage = chrome.runtime.getURL('worker/plugins/blank/blank.html');
const isHelper = tab => [tab?.pendingUrl, tab?.url]
  .some(url => typeof url === 'string' && url.split('#', 1)[0] === helperPage);

const prepareBlank = createBlankPreparer({
  activate: tab => ownership.withNativeMutationGuard(() =>
    chrome.tabs.update(tab.id, {active: true}),
  tab.id),
  create: createHelper,
  inProgress: id => inprogress.has(id),
  isHelper,
  read: query,
  registry: helperRegistry,
  resolveId: ownership.resolveId,
  sendMessage: (id, message) => chrome.tabs.sendMessage(id, message)
});
let recovery = Promise.resolve();
const recover = () => {
  recovery = recovery.then(async () => {
    const settled = await Promise.allSettled([
      helperMetadata.cleanup(),
      helperRegistry.cleanup()
    ]);
    const failures = settled
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, 'blank helper recovery failed');
    }
  });
  // Keep the recovery rejection observed while preserving it for prepare().
  recovery.catch(error => log('blank helper recovery failed', error));
};
const prepare = (...args) => recovery.then(() => prepareBlank(...args));

function enable() {
  log('blank.enable is called');
  recover();
  overwrite('before-menu-click', prepare);
}
function disable() {
  log('blank.disable is called');
  release('before-menu-click');
  recover();
}

export default {disable, enable};
export {createBlankPreparer, prepare};
