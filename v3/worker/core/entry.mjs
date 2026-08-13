const MAX_REASONS = 5;
const NO_SAFE_KEEPER_CODE = 'TAB_NO_SAFE_KEEPER';
const conciseReasons = value => {
  const result = value?.result || value;
  const reasons = [];
  if (result?.blocked === true) {
    reasons.push('command was blocked because no safe keeper was available');
  }
  for (const key of ['failed', 'unsupported', 'unknownOwnership']) {
    for (const entry of result?.[key] || []) {
      const id = entry?.tab?.id ?? entry?.id;
      const reason = entry?.reason || entry?.error?.message || entry?.error || `${key} target`;
      reasons.push(`${Number.isInteger(id) ? `tab ${id}: ` : ''}${String(reason).slice(0, 180)}`);
    }
  }
  return [...new Set(reasons)].slice(0, MAX_REASONS);
};

const successCount = result => (result?.succeeded?.length || 0) +
  (result?.released?.length || 0) + (result?.physicalOnly?.length || 0);

const runEntryCommand = async (command, task, report) => {
  try {
    const value = await task();
    const reasons = conciseReasons(value);
    if (reasons.length) {
      try {
        await report({command, message: reasons.join('; '), reasons});
      }
      catch (reportError) {}
    }
    if (value?.blocked === true && successCount(value) === 0) {
      return {
        code: NO_SAFE_KEEPER_CODE,
        error: reasons[0] || 'command was blocked',
        ok: false,
        value
      };
    }
    return {
      ...(value?.blocked === true && {code: NO_SAFE_KEEPER_CODE}),
      ok: true,
      ...(reasons.length && {partial: true, reasons}),
      value
    };
  }
  catch (error) {
    const reasons = conciseReasons(error);
    const message = reasons.length ? reasons.join('; ') : error?.message || String(error);
    try {
      await report({command, message});
    }
    catch (reportError) {}
    return {
      error: message,
      ok: false,
      ...(reasons.length && {reasons})
    };
  }
};

export {conciseReasons, runEntryCommand};
