// Edge does not currently expose this capability. Keeping its invocation in a
// tiny exactly-once adapter means a future tabs.unfreeze API is preferred
// automatically without changing the activation-pulse safety boundary.
const invokeOptionalUnfreeze = ({id, runtime, tabs}) => {
  if (!Number.isInteger(id) || typeof tabs?.unfreeze !== 'function') {
    return Promise.resolve({supported: false});
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (!settled) {
        settled = true;
        resolve({supported: true, ...value});
      }
    };
    const callback = tab => {
      const error = runtime?.lastError;
      finish(error ? {accepted: false, error: error.message || String(error)} : {
        accepted: true,
        apiStyle: 'callback',
        tab
      });
    };
    try {
      const operation = tabs.unfreeze(id, callback);
      if (operation?.then) {
        operation.then(tab => finish({accepted: true, apiStyle: 'promise', tab}), error =>
          finish({accepted: false, apiStyle: 'promise', error: error?.message || String(error)}));
      }
    }
    catch (error) {
      finish({accepted: false, error: error?.message || String(error)});
    }
  });
};

export {invokeOptionalUnfreeze};
