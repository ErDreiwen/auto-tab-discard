const createInterruptRegistry = defaults => {
  const baseline = Object.freeze({...defaults});
  const interrupts = {...baseline};

  const overwrite = (name, callback) => {
    if (!(name in baseline) || typeof callback !== 'function') {
      throw Error(`unknown or invalid plugin interrupt: ${name}`);
    }
    interrupts[name] = callback;
  };
  const release = name => {
    if (!(name in baseline)) {
      return false;
    }
    interrupts[name] = baseline[name];
    return true;
  };

  return Object.freeze({interrupts, overwrite, release});
};

export {createInterruptRegistry};
