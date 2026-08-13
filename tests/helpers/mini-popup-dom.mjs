const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const camel = value => value.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

class MiniClassList {
  constructor(element) {
    this.element = element;
  }
  contains(name) {
    return this.element.classes.has(name);
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) {
      this.element.classes.add(name);
    }
    else {
      this.element.classes.delete(name);
    }
    this.element.attributes.set('class', [...this.element.classes].join(' '));
    return enabled;
  }
}

class MiniEvent {
  constructor(type, init = {}) {
    this.bubbles = init.bubbles !== false;
    this.defaultPrevented = false;
    this.key = init.key;
    this.shiftKey = init.shiftKey === true;
    this.stopped = false;
    this.target = init.target;
    this.type = type;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

const attributeMatch = (element, selector) => {
  const match = selector.match(/^\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/);
  if (!match) {
    return false;
  }
  const [, name, doubleQuoted, singleQuoted, bare] = match;
  if (!element.attributes.has(name)) {
    return false;
  }
  const expected = doubleQuoted ?? singleQuoted ?? bare?.trim();
  return expected === undefined || element.getAttribute(name) === expected;
};

const selectorMatch = (element, selector) => {
  selector = selector.trim();
  if (!selector) {
    return false;
  }
  if (selector.startsWith('#')) {
    return element.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('[')) {
    return attributeMatch(element, selector);
  }
  const tagAndClass = selector.match(/^([a-z0-9-]+)\.([a-z0-9_-]+)$/i);
  if (tagAndClass) {
    return element.localName === tagAndClass[1].toLowerCase() &&
      element.classList.contains(tagAndClass[2]);
  }
  return element.localName === selector.toLowerCase();
};

class MiniElement {
  constructor(localName, attributes, document) {
    this.attributes = new Map();
    this.checked = false;
    this.children = [];
    this.classes = new Set();
    this.classList = new MiniClassList(this);
    this.dataset = {};
    this.disabled = false;
    this.document = document;
    this.hidden = false;
    this.listeners = new Map();
    this.localName = localName.toLowerCase();
    this.max = 1;
    this.parentElement = null;
    this.textMutations = 0;
    this.title = '';
    this.type = '';
    this.value = '';
    this._text = '';
    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  get isConnected() {
    return Boolean(this.parentElement?.isConnected || this.parentElement === this.document);
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
    this.textMutations += 1;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) {
        return current;
      }
      current = current.parentElement instanceof MiniElement ? current.parentElement : null;
    }
    return null;
  }
  click(init = {}) {
    if (this.disabled || hiddenFromLayout(this)) {
      return false;
    }
    if (this.localName === 'input' && this.type === 'checkbox') {
      this.checked = !this.checked;
    }
    const result = this.dispatchEvent(new MiniEvent('click', {...init, target: this}));
    if (this.localName === 'input' && this.type === 'checkbox') {
      this.dispatchEvent(new MiniEvent('change', {...init, target: this}));
    }
    return result;
  }
  dispatchEvent(event) {
    event.target ||= this;
    let current = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of current.listeners?.get(event.type) || []) {
        listener.call(current, event);
      }
      if (event.stopped || event.bubbles === false) {
        break;
      }
      current = current.parentElement;
    }
    return !event.defaultPrevented;
  }
  focus() {
    if (this.isConnected && !hiddenFromLayout(this) && this.disabled !== true) {
      this.document.activeElement = this;
    }
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  matches(selector) {
    return selector.split(',').some(part => selectorMatch(this, part));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim()).filter(Boolean);
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(value => selectorMatch(child, value))) {
          found.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  setAttribute(name, value = '') {
    value = String(value);
    this.attributes.set(name, value);
    if (name === 'class') {
      this.classes = new Set(value.split(/\s+/).filter(Boolean));
    }
    else if (name.startsWith('data-')) {
      this.dataset[camel(name.slice(5))] = value;
    }
    else if (name === 'disabled') {
      this.disabled = true;
    }
    else if (name === 'hidden') {
      this.hidden = true;
    }
    else if (name === 'checked') {
      this.checked = true;
    }
    else if (name === 'title') {
      this.title = value;
    }
    else if (name === 'type') {
      this.type = value;
    }
    else if (name === 'value') {
      this.value = value;
    }
    else if (name === 'max') {
      this.max = Number(value);
    }
  }
}

