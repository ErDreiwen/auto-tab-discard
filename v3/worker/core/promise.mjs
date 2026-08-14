const withTimeout = (promise, timeout, fallback) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(fallback), timeout);

  Promise.resolve(promise).then(value => {
    clearTimeout(timer);
    resolve(value);
  }, () => {
    clearTimeout(timer);
    resolve(fallback);
  });
});

export {withTimeout};
