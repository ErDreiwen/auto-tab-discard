const createTakeoverScheduler = ({concurrency = 4} = {}) => {
  const maximum = Math.max(1, Math.floor(Number(concurrency) || 1));
  const queue = [];
  const activeKeys = new Set();
  let active = 0;
  let sequence = 0;

  const snapshot = () => ({
    active,
    activeKeys: activeKeys.size,
    concurrency: maximum,
    queued: queue.length
  });

  const pump = () => {
    while (active < maximum) {
      const index = queue.findIndex(item => item.key === undefined || !activeKeys.has(item.key));
      if (index === -1) {
        return;
      }
      const [item] = queue.splice(index, 1);
      if (item.cancelled) {
        item.reject(Error(item.cancelReason || 'scheduled takeover cancelled'));
        continue;
      }
      item.started = true;
      active += 1;
      if (item.key !== undefined) {
        activeKeys.add(item.key);
      }
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        active -= 1;
        if (item.key !== undefined) {
          activeKeys.delete(item.key);
        }
        pump();
      });
    }
  };

  const schedule = (task, {key} = {}) => {
    const item = {
      cancelled: false,
      id: ++sequence,
      key,
      started: false,
      task
    };
    const promise = new Promise((resolve, reject) => Object.assign(item, {reject, resolve}));
    queue.push(item);
    pump();
    return {
      cancel(reason) {
        if (item.started || item.cancelled) {
          return false;
        }
        item.cancelled = true;
        item.cancelReason = reason;
        const index = queue.indexOf(item);
        if (index !== -1) {
          queue.splice(index, 1);
        }
        item.reject(Error(reason || 'scheduled takeover cancelled'));
        pump();
        return true;
      },
      get started() {
        return item.started;
      },
      promise,
      rekey(key) {
        if (item.started || item.cancelled) {
          return false;
        }
        item.key = key;
        pump();
        return true;
      }
    };
  };

  return {schedule, snapshot};
};

export {createTakeoverScheduler};
