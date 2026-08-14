const isFirefoxRuntime = () => typeof navigator !== 'undefined' &&
  /Firefox\//.test(navigator.userAgent || '');

const nativeDiscardContract = ({firefox = isFirefoxRuntime()} = {}) => firefox ?
  Object.freeze({apiStyle: 'promise', family: 'firefox', invariant: 'discarded-inactive-complete-v1'}) :
  Object.freeze({apiStyle: 'callback', family: 'chromium', invariant: 'discarded-inactive-unloaded-v1'});

const resultShape = result => {
  if (result === undefined) {
    return 'undefined';
  }
  if (result && typeof result === 'object') {
    return Number.isInteger(result.id) ? 'tab' : 'partial-object';
  }
  return typeof result;
};

// Invoke exactly once. Firefox deliberately exposes a Promise-only method with
// no result, while Chromium's callback contract may return a full, partial, or
// missing Tab as browser versions evolve. The returned snapshot is provenance,
// never proof; callers must still establish the versioned live postcondition.
const invokeNativeDiscard = (id, {
  firefox = isFirefoxRuntime(),
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs
} = {}) => {
  const contract = nativeDiscardContract({firefox});
  return new Promise(resolve => {
    let settled = false;
    const finish = (result, error) => {
      if (settled) {
        return;
      }
      settled = true;
      const lastError = runtime?.lastError;
      if (error || lastError) {
        resolve({
          accepted: false,
          apiStyle: contract.apiStyle,
          contract: contract.invariant,
          error: error?.message || String(error || lastError?.message || lastError),
          family: contract.family
        });
      }
      else {
        resolve({
          accepted: true,
          apiStyle: contract.apiStyle,
          contract: contract.invariant,
          family: contract.family,
          result,
          resultShape: resultShape(result)
        });
      }
    };

    try {
      if (!tabs?.discard) {
        finish(undefined, Error('tabs.discard is unavailable'));
        return;
      }
      if (contract.apiStyle === 'promise') {
        const operation = tabs.discard(id);
        if (!operation?.then) {
          finish(undefined, Error('promise-only tabs.discard returned no Promise'));
          return;
        }
        operation.then(result => finish(result), error => finish(undefined, error));
      }
      else {
        const operation = tabs.discard(id, result => finish(result));
        // Some Chromium-compatible implementations accept the callback but
        // return a Promise instead of invoking it. Settle whichever arrives.
        operation?.then?.(result => finish(result), error => finish(undefined, error));
      }
    }
    catch (error) {
      finish(undefined, error);
    }
  });
};

// Chromium adds the non-standard "unloaded" Tab.status value after discard.
// Firefox's public TabStatus contract contains only "loading" and "complete";
// there, discarded:true is the authoritative proof that content left memory.
const isNativeDiscardSettled = (tab, {firefox = isFirefoxRuntime()} = {}) => Boolean(
  tab && tab.discarded === true && tab.active !== true && (
    tab.status === 'unloaded' || (firefox && tab.status === 'complete')
  )
);

export {invokeNativeDiscard, isFirefoxRuntime, isNativeDiscardSettled, nativeDiscardContract};
