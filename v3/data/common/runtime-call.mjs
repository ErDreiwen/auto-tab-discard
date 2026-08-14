const DEFAULT_RUNTIME_MESSAGE_TIMEOUT = 7000;

const withDeadline = (task, {
  timeoutMessage = 'Operation timed out',
  timeoutMs = DEFAULT_RUNTIME_MESSAGE_TIMEOUT
} = {}) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  const timer = setTimeout(() => finish(Error(timeoutMessage)), Math.max(1,
    Number(timeoutMs) || DEFAULT_RUNTIME_MESSAGE_TIMEOUT));
  Promise.resolve().then(task).then(value => finish(null, value), error => finish(error));
});

const boundedRuntimeMessage = (runtime, request, {
  timeoutMs = DEFAULT_RUNTIME_MESSAGE_TIMEOUT
} = {}) => new Promise(resolve => {
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const failed = error => ({
    error: error?.message || String(error || 'Runtime message failed'),
    ok: false
  });
  const timer = setTimeout(() => finish(failed(Error('Runtime message timed out'))), Math.max(1,
    Number(timeoutMs) || DEFAULT_RUNTIME_MESSAGE_TIMEOUT));
  try {
    const operation = runtime?.sendMessage?.(request, (response, compatibilityError) => {
      const error = runtime?.lastError || compatibilityError;
      finish(error ? failed(error) : response);
    });
    if (operation?.then) {
      operation.then(finish, error => finish(failed(error)));
    }
    if (typeof runtime?.sendMessage !== 'function') {
      finish(failed(Error('Runtime messaging is unavailable')));
    }
  }
  catch (error) {
    finish(failed(error));
  }
});

export {
  boundedRuntimeMessage,
  DEFAULT_RUNTIME_MESSAGE_TIMEOUT,
  withDeadline
};
