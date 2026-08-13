import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v3/data/inject/watch.js', import.meta.url), 'utf8');
const nextTask = () => new Promise(resolve => setTimeout(resolve, 5));

const createHarness = () => {
  const listeners = new Map();
  const extensionWindow = {};
  const document = {
    querySelectorAll() {
      return [];
    }
  };
  const addEventListener = (type, listener) => {
    const entries = listeners.get(type) || [];
    entries.push(listener);
    listeners.set(type, entries);
  };
  const context = vm.createContext({
    addEventListener,
    clearTimeout,
    console,
    Date,
    document,
    setTimeout,
    window: extensionWindow
  });

  vm.runInContext(source, context, {filename: 'watch.js'});

  const dispatch = (type, target, options = {}) => {
    const event = {
      type,
      target,
      defaultPrevented: false,
      isTrusted: options.isTrusted === true,
      keyCode: options.keyCode || 0,
      which: options.which || 0,
      composedPath: () => options.path || [target],
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
    for (const listener of listeners.get(type) || []) {
      listener(event);
    }
    return event;
  };

  return {
    dispatch,
    document,
    on: addEventListener,
    receiving: () => extensionWindow.isReceivingFormInput,
    window: extensionWindow
  };
};

const createForm = () => ({
  tagName: 'FORM',
  elements: [],
  contains(element) {
    for (let node = element; node; node = node.parentElement) {
      if (node === this) {
        return true;
      }
    }
    return false;
  }
});

const createControl = ({
  tagName = 'INPUT',
  type = 'text',
  value = '',
  defaultValue = value,
  checked = false,
  defaultChecked = checked,
  form,
  name = ''
} = {}) => {
  const control = {
    tagName,
    type,
    value,
    defaultValue,
    checked,
    defaultChecked,
    form,
    name,
    isConnected: true,
    parentElement: form || null,
    getAttribute() {
      return null;
    }
  };
  form?.elements.push(control);
  return control;
};

const createSelect = ({selected = [true, false], form} = {}) => {
  const select = createControl({tagName: 'SELECT', form});
  select.options = selected.map(value => ({
    selected: value,
    defaultSelected: value
  }));
  return select;
};

const createEditable = ({html = '', form} = {}) => ({
  tagName: 'DIV',
  innerHTML: html,
  textContent: html,
  isContentEditable: true,
  isConnected: true,
  parentElement: form || null,
  getAttribute(name) {
    return name === 'contenteditable' ? 'true' : null;
  }
});

test('text input becomes dirty and an exact reversion becomes clean', () => {
  const harness = createHarness();
  const input = createControl({value: 'original'});

  assert.equal(harness.receiving(), false);
  harness.dispatch('focusin', input);
  harness.dispatch('beforeinput', input);
  input.value = 'changed';
  harness.dispatch('input', input);
  assert.equal(harness.receiving(), true);

  harness.dispatch('beforeinput', input);
  input.value = 'original';
  harness.dispatch('input', input);
  assert.equal(harness.receiving(), false);
});

test('input without a pre-edit event uses the native default as its baseline', () => {
  const harness = createHarness();
  const input = createControl({value: 'saved', defaultValue: 'saved'});

  input.value = 'autofilled';
  harness.dispatch('input', input);
  assert.equal(harness.receiving(), true);

  input.value = 'saved';
  assert.equal(harness.receiving(), false);
});

test('prevented beforeinput and non-data buttons do not create false dirtiness', () => {
  const harness = createHarness();
  const textarea = createControl({tagName: 'TEXTAREA', value: 'saved'});
  const button = createControl({type: 'button', value: 'Do something'});

  harness.on('beforeinput', event => event.preventDefault());
  harness.dispatch('beforeinput', textarea);
  assert.equal(harness.receiving(), false);

  textarea.value = 'changed';
  harness.dispatch('input', textarea);
  assert.equal(harness.receiving(), true);
  textarea.value = 'saved';
  harness.dispatch('input', textarea);
  assert.equal(harness.receiving(), false);

  harness.dispatch('input', button);
  harness.dispatch('change', button);
  assert.equal(harness.receiving(), false);
});

test('checkbox, select, and radio-group reversions are recognized', () => {
  const harness = createHarness();
  const form = createForm();
  const checkbox = createControl({type: 'checkbox', form});
  const select = createSelect({form});
  const first = createControl({type: 'radio', name: 'choice', checked: true, form});
  const second = createControl({type: 'radio', name: 'choice', checked: false, form});

  harness.dispatch('pointerdown', checkbox);
  checkbox.checked = true;
  harness.dispatch('change', checkbox);
  assert.equal(harness.receiving(), true);
  checkbox.checked = false;
  harness.dispatch('change', checkbox);
  assert.equal(harness.receiving(), false);

  harness.dispatch('focusin', select);
  select.options[0].selected = false;
  select.options[1].selected = true;
  harness.dispatch('change', select);
  assert.equal(harness.receiving(), true);
  select.options[0].selected = true;
  select.options[1].selected = false;
  harness.dispatch('change', select);
  assert.equal(harness.receiving(), false);

  harness.dispatch('focusin', second);
  first.checked = false;
  second.checked = true;
  harness.dispatch('change', second);
  assert.equal(harness.receiving(), true);
  first.checked = true;
  second.checked = false;
  harness.dispatch('change', first);
  assert.equal(harness.receiving(), false);
});

test('contenteditable paste and undo compare rich content to its baseline', () => {
  const harness = createHarness();
  const editor = createEditable({html: '<b>draft</b>'});

  harness.dispatch('paste', editor);
  editor.innerHTML = '<b>draft plus</b>';
  harness.dispatch('input', editor);
  assert.equal(harness.receiving(), true);

  harness.dispatch('beforeinput', editor);
  editor.innerHTML = '<b>draft</b>';
  harness.dispatch('input', editor);
  assert.equal(harness.receiving(), false);
});

test('a first post-change contenteditable event is conservatively dirty', () => {
  const harness = createHarness();
  const editor = createEditable({html: 'already changed'});

  harness.dispatch('input', editor);
  assert.equal(harness.receiving(), true);
});

test('a canceled trusted submit retains dirty state', async () => {
  const harness = createHarness();
  const form = createForm();
  const input = createControl({value: 'saved', form});

  harness.dispatch('focusin', input);
  input.value = 'unsaved';
  harness.dispatch('input', input);
  harness.on('submit', event => event.preventDefault());
  harness.dispatch('submit', form, {isTrusted: true});
  await nextTask();

  assert.equal(harness.receiving(), true);
});

test('a trusted native submit clears only controls belonging to that form', async () => {
  const harness = createHarness();
  const submitted = createForm();
  const other = createForm();
  const first = createControl({value: 'one', form: submitted});
  const second = createControl({value: 'two', form: other});

  harness.dispatch('focusin', first);
  first.value = 'changed one';
  harness.dispatch('input', first);
  harness.dispatch('focusin', second);
  second.value = 'changed two';
  harness.dispatch('input', second);
  harness.dispatch('submit', submitted, {isTrusted: true});
  await nextTask();
  assert.equal(harness.receiving(), true);

  second.value = 'two';
  harness.dispatch('input', second);
  assert.equal(harness.receiving(), false);
});

test('an untrusted synthetic submit never clears unsaved form state', async () => {
  const harness = createHarness();
  const form = createForm();
  const input = createControl({value: 'saved', form});

  harness.dispatch('focusin', input);
  input.value = 'unsaved';
  harness.dispatch('input', input);
  const event = harness.dispatch('submit', form);
  await nextTask();

  assert.equal(event.isTrusted, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.receiving(), true);
});

test('reset clears native controls only when the reset is not canceled', async () => {
  const canceledHarness = createHarness();
  const canceledForm = createForm();
  const canceledInput = createControl({value: 'saved', form: canceledForm});
  canceledHarness.dispatch('focusin', canceledInput);
  canceledInput.value = 'unsaved';
  canceledHarness.dispatch('input', canceledInput);
  canceledHarness.on('reset', event => event.preventDefault());
  canceledHarness.dispatch('reset', canceledForm);
  await nextTask();
  assert.equal(canceledHarness.receiving(), true);

  const resetHarness = createHarness();
  const resetForm = createForm();
  const resetInput = createControl({value: 'saved', form: resetForm});
  resetHarness.dispatch('focusin', resetInput);
  resetInput.value = 'unsaved';
  resetHarness.dispatch('input', resetInput);
  resetHarness.dispatch('reset', resetForm);
  resetInput.value = resetInput.defaultValue;
  await nextTask();
  assert.equal(resetHarness.receiving(), false);
});

test('native form reset does not falsely clear contenteditable changes', async () => {
  const harness = createHarness();
  const form = createForm();
  const editor = createEditable({html: 'saved', form});

  harness.dispatch('beforeinput', editor);
  editor.innerHTML = 'unsaved';
  harness.dispatch('input', editor);
  harness.dispatch('reset', form);
  await nextTask();

  assert.equal(harness.receiving(), true);
});

test('composed paths expose controls inside a custom-element boundary', () => {
  const harness = createHarness();
  const input = createControl({value: 'saved'});
  const customElement = {tagName: 'CUSTOM-EDITOR'};

  harness.dispatch('beforeinput', customElement, {path: [input, customElement]});
  input.value = 'changed';
  harness.dispatch('input', customElement, {path: [input, customElement]});

  assert.equal(harness.receiving(), true);
});

test('disconnected controls are pruned and PDF editor input stays protected', () => {
  const harness = createHarness();
  const input = createControl({value: 'saved'});

  harness.dispatch('focusin', input);
  input.value = 'changed';
  harness.dispatch('input', input);
  input.isConnected = false;
  assert.equal(harness.receiving(), false);

  const pdf = {type: 'application/pdf'};
  harness.dispatch('keydown', pdf, {keyCode: 65});
  assert.equal(harness.receiving(), true);
});
