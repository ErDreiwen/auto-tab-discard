const KEY = '__discardActivationPulse';
const VERSION = 1;
const DEFAULT_TTL = 30_000;

const callArea = (area, method, value) => new Promise((resolve, reject) => {
  try {
    area[method](value, result => {
      const error = globalThis.chrome?.runtime?.lastError;
      error ? reject(Error(error.message || String(error))) : resolve(result);
    });
  }
  catch (error) {
    reject(error);
  }
});

const validRecord = value => Boolean(value && value.version === VERSION &&
  ['activating-target', 'restoring-keeper'].includes(value.phase) &&
  Number.isInteger(value.targetId) && Number.isInteger(value.keeperId) &&
  Number.isInteger(value.windowId) && Number.isFinite(value.expiresAt));

const createPulseRecovery = ({
  area,
  now = Date.now,
  resolveId = id => id,
  tabs,
  ttl = DEFAULT_TTL
}) => {
  const read = async () => {
    const stored = await callArea(area, 'get', {[KEY]: null});
    const record = stored?.[KEY];
    if (record === null || record === undefined) {
      return undefined;
    }
    if (!validRecord(record)) {
      await callArea(area, 'remove', KEY);
      return undefined;
    }
    return record;
  };
  const write = record => callArea(area, 'set', {[KEY]: record}).then(() => record);
  const clear = () => callArea(area, 'remove', KEY).then(() => true);
  const arm = ({keeperId, phase = 'activating-target', targetId, windowId}) => write({
    expiresAt: now() + ttl,
    keeperId,
    phase,
    targetId,
    version: VERSION,
    windowId
  });
  const phase = async (expectedTargetId, nextPhase) => {
    const current = await read();
    if (!current || resolveId(current.targetId) !== resolveId(expectedTargetId)) {
      throw Error('activation pulse recovery record changed before phase update');
    }
    return write({...current, phase: nextPhase});
  };
  const activeTab = windowId => new Promise(resolve => tabs.query({
    active: true,
    windowId
  }, found => resolve(globalThis.chrome?.runtime?.lastError ? undefined : found?.[0])));

  // Startup recovery is deliberately observation-only. A restarted MV3 worker
  // cannot atomically prove that the user stays outside this window between a
  // focus read and tabs.update(), so it never activates the saved keeper. It
  // preserves the browser's live selection, clears a settled record, and lets
  // the caller invalidate takeover ownership without crossing the native-
  // discard boundary.
  const recover = async () => {
    const record = await read();
    if (!record) {
      return {status: 'empty'};
    }
    const targetId = resolveId(record.targetId);
    const keeperId = resolveId(record.keeperId);
    const active = await activeTab(record.windowId);
    if (!active) {
      if (record.expiresAt <= now()) {
        await clear();
        return {record, status: 'expired-unsafe', targetId};
      }
      return {record, status: 'deferred', targetId};
    }
    if (resolveId(active.id) === keeperId) {
      await clear();
      return {record, status: 'keeper-active', targetId};
    }
    if (resolveId(active.id) !== targetId) {
      await clear();
      return {record, status: 'user-intervened', targetId};
    }
    await clear();
    return {record, status: 'target-preserved', targetId};
  };

  return {arm, clear, phase, read, recover};
};

export {createPulseRecovery, DEFAULT_TTL, KEY, VERSION};
