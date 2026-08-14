{
  const top = window.top === window;
  // https://github.com/rNeomy/auto-tab-discard/issues/315
  const paused = [...document.querySelectorAll('video,audio')].some(e => {
    return e.paused && e.currentTime;
  });

  (top ? {
    'time': window.lastVisit || performance.timing.domLoading,
    'audible': Boolean(document.pictureInPictureElement),
    paused,
    'permission': typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false,
    'ready': document.readyState === 'complete' || document.readyState === 'loaded',
    // A boolean is enough to decide whether bounded subframe inspection is
    // needed. Frame identities and URLs never leave the browser-owned APIs.
    'subframes': (() => {
      try {
        return window.frames.length > 0;
      }
      catch (e) {
        return true;
      }
    })(),
    'memory': performance && performance.memory ? performance.memory.totalJSHeapSize : false,
    'forms': window.isReceivingFormInput || false
  } : {
    'audible': Boolean(document.pictureInPictureElement),
    paused,
    'forms': window.isReceivingFormInput || false
  // eslint-disable-next-line semi
  })
}
