'use strict';

/*
 * Windows can hand the harness an inherited __COMPAT_LAYER (for example
 * DetectorsAppHealth). Edge 155 then relaunches itself without it under a new
 * process and the spawned process exits 0 before DevTools is ready, leaving the
 * relaunched browser outside harness ownership with its profile locked. Browsers
 * are launched without the variable so the spawned process is the browser.
 */
const browserEnvironment = (baseEnvironment = process.env) => {
  const environment = {...baseEnvironment};
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === '__COMPAT_LAYER') {
      delete environment[name];
    }
  }
  return environment;
};

module.exports = {browserEnvironment};
