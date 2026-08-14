const PLUGIN_IDS = Object.freeze({
  blank: './plugins/blank/core.js',
  focus: './plugins/focus/core.js',
  trash: './plugins/trash/core.js',
  force: './plugins/force/core.js',
  next: './plugins/next/core.js',
  previous: './plugins/previous/core.js',
  create: './plugins/new/core.js',
  unloaded: './plugins/unloaded/core.js',
  youtube: './plugins/youtube/core.js'
});

const PLUGIN_PREFERENCES = Object.freeze({
  [PLUGIN_IDS.blank]: true,
  [PLUGIN_IDS.focus]: false,
  [PLUGIN_IDS.trash]: false,
  [PLUGIN_IDS.force]: false,
  [PLUGIN_IDS.next]: false,
  [PLUGIN_IDS.previous]: false,
  [PLUGIN_IDS.create]: false,
  [PLUGIN_IDS.unloaded]: false,
  [PLUGIN_IDS.youtube]: false
});

const PLUGIN_KEYS = Object.freeze(Object.keys(PLUGIN_PREFERENCES));
const PLUGIN_POLICY_ALIASES = Object.freeze({
  'trash.enabled': PLUGIN_IDS.trash,
  'release-next-tab': PLUGIN_IDS.next
});
const PLUGIN_POLICY_KEYS = Object.freeze([
  ...PLUGIN_KEYS,
  ...Object.keys(PLUGIN_POLICY_ALIASES)
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const canonicalPluginPreferenceKey = key => {
  if (hasOwn(PLUGIN_PREFERENCES, key)) {
    return key;
  }
  return hasOwn(PLUGIN_POLICY_ALIASES, key) ? PLUGIN_POLICY_ALIASES[key] : undefined;
};

const expandPluginPolicyKeys = keys => {
  const expanded = new Set(keys || []);
  for (const [alias, canonical] of Object.entries(PLUGIN_POLICY_ALIASES)) {
    if (expanded.has(alias) || expanded.has(canonical)) {
      expanded.add(alias);
      expanded.add(canonical);
    }
  }
  return [...expanded];
};

export {
  canonicalPluginPreferenceKey,
  expandPluginPolicyKeys,
  PLUGIN_IDS,
  PLUGIN_KEYS,
  PLUGIN_POLICY_ALIASES,
  PLUGIN_POLICY_KEYS,
  PLUGIN_PREFERENCES
};
