import {log, query} from '../../core/utils.mjs';
import {getTab, releaseMatching} from '../../core/release.mjs';
import {previousReleaseScope} from '../release-scopes.mjs';

const observe = activeInfo => getTab(activeInfo.tabId).then(tab => {
  const scope = previousReleaseScope(activeInfo, tab);
  return scope && query(scope.query).then(tabs => releaseMatching(tabs, scope));
}).catch(error => log('previous release failed', error));

function enable() {
  log('previous.enable is called');
  chrome.tabs.onActivated.addListener(observe);
  query({
    active: true,
    currentWindow: true
  }).then(tbs => {
    if (tbs.length) {
      observe({
        tabId: tbs[0].id
      });
    }
  });
}
function disable() {
  log('previous.disable is called');
  chrome.tabs.onActivated.removeListener(observe);
}

export default {
  enable,
  disable
};
