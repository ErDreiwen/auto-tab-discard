const createPluginPreferenceGate = plugins => {
  const entries = new Map(Object.entries(plugins || {}));
  const revisions = new Map([...entries.keys()].map(key => [key, 0]));

  const snapshot = () => new Map(revisions);
  const applyChange = (key, enabled) => {
    const plugin = entries.get(key);
    if (!plugin) {
      return false;
    }
    revisions.set(key, (revisions.get(key) || 0) + 1);
    plugin[enabled === true ? 'enable' : 'disable']();
    return true;
  };
  const applyStartup = (baseline, preferences) => {
    for (const [key, plugin] of entries) {
      // storage.get() is asynchronous. A storage.onChanged event can apply a
      // newer value while that original read is pending; never let its stale
      // snapshot re-enable a plugin that the user just disabled.
      if (baseline?.get(key) === revisions.get(key) && preferences?.[key] === true) {
        plugin.enable();
      }
    }
  };

  return Object.freeze({applyChange, applyStartup, snapshot});
};

export {createPluginPreferenceGate};
