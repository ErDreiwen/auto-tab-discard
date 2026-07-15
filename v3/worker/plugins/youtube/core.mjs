import {log} from '../../core/utils.mjs';
import {discard} from '../../core/discard.mjs';
import {withTimeout} from '../../core/promise.mjs';

const perform = discard.perform;

function enable() {
  log('installing youtube/core.js');
  discard.perform = tab => {
    if (tab.url && tab.url.startsWith('https://www.youtube.com/') && tab.frozen !== true) {
      return withTimeout(chrome.scripting.executeScript({
        target: {
          tabId: tab.id
        },
        world: 'MAIN',
        func: () => {
          const player = document.querySelector('.html5-video-player');
          if (player) {
            const t = player.getCurrentTime();
            if (t) {
              const s = new URLSearchParams(location.search);
              s.set('t', t + 's');
              history.replaceState(history.state, '', '?' + s.toString());
            }
          }
        }
      }), 3000, []).then(() => perform(tab));
    }
    else {
      return perform(tab);
    }
  };
}
function disable() {
  log('removing youtube/core.js');
  discard.perform = perform;
}

export default {
  enable,
  disable
};
