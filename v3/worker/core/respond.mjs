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
  const tabs = await query({
    active: true,
    currentWindow: true
  });
  if (tabs.length === 0) {
    throw Error('No active tab is available');
  }
  await onClicked({
    menuItemId: request.cmd,
    value: request.value,
    checked: request.checked,
    shiftKey: request.shiftKey
  }, tabs[0]);

  return true;
};

export {dispatchPopup, respondAsync};
