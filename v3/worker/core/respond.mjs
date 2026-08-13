const respondAsync = (task, sendResponse) => {
  const send = payload => {
    try {
      sendResponse(payload);
    }
    catch (e) {}
  };

  Promise.resolve().then(task).then(value => send({
    ok: true,
    value
  }), error => send({
    ok: false,
    error: error && error.message ? error.message : String(error)
  }));

  // Keep the runtime message channel (and MV3 worker) alive until task settles.
  return true;
};

const dispatchPopup = async (request, query, onClicked) => {
  const pinnedWindow = Number.isInteger(request?.windowId);
  const tabs = await query(pinnedWindow ? {
    active: true,
    windowId: request.windowId
  } : {
    active: true,
    currentWindow: true
  });
  if (tabs.length === 0) {
    throw Error('No active tab is available');
  }
  if (Number.isInteger(request?.tabId) && tabs[0].id !== request.tabId) {
    throw Error('The popup target changed before the command could run');
  }
  const value = await onClicked({
    menuItemId: request.cmd,
    value: request.value,
    checked: request.checked,
    shiftKey: request.shiftKey,
    progress: request.progress
  }, tabs[0]);

  return value === undefined ? true : value;
};

export {dispatchPopup, respondAsync};
