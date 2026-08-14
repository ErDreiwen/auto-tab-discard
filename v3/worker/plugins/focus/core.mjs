import {log, query} from '../../core/utils.mjs';
import {releaseMatching} from '../../core/release.mjs';
import {pluginFilters} from '../../modes/number.mjs';
import {focusReleaseScope} from '../release-scopes.mjs';

const observe = windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    return query({
      active: true,
      windowId,
      windowType: 'normal'
    }).then(activeTabs => {
      const scope = focusReleaseScope(activeTabs?.[0]);
      return scope && query(scope.query).then(tabs => releaseMatching(tabs, scope));
    })
      .catch(error => log('focus release failed', error));
  }
};

function enable() {
  log('installing focus/core.js');
  chrome.windows.onFocusChanged.addListener(observe);
  query({
    currentWindow: true,
    active: true
  }).then(tbs => tbs.length && observe(tbs[0].windowId));

  let id;
  pluginFilters['./plugins/focus/core.js'] = {
    prepare() {
      return query({
        active: true,
        currentWindow: true
      }).then(tbs => {
        id = tbs && tbs.length ? tbs[0].windowId : -1;
      });
    },
    check(tab) {
      return tab.windowId !== id;
    }
  };
}
function disable() {
  log('removing focus/core.js');
  delete pluginFilters['./plugins/focus/core.js'];
  chrome.windows.onFocusChanged.removeListener(observe);
}

export default {
  enable,
  disable
};