class MiniDocument {
  constructor() {
    this.activeElement = null;
    this.children = [];
    this.listeners = new Map();
    this.parentElement = null;
  }
  get isConnected() {
    return true;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    if (child.localName === 'html') {
      this.documentElement = child;
    }
    return child;
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim()).filter(Boolean);
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(value => selectorMatch(child, value))) {
          found.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

const parseAttributes = source => {
  const attributes = {};
  const regexp = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(regexp)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
};

const parsePopupHtml = source => {
  const document = new MiniDocument();
  const stack = [document];
  for (const token of source.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!--') || token.startsWith('<!')) {
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)(\/?)>$/);
      if (!match) {
        continue;
      }
      const [, name, attributeSource, slash] = match;
      const element = new MiniElement(name, parseAttributes(attributeSource), document);
      stack.at(-1).appendChild(element);
      if (slash !== '/' && !VOID_ELEMENTS.has(element.localName)) {
        stack.push(element);
      }
      continue;
    }
    if (stack.at(-1) instanceof MiniElement) {
      stack.at(-1)._text += token;
    }
  }
  document.head = document.querySelector('head');
  document.body = document.querySelector('body');
  return document;
};

const hiddenFromLayout = element => {
  let current = element;
  while (current instanceof MiniElement) {
    if (current.hidden === true || current.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    current = current.parentElement;
  }
  return false;
};

const tabOrder = document => document.querySelectorAll('button, input, select').filter(element =>
  element.disabled !== true && hiddenFromLayout(element) === false && element.getAttribute('tabindex') !== '-1'
);

const pressKey = (element, key, init = {}) => {
  element.focus();
  const down = new MiniEvent('keydown', {...init, key, target: element});
  element.dispatchEvent(down);
  if (!down.defaultPrevented && (key === 'Enter' || key === ' ') &&
      (element.localName === 'button' || element.localName === 'input')) {
    element.click(init);
  }
  element.dispatchEvent(new MiniEvent('keyup', {...init, key, target: element}));
};

const pressTab = (document, {reverse = false} = {}) => {
  const order = tabOrder(document);
  const current = order.indexOf(document.activeElement);
  const offset = reverse ? -1 : 1;
  const next = current < 0 ? (reverse ? order.length - 1 : 0) :
    (current + offset + order.length) % order.length;
  order[next]?.focus();
  return document.activeElement;
};

const referencedText = (document, ids) => normalizeText(String(ids || '').split(/\s+/)
  .map(id => document.getElementById(id)?.textContent || '')
  .join(' '));

const accessibleName = (element, document = element.document) => {
  const labelled = element.getAttribute('aria-labelledby');
  if (labelled) {
    return referencedText(document, labelled);
  }
  const aria = element.getAttribute('aria-label');
  if (aria) {
    return normalizeText(aria);
  }
  if (element.id) {
    const label = document.querySelectorAll('label').find(candidate => candidate.getAttribute('for') === element.id);
    if (label) {
      return normalizeText(label.textContent);
    }
  }
  const ancestorLabel = element.closest('label');
  if (ancestorLabel) {
    return normalizeText(ancestorLabel.textContent);
  }
  return normalizeText(element.textContent);
};

const accessibleDescription = (element, document = element.document) =>
  referencedText(document, element.getAttribute('aria-describedby'));

const auditPopupAccessibility = document => {
  const violations = [];
  const ids = new Set();
  for (const element of document.querySelectorAll('[id]')) {
    if (ids.has(element.id)) {
      violations.push(`duplicate id: ${element.id}`);
    }
    ids.add(element.id);
  }
  if (!normalizeText(document.querySelector('title')?.textContent)) {
    violations.push('document title is missing');
  }
  if (document.querySelectorAll('h1').length !== 1) {
    violations.push('popup must have exactly one h1');
  }
  for (const element of document.querySelectorAll('button, input, select, progress')) {
    if (hiddenFromLayout(element)) {
      continue;
    }
    if (!accessibleName(element, document)) {
      violations.push(`${element.localName}#${element.id || element.dataset.cmd || '?'} has no accessible name`);
    }
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      for (const id of String(element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) {
          violations.push(`${element.localName} references missing ${attribute} target ${id}`);
        }
      }
    }
    const tabindex = Number(element.getAttribute('tabindex'));
    if (Number.isFinite(tabindex) && tabindex > 0) {
      violations.push(`${element.localName} uses positive tabindex`);
    }
  }
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.closest('button') && svg.getAttribute('aria-hidden') !== 'true') {
      violations.push('decorative button svg is exposed to assistive technology');
    }
  }
  return violations;
};

const parseCss = source => {
  const rules = [];
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = {};
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) {
        declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
    }
    for (const selector of match[1].split(',')) {
      rules.push({declarations, selector: selector.trim()});
    }
  }
  return rules;
};

const declarationsFor = (rules, selector) => Object.assign({},
  ...rules.filter(rule => rule.selector === selector).map(rule => rule.declarations)
);

export {
  accessibleDescription,
  accessibleName,
  auditPopupAccessibility,
  declarationsFor,
  MiniEvent,
  parseCss,
  parsePopupHtml,
  pressKey,
  pressTab,
  tabOrder
};
