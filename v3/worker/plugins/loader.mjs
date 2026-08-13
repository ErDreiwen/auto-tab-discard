import {storage} from '../core/prefs.mjs';
import {createPluginPreferenceGate} from '../core/plugin-preferences.mjs';
import {createInterruptRegistry} from '../core/plugin-interrupts.mjs';
import startup from './startup/core.mjs';
import focus from './focus/core.mjs';
import trash from './trash/core.mjs';
import force from './force/core.mjs';
import next from './next/core.mjs';
import previous from './previous/core.mjs';
import blank from './blank/core.mjs';
import create from './create/core.mjs';
import unloaded from './unloaded/core.mjs';
import youtube from './youtube/core.mjs';

const D = Object.freeze({
  'before-menu-click'() {
    return Promise.resolve();
  },
  'before-action'() {
    return ready;
  }
});

// this is used to interrupt an internal process from a plug-in
const {interrupts, overwrite, release} = createInterruptRegistry(D);

/* plug-in system */
// Register browser-start behavior synchronously so the onStartup event cannot outrun it.
startup.enable();
const pluginPreferences = {
  './plugins/focus/core.js': false,
  './plugins/trash/core.js': false,
  './plugins/force/core.js': false,
  './plugins/next/core.js': false,
  './plugins/previous/core.js': false,
  './plugins/blank/core.js': true,
  './plugins/new/core.js': false,
  './plugins/unloaded/core.js': false,
  './plugins/youtube/core.js': false
};
const pluginGate = createPluginPreferenceGate({
  './plugins/focus/core.js': focus,
  './plugins/trash/core.js': trash,
  './plugins/force/core.js': force,
  './plugins/next/core.js': next,
  './plugins/previous/core.js': previous,
  './plugins/blank/core.js': blank,
  './plugins/new/core.js': create,
  './plugins/unloaded/core.js': unloaded,
  './plugins/youtube/core.js': youtube
});
const startupPreferenceRevision = pluginGate.snapshot();
const ready = storage(pluginPreferences).then(preferences => {
  pluginGate.applyStartup(startupPreferenceRevision, preferences);
});

chrome.storage.onChanged.addListener(ps => {
  // AMO does not like dynamic imports. The modules remain statically imported;
  // this gate only protects their preference ordering.
  for (const [key, change] of Object.entries(ps)) {
    pluginGate.applyChange(key, change?.newValue === true);
  }
});

export {
  interrupts,
  overwrite,
  release
};
