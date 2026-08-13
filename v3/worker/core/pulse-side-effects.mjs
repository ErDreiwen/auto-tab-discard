// Serialized into the page by scripting.executeScript; keep self-contained.
const inspectDocumentPulseState = () => {
  const media = [...document.querySelectorAll('audio, video')];
  const playing = media.filter(element => element.paused === false && element.ended !== true);
  let instrumentation;
  try {
    const raw = JSON.parse(document.documentElement?.dataset?.autoTabDiscardPulseEvidence || 'null');
    if (raw && typeof raw === 'object') {
      const count = value => Number.isInteger(value) ? Math.max(0, Math.min(value, 1000)) : 0;
      instrumentation = {
        blurEvents: count(raw.blurEvents),
        focusEvents: count(raw.focusEvents),
        mediaEvents: count(raw.mediaEvents),
        pictureInPictureEvents: count(raw.pictureInPictureEvents),
        visibilityTransitions: Array.isArray(raw.visibilityTransitions) ? raw.visibilityTransitions
          .filter(value => value === 'hidden' || value === 'visible')
          .slice(-8) : []
      };
    }
  }
  catch (error) {
    // Instrumentation is optional test evidence; malformed page data cannot
    // weaken the authoritative live media/focus checks below.
  }
  return {
    focused: document.hasFocus() === true,
    mediaActive: playing.length > 0,
    mutedMediaActive: playing.some(element => element.muted === true || element.volume === 0),
    pictureInPicture: Boolean(document.pictureInPictureElement),
    ...(instrumentation && {instrumentation}),
    visibility: document.visibilityState
  };
};

const normalizePulseState = value => ({
  focused: value?.focused === true,
  mediaActive: value?.mediaActive === true,
  mutedMediaActive: value?.mutedMediaActive === true,
  pictureInPicture: value?.pictureInPicture === true,
  ...(value?.instrumentation && {instrumentation: {
    blurEvents: Number(value.instrumentation.blurEvents) || 0,
    focusEvents: Number(value.instrumentation.focusEvents) || 0,
    mediaEvents: Number(value.instrumentation.mediaEvents) || 0,
    pictureInPictureEvents: Number(value.instrumentation.pictureInPictureEvents) || 0,
    visibilityTransitions: Array.isArray(value.instrumentation.visibilityTransitions) ?
      value.instrumentation.visibilityTransitions.slice(-8) : []
  }}),
  visibility: typeof value?.visibility === 'string' ? value.visibility : 'unknown'
});

export {inspectDocumentPulseState, normalizePulseState};
