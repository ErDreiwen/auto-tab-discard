import {storage} from '../core/prefs.mjs';
import {
  canonicalPluginPreferenceKey,
  PLUGIN_IDS,
  PLUGIN_PREFERENCES
} from '../core/plugin-catalog.mjs';
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
const pluginGate = createPluginPreferenceGate({
  [PLUGIN_IDS.focus]: focus,
  [PLUGIN_IDS.trash]: trash,
  [PLUGIN_IDS.force]: force,
  [PLUGIN_IDS.next]: next,
  [PLUGIN_IDS.previous]: previous,
  [PLUGIN_IDS.blank]: blank,
  [PLUGIN_IDS.create]: create,
  [PLUGIN_IDS.unloaded]: unloaded,
  [PLUGIN_IDS.youtube]: youtube
});
const startupPreferenceRevision = pluginGate.snapshot();
const ready = storage(PLUGIN_PREFERENCES).then(preferences => {
  pluginGate.applyStartup(startupPreferenceRevision, preferences);
});

const revisions = new Map();
chrome.storage.onChanged.addListener((ps, areaName = 'local') => {
  if (areaName !== 'local' && areaName !== 'managed') {
    return;
  }
  // AMO does not like dynamic imports. The modules remain statically imported;
  // this gate only protects their preference ordering.
  const keys = new Set(Object.keys(ps).map(canonicalPluginPreferenceKey).filter(Boolean));
  for (const key of keys) {
    const revision = (revisions.get(key) || 0) + 1;
    revisions.set(key, revision);
    void storage({[key]: PLUGIN_PREFERENCES[key]}).then(preferences => {
      if (revisions.get(key) === revision) {
        pluginGate.applyChange(key, preferences[key] === true);
      }
    }).catch(error => console.error(`plugin preference refresh failed: ${key}`, error));
  }
});

export {
  interrupts,
  overwrite,
  release
};
