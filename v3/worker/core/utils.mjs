import {prefs} from './prefs.mjs';
import {
  evaluateRuleList,
  REJECTED_RULE_MATCH,
  validateRuleList
} from './rules.mjs';

const log = (...args) => prefs.log && console.log((new Date()).toLocaleTimeString(), ...args);

const notify = e => chrome.notifications.create({
  title: chrome.runtime.getManifest().name,
  type: 'basic',
  iconUrl: '/data/icons/48.png',
  message: e.message || e
});

const query = options => new Promise((resolve, reject) => {
  try {
    const operation = chrome.tabs.query(options, tabs => {
      const error = chrome.runtime.lastError;
      if (error) {
        const failure = Error(error.message || String(error));
        if (error.code !== undefined) {
          failure.code = error.code;
        }
        reject(failure);
      }
      else {
        resolve(tabs || []);
      }
    });
    // Promise-only implementations (and compatibility shims) may ignore the
    // callback. Only attach to a returned Promise; callback APIs remain settled
    // by the callback above and duplicate resolution is harmless.
    if (operation?.then) {
      operation.then(tabs => resolve(tabs || []), reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const match = (list, hostname, href) => {
  const result = evaluateRuleList(list, hostname, href);
  return result.valid ? (result.matched || undefined) : REJECTED_RULE_MATCH;
};

export {query, notify, log, match, validateRuleList};

