const restoreModeControl = (urlBasedControl, mode) => {
  if (!urlBasedControl) {
    return false;
  }
  urlBasedControl.checked = mode === 'url-based';
  return true;
};

export {restoreModeControl};
