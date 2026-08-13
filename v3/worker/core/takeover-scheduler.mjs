const normalizeResourceLimits = values => Object.freeze(Object.fromEntries(
  Object.entries(values || {}).map(([name, limit]) => {
    if (!name || !Number.isFinite(Number(limit)) || Number(limit) < 1) {
      throw new TypeError(`invalid takeover scheduler resource limit: ${name}`);
    }
    return [name, Math.max(1, Math.floor(Number(limit)))];
  })
));

const normalizeResources = (values, resourceLimits) => Object.freeze(
  [...new Set(values || [])].map(name => {
    if (!Object.hasOwn(resourceLimits, name)) {
      throw new TypeError(`unknown takeover scheduler resource: ${name}`);
    }
    return name;
  })
);

const normalizePriority = value => Number.isFinite(Number(value)) ? Number(value) : 0;

const createTakeoverScheduler = ({concurrency = 4, resourceLimits: limits} = {}) => {
  const maximum = Math.max(1, Math.floor(Number(concurrency) || 1));
  const resourceLimits = normalizeResourceLimits(limits);
  const queue = [];
  const activeKeys = new Set();
  const activeResources = new Map(Object.keys(resourceLimits).map(name => [name, 0]));
  let active = 0;
  let sequence = 0;

  const snapshot = () => ({
    active,
    activeKeys: activeKeys.size,
    concurrency: maximum,
    queued: queue.length,
    ...(activeResources.size && {
      resources: Object.fromEntries([...activeResources].map(([name, count]) => [name, {
        active: count,
        limit: resourceLimits[name]
      }]))
    })
  });

  const resourcesAvailable = item => item.resources.every(name =>
    activeResources.get(name) < resourceLimits[name]
  );

  const pump = () => {
    while (active < maximum) {
      // A saturated resource or focus domain must not block unrelated work
      // later in the queue. The global bound is retained as a final ceiling,
      // while each declared resource has its own independently enforced cap.
      let index = -1;
      for (let candidate = 0; candidate < queue.length; candidate += 1) {
        const item = queue[candidate];
        if ((item.key === undefined || !activeKeys.has(item.key)) && resourcesAvailable(item) &&
            (index === -1 || item.priority > queue[index].priority)) {
          index = candidate;
        }
      }
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
      for (const name of item.resources) {
        activeResources.set(name, activeResources.get(name) + 1);
      }
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        active -= 1;
        if (item.key !== undefined) {
          activeKeys.delete(item.key);
        }
        for (const name of item.resources) {
          activeResources.set(name, activeResources.get(name) - 1);
        }
        pump();
      });
    }
  };

  const schedule = (task, {key, priority = 0, resources} = {}) => {
    const item = {
      cancelled: false,
      id: ++sequence,
      key,
      priority: normalizePriority(priority),
      resources: normalizeResources(resources, resourceLimits),
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
