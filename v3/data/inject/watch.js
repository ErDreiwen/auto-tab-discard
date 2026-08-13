/* this watches if there are any unsaved forms on the page */

(() => {
// The manifest installs this only in the top frame. The worker can also inject
// it into a bounded set of relevant subframes when form protection is enabled.
// Repeated metadata scans must never multiply listeners in the same document.
if (window.__autoTabDiscardWatchInstalled === true) {
  return;
}
Object.defineProperty(window, '__autoTabDiscardWatchInstalled', {
  value: true
});

// A value is dirty when it differs from the value that was present immediately
// before the user started editing it. Keeping the baseline also lets undo, a
// checkbox toggle-back, and other real reversions make the page clean again.
const baselines = new Map();
let pdfInput = false;

const tagName = element => String(element?.tagName || '').toUpperCase();
const inputType = element => String(element?.type || 'text').toLowerCase();
const ignoredInputTypes = new Set([
  'button',
  'hidden',
  'image',
  'reset',
  'submit'
]);

const isFormControl = element => {
  const tag = tagName(element);

  return tag === 'TEXTAREA' || tag === 'SELECT' ||
    (tag === 'INPUT' && ignoredInputTypes.has(inputType(element)) === false);
};

const isExplicitEditable = element => {
  if (typeof element?.getAttribute !== 'function') {
    return false;
  }
  const value = element.getAttribute('contenteditable');

  return value !== null && String(value).toLowerCase() !== 'false';
};

const eventPath = event => {
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : event.path;
    if (path?.length) {
      return path;
    }
  }
  catch (e) {}

  return event.target ? [event.target] : [];
};

const editableFrom = event => {
  const path = eventPath(event);
  const control = path.find(isFormControl);
  if (control) {
    return control;
  }

  // Prefer the explicit contenteditable host over an editable descendant. The
  // descendant can be replaced while typing, which would otherwise lose state.
  const host = path.find(isExplicitEditable);
  if (host && host.isContentEditable !== false) {
    return host;
  }

  return path.find(element => element?.isContentEditable === true);
};

const snapshot = (element, defaults = false) => {
  const tag = tagName(element);
  const type = inputType(element);

  if (tag === 'SELECT') {
    return JSON.stringify([...element.options].map(option =>
      Boolean(defaults ? option.defaultSelected : option.selected)
    ));
  }
  if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
    return String(Boolean(defaults ? element.defaultChecked : element.checked));
  }
  if (isFormControl(element)) {
    const property = defaults ? 'defaultValue' : 'value';
    return String(element[property] ?? '');
  }

  // innerHTML includes formatting-only changes in rich text editors.
  return String(element.innerHTML ?? element.textContent ?? '');
};

const radioGroup = radio => {
  if (tagName(radio) !== 'INPUT' || inputType(radio) !== 'radio') {
    return [radio];
  }

  let candidates;
  try {
    candidates = radio.form?.elements || document.querySelectorAll('input[type="radio"]');
  }
  catch (e) {
    return [radio];
  }

  return [...candidates].filter(candidate =>
    tagName(candidate) === 'INPUT' && inputType(candidate) === 'radio' &&
    candidate.form === radio.form && candidate.name === radio.name
  );
};

const rememberCurrent = element => {
  for (const candidate of radioGroup(element)) {
    if (!baselines.has(candidate)) {
      baselines.set(candidate, {
        value: snapshot(candidate),
        certain: true
      });
    }
  }
};

const rememberAfterChange = element => {
  if (baselines.has(element)) {
    return;
  }

  if (isFormControl(element)) {
    // input/change can be dispatched without a preceding focus or beforeinput.
    // Native default state is the best available baseline in that case.
    baselines.set(element, {
      value: snapshot(element, true),
      certain: true
    });
  }
  else {
    // There is no defaultValue equivalent for contenteditable. A first observed
    // post-change event is therefore dirty until submit/reset/reload.
    baselines.set(element, {
      value: snapshot(element),
      certain: false
    });
  }
};

const isDirty = () => {
  for (const [element, baseline] of baselines) {
    if (element.isConnected === false) {
      baselines.delete(element);
    }
    else if (baseline.certain === false || snapshot(element) !== baseline.value) {
      return true;
    }
  }

  return pdfInput;
};

// A dynamically injected watcher cannot reconstruct the pristine baseline of
// an existing rich-text or PDF editor. Keep that frame protected instead of
// treating unknown pre-injection edits as clean. The normal manifest injection
// runs at document_start (`loading`) and therefore avoids this conservative
// bootstrap path.
if (document.readyState !== 'loading') {
  try {
    for (const element of document.querySelectorAll('[contenteditable],object[type="application/pdf"]')) {
      if (String(element?.tagName || '').toUpperCase() === 'OBJECT') {
        pdfInput = true;
      }
      else if (element.isContentEditable !== false) {
        baselines.set(element, {
          value: snapshot(element),
          certain: false
        });
      }
    }
  }
  catch (e) {
    // The bounded worker probe remains fail-closed when a frame churns here.
  }
}

Object.defineProperty(window, 'isReceivingFormInput', {
  get: isDirty
});

// These events occur before mutation and give us an exact initial value.
for (const type of ['beforeinput', 'paste', 'focusin', 'pointerdown']) {
  addEventListener(type, event => {
    const element = editableFrom(event);
    if (element) {
      rememberCurrent(element);
    }
  }, true);
}

// input covers text entry, paste/drop, autofill, undo, and contenteditable.
// change covers controls whose state is committed rather than typed.
for (const type of ['input', 'change']) {
  addEventListener(type, event => {
    const element = editableFrom(event);
    if (element) {
      rememberAfterChange(element);
    }
  }, true);
}

// Preserve the old PDF-editor guard, and capture a baseline in browsers that do
// not emit beforeinput for a particular native/editor control.
addEventListener('keydown', event => {
  const element = editableFrom(event);
  if (element) {
    rememberCurrent(element);
  }

  const first = eventPath(event)[0] || event.target;
  const keyCode = event.keyCode || event.which || 0;
  if (first?.type === 'application/pdf' && keyCode >= 48 && keyCode <= 90) {
    pdfInput = true;
  }
}, true);

const belongsToForm = (element, form) => {
  if (element.form === form) {
    return true;
  }
  try {
    return form.contains(element);
  }
  catch (e) {
    return false;
  }
};

const clearSubmittedForm = form => {
  for (const element of baselines.keys()) {
    if (belongsToForm(element, form)) {
      baselines.delete(element);
    }
  }
};

// Check defaultPrevented after every submit listener has run. In particular, an
// AJAX/validation handler that cancels submission must leave the form protected.
// A page can dispatch an untrusted `submit` event without performing any native
// submission or navigation. Such a signal is not evidence that the user's data
// was saved, so it must never clear the dirty baseline. A trusted, unprevented
// submit is the browser's lifecycle confirmation that native submission began.
addEventListener('submit', event => {
  const form = event.target;
  setTimeout(() => {
    if (event.isTrusted === true && event.defaultPrevented === false) {
      clearSubmittedForm(form);
    }
  }, 0);
});

// A successful native reset establishes a new clean baseline for its controls.
// Contenteditable descendants are intentionally retained: form.reset() does not
// reset them. A canceled reset retains all dirty state.
addEventListener('reset', event => {
  const form = event.target;
  setTimeout(() => {
    if (event.defaultPrevented === false) {
      for (const element of baselines.keys()) {
        if (element.form === form) {
          baselines.delete(element);
        }
      }
    }
  }, 0);
});

addEventListener('visibilitychange', () => {
  window.lastVisit = Date.now();
});
})();
