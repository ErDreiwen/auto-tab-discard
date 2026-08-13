import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const UINT32_RANGE = 0x1_0000_0000;
const MAX_OPERATION_ATTEMPTS = 3;
const MAX_OPERATION_AGE = 24;
const MAX_PENDING_EVENTS = 96;
const ALIAS_TTL = 16;

const clone = value => structuredClone(value);

export class SeededRandom {
  constructor(seed) {
    this.state = Number(seed) >>> 0 || 0x6d2b79f5;
  }

  nextUint32() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  float() {
    return this.nextUint32() / UINT32_RANGE;
  }

  integer(maximum) {
    if (!Number.isInteger(maximum) || maximum <= 0) {
      throw new RangeError('maximum must be a positive integer');
    }
    return Math.floor(this.float() * maximum);
  }

  pick(values) {
    return values[this.integer(values.length)];
  }
}

export class LifecycleInvariantError extends Error {
  constructor(invariant, detail, snapshot) {
    super(`${invariant}: ${detail}`);
    this.name = 'LifecycleInvariantError';
    this.invariant = invariant;
    this.snapshot = snapshot;
  }
}

const logicalClaim = (lineage, tabId, generation) => ({generation, lineage, tabId});

export class MockChromeEventScheduler {
  constructor({initialTabs = 4, seed = 1} = {}) {
    this.random = new SeededRandom(seed);
    this.seed = seed >>> 0;
    this.now = 0;
    this.serial = 0;
    this.nextTabId = 100;
    this.nextLineage = 1;
    this.nextOperationId = 1;
    this.storageAvailable = true;
    this.storageFailureEpoch = 0;
    this.tabs = new Map();
    this.ownership = new Map();
    this.operations = new Map();
    this.aliases = new Map();
    this.events = [];
    this.trace = [];
    this.persistent = {
      operations: new Map(),
      ownership: new Map()
    };
    this.pendingDeletes = {
      operations: new Set(),
      ownership: new Set()
    };
    this.restartRecoveryAttempts = 0;
    for (let index = 0; index < initialTabs; index += 1) {
      this.createTab({active: index === 0});
    }
    this.assertInvariants('initial');
  }

  createTab({active = false} = {}) {
    if (active) {
      for (const tab of this.tabs.values()) {
        tab.active = false;
      }
    }
    const id = this.nextTabId++;
    const lineage = `lineage-${this.nextLineage++}`;
    this.tabs.set(id, {
      active,
      discarded: false,
      discardCount: 0,
      id,
      lineage,
      wakeCount: 0
    });
    return id;
  }

  schedule(type, payload = {}, delay = 0) {
    this.events.push({at: this.now + Math.max(0, delay), payload: clone(payload), serial: this.serial++, type});
    this.events.sort((left, right) => left.at - right.at || left.serial - right.serial);
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.fail('bounded-operation', `event queue grew to ${this.events.length}`);
    }
  }

  record(type, payload = {}) {
    this.trace.push({at: this.now, payload: clone(payload), type});
  }

  tabIds({active, discarded} = {}) {
    return [...this.tabs.values()]
      .filter(tab => active === undefined || tab.active === active)
      .filter(tab => discarded === undefined || tab.discarded === discarded)
      .map(tab => tab.id);
  }

  chooseTab(filters = {}) {
    const ids = this.tabIds(filters);
    return ids.length ? this.random.pick(ids) : undefined;
  }

  storageWrite(collection, key, value) {
    if (!this.storageAvailable) {
      if (value === undefined) {
        this.pendingDeletes[collection].add(key);
      }
      this.record('chrome.storage.session.write-failed', {collection, key});
      return false;
    }
    if (value === undefined) {
      this.persistent[collection].delete(key);
      this.pendingDeletes[collection].delete(key);
    }
    else {
      this.pendingDeletes[collection].delete(key);
      this.persistent[collection].set(key, clone(value));
    }
    return true;
  }

  claim(tab, source) {
    if (!tab || tab.active || !tab.discarded) {
      return false;
    }
    const previous = this.persistent.ownership.get(tab.lineage);
    const generation = (previous?.generation || 0) + 1;
    const claim = {...logicalClaim(tab.lineage, tab.id, generation), source};
    if (!this.storageWrite('ownership', tab.lineage, claim)) {
      return false;
    }
    this.ownership.set(tab.lineage, claim);
    return true;
  }

  releaseLineage(lineage) {
    this.ownership.delete(lineage);
    this.storageWrite('ownership', lineage, undefined);
  }

  cancelOperation(operationId, reason) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }
    this.operations.delete(operationId);
    this.storageWrite('operations', operationId, undefined);
    this.record('operation.cancelled', {operationId, reason});
  }

  cancelLineageOperations(lineage, reason) {
    for (const operation of [...this.operations.values()]) {
      if (operation.lineage === lineage) {
        this.cancelOperation(operation.id, reason);
      }
    }
    for (const operation of [...this.persistent.operations.values()]) {
      if (operation.lineage === lineage && !this.operations.has(operation.id)) {
        this.storageWrite('operations', operation.id, undefined);
        this.record('durable-operation.cancelled', {operationId: operation.id, reason});
      }
    }
  }

  beginTakeover(tab) {
    if (!tab || tab.active || !tab.discarded) {
      return;
    }
    if ([...this.operations.values(), ...this.persistent.operations.values()]
      .some(operation => operation.lineage === tab.lineage)) {
      return;
    }
    const id = `operation-${this.nextOperationId++}`;
    const operation = {
      attempts: 0,
      createdAt: this.now,
      deadline: this.now + MAX_OPERATION_AGE,
      id,
      lineage: tab.lineage,
      phase: 'queued',
      tabId: tab.id
    };
    if (!this.storageWrite('operations', id, operation)) {
      this.record('takeover.not-durable', {lineage: tab.lineage});
      return;
    }
    this.operations.set(id, operation);
    this.schedule('extension.operation-step', {operationId: id}, this.random.integer(3));
  }

  handleOperationStep(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }
    operation.attempts += 1;
    const tab = this.tabs.get(operation.tabId);
    if (!tab || tab.lineage !== operation.lineage) {
      this.cancelOperation(operationId, 'tab-missing-or-replaced-without-lineage');
      return;
    }
    if (tab.active) {
      this.cancelOperation(operationId, 'user-activation');
      return;
    }
    if (operation.attempts > MAX_OPERATION_ATTEMPTS || this.now > operation.deadline) {
      this.cancelOperation(operationId, 'bound-exhausted');
      return;
    }
    if (operation.phase === 'queued') {
      if (tab.discarded) {
        this.releaseLineage(tab.lineage);
        tab.discarded = false;
        tab.wakeCount += 1;
      }
      operation.phase = 'awake';
      this.storageWrite('operations', operation.id, operation);
      this.schedule('extension.operation-step', {operationId}, 1 + this.random.integer(3));
      return;
    }
    if (operation.phase === 'awake') {
      if (tab.active) {
        this.cancelOperation(operationId, 'became-active');
        return;
      }
      tab.discarded = true;
      tab.discardCount += 1;
      this.claim(tab, 'takeover');
      this.cancelOperation(operationId, 'settled');
    }
  }

  externalDiscard(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.active) {
      return;
    }
    tab.discarded = true;
    tab.discardCount += 1;
    this.record('chrome.tabs.onUpdated:discarded-external', {tabId});
    if (!this.ownership.has(tab.lineage) && !this.persistent.ownership.has(tab.lineage)) {
      this.beginTakeover(tab);
    }
  }

  extensionDiscard(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.active) {
      return;
    }
    this.cancelLineageOperations(tab.lineage, 'explicit-extension-discard');
    tab.discarded = true;
    tab.discardCount += 1;
    this.claim(tab, 'extension');
    this.record('chrome.tabs.discard:extension', {tabId});
  }

  activate(tabId) {
    const selected = this.tabs.get(tabId);
    if (!selected) {
      return;
    }
    for (const tab of this.tabs.values()) {
      tab.active = false;
    }
    selected.active = true;
    if (selected.discarded) {
      selected.discarded = false;
      selected.wakeCount += 1;
    }
    this.cancelLineageOperations(selected.lineage, 'chrome.tabs.onActivated');
    this.releaseLineage(selected.lineage);
    this.record('chrome.tabs.onActivated', {tabId});
  }

  replace(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const newId = this.nextTabId++;
    this.tabs.delete(tabId);
    tab.id = newId;
    this.tabs.set(newId, tab);
    for (const alias of this.aliases.values()) {
      if (alias.lineage === tab.lineage) {
        alias.newId = newId;
      }
    }
    this.aliases.set(tabId, {expiresAt: this.now + ALIAS_TTL, lineage: tab.lineage, newId});
    const claim = this.ownership.get(tab.lineage);
    if (claim) {
      claim.tabId = newId;
      this.storageWrite('ownership', tab.lineage, claim);
    }
    const storedClaim = this.persistent.ownership.get(tab.lineage);
    if (storedClaim) {
      storedClaim.tabId = newId;
    }
    for (const operation of this.operations.values()) {
      if (operation.lineage === tab.lineage) {
        operation.tabId = newId;
        this.storageWrite('operations', operation.id, operation);
      }
    }
    for (const operation of this.persistent.operations.values()) {
      if (operation.lineage === tab.lineage) {
        operation.tabId = newId;
      }
    }
    this.schedule('extension.prune-aliases', {}, ALIAS_TTL);
    this.record('chrome.tabs.onReplaced', {addedTabId: newId, removedTabId: tabId});
  }

  close(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.tabs.delete(tabId);
    this.cancelLineageOperations(tab.lineage, 'chrome.tabs.onRemoved');
    this.releaseLineage(tab.lineage);
    for (const [oldId, alias] of [...this.aliases]) {
      if (alias.lineage === tab.lineage) {
        this.aliases.delete(oldId);
      }
    }
    this.record('chrome.tabs.onRemoved', {tabId});
    if (tab.active && this.tabs.size) {
      this.activate(this.tabs.keys().next().value);
    }
  }

  restartWorker() {
    this.ownership.clear();
    this.operations.clear();
    this.restartRecoveryAttempts = 0;
    this.record('chrome.runtime.onStartup', {});
    this.recoverAfterRestart();
  }

  recoverAfterRestart() {
    this.restartRecoveryAttempts += 1;
    if (!this.storageAvailable) {
      if (this.restartRecoveryAttempts < MAX_OPERATION_ATTEMPTS) {
        this.schedule('extension.restart-recovery', {}, this.restartRecoveryAttempts);
      }
      return;
    }
    for (const [lineage, stored] of [...this.persistent.ownership]) {
      const tab = this.tabs.get(stored.tabId);
      if (tab?.lineage === lineage && tab.discarded && !tab.active) {
        this.ownership.set(lineage, clone(stored));
      }
      else {
        this.persistent.ownership.delete(lineage);
      }
    }
    for (const [id, stored] of [...this.persistent.operations]) {
      const tab = this.tabs.get(stored.tabId);
      if (tab?.lineage === stored.lineage && !tab.active && this.now <= stored.deadline) {
        const operation = clone(stored);
        this.operations.set(id, operation);
        this.schedule('extension.operation-step', {operationId: id}, 0);
      }
      else {
        this.persistent.operations.delete(id);
      }
    }
  }

  setStorageFailure(duration) {
    this.storageAvailable = false;
    this.storageFailureEpoch += 1;
    this.record('chrome.storage.session.unavailable', {duration});
    this.schedule('chrome.storage.session.recovered', {epoch: this.storageFailureEpoch}, Math.max(1, duration));
  }

  pruneAliases() {
    for (const [oldId, alias] of [...this.aliases]) {
      if (alias.expiresAt <= this.now || ![...this.tabs.values()].some(tab => tab.lineage === alias.lineage)) {
        this.aliases.delete(oldId);
      }
    }
  }

  expireOperations() {
    for (const operation of [...this.operations.values()]) {
      if (this.now > operation.deadline || operation.attempts > MAX_OPERATION_ATTEMPTS) {
        this.cancelOperation(operation.id, 'expired');
      }
    }
  }

  dispatch(event) {
    this.now = Math.max(this.now, event.at);
    switch (event.type) {
      case 'extension.operation-step':
        this.handleOperationStep(event.payload.operationId);
        break;
      case 'extension.restart-recovery':
        this.recoverAfterRestart();
        break;
      case 'chrome.storage.session.recovered':
        if (event.payload.epoch !== this.storageFailureEpoch) {
          this.record('chrome.storage.session.stale-recovery', event.payload);
          break;
        }
        this.storageAvailable = true;
        for (const collection of ['operations', 'ownership']) {
          for (const key of this.pendingDeletes[collection]) {
            this.persistent[collection].delete(key);
          }
          this.pendingDeletes[collection].clear();
        }
        for (const [lineage, claim] of [...this.persistent.ownership]) {
          const tab = this.tabs.get(claim.tabId);
          if (!tab || tab.lineage !== lineage || tab.active || !tab.discarded) {
            this.persistent.ownership.delete(lineage);
            this.ownership.delete(lineage);
          }
        }
        for (const [id, operation] of [...this.persistent.operations]) {
          const tab = this.tabs.get(operation.tabId);
          if (!tab || tab.lineage !== operation.lineage || tab.active || this.now > operation.deadline) {
            this.persistent.operations.delete(id);
            this.operations.delete(id);
          }
        }
        this.record(event.type, {});
        break;
      case 'extension.prune-aliases':
        this.pruneAliases();
        break;
      default:
        throw new Error(`Unknown scheduled event: ${event.type}`);
    }
    this.expireOperations();
    this.pruneAliases();
    this.assertInvariants(event.type);
  }

  runNextEvent() {
    const event = this.events.shift();
    if (!event) {
      this.now += 1;
      this.expireOperations();
      this.pruneAliases();
      this.assertInvariants('idle-tick');
      return false;
    }
    this.dispatch(event);
    return true;
  }

  applyAction(action) {
    const tabId = action.tabId;
    switch (action.type) {
      case 'external-discard':
        this.externalDiscard(tabId);
        break;
      case 'extension-discard':
        this.extensionDiscard(tabId);
        break;
      case 'activate':
        this.activate(tabId);
        break;
      case 'replace':
        this.replace(tabId);
        break;
      case 'close':
        this.close(tabId);
        break;
      case 'restart':
        this.restartWorker();
        break;
      case 'storage-failure':
        this.setStorageFailure(action.duration);
        break;
      case 'new-tab':
        this.createTab({active: action.active === true});
        break;
      case 'run-next-event':
        this.runNextEvent();
        return;
      case 'release': {
        const tab = this.tabs.get(tabId);
        if (tab) {
          this.releaseLineage(tab.lineage);
        }
        break;
      }
      case 'corrupt-active-discarded': {
        const tab = this.tabs.get(tabId) || this.tabs.values().next().value;
        if (tab) {
          tab.active = true;
          tab.discarded = true;
        }
        break;
      }
      default:
        throw new Error(`Unknown generated action: ${action.type}`);
    }
    this.now += 1;
    this.expireOperations();
    this.pruneAliases();
    this.assertInvariants(action.type);
  }

  settle() {
    let iterations = 0;
    while (this.events.length && iterations < MAX_PENDING_EVENTS * 2) {
      this.runNextEvent();
      iterations += 1;
    }
    this.now += MAX_OPERATION_AGE + ALIAS_TTL + 1;
    this.expireOperations();
    this.pruneAliases();
    for (const [id, operation] of [...this.persistent.operations]) {
      if (!this.operations.has(id)) {
        this.persistent.operations.delete(id);
      }
      else if (this.now > operation.deadline) {
        this.cancelOperation(id, 'settle-expired');
      }
    }
    this.events = this.events.filter(event => event.type !== 'extension.operation-step' ||
      this.operations.has(event.payload.operationId));
    this.assertInvariants('settled');
    if (this.operations.size || this.persistent.operations.size) {
      this.fail('cleanup', 'operations remained after the bounded settle phase');
    }
  }

  fail(invariant, detail) {
    throw new LifecycleInvariantError(invariant, detail, this.snapshot());
  }

  assertInvariants(context) {
    const active = [...this.tabs.values()].filter(tab => tab.active);
    if (active.length > 1) {
      this.fail('active-safety', `${context}: ${active.length} active tabs`);
    }
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.discarded) {
        this.fail('active-safety', `${context}: active tab ${tab.id} is discarded`);
      }
    }

    const ownedTabIds = new Set();
    for (const [lineage, claim] of this.ownership) {
      const tab = this.tabs.get(claim.tabId);
      if (!tab || tab.lineage !== lineage || tab.active || !tab.discarded) {
        this.fail('unique-ownership', `${context}: invalid in-memory claim for ${lineage}`);
      }
      if (ownedTabIds.has(claim.tabId)) {
        this.fail('unique-ownership', `${context}: tab ${claim.tabId} has multiple lineages`);
      }
      ownedTabIds.add(claim.tabId);
      const persisted = this.persistent.ownership.get(lineage);
      if (this.storageAvailable && (!persisted || persisted.generation !== claim.generation ||
          persisted.tabId !== claim.tabId)) {
        this.fail('unique-ownership', `${context}: memory/storage claim diverged for ${lineage}`);
      }
    }
    if (this.storageAvailable) {
      for (const [lineage, claim] of this.persistent.ownership) {
        const tab = this.tabs.get(claim.tabId);
        if (!tab || tab.lineage !== lineage) {
          this.fail('cleanup', `${context}: persisted ownership references a missing lineage ${lineage}`);
        }
        if (tab.active || !tab.discarded) {
          this.fail('unique-ownership', `${context}: persisted owner exists for awake/active tab ${tab.id}`);
        }
      }
    }

    const operatedLineages = new Set();
    for (const operation of this.operations.values()) {
      if (operation.attempts > MAX_OPERATION_ATTEMPTS || this.now > operation.deadline) {
        this.fail('bounded-operation', `${context}: operation ${operation.id} exceeded its bound`);
      }
      if (operatedLineages.has(operation.lineage)) {
        this.fail('unique-ownership', `${context}: duplicate operation for ${operation.lineage}`);
      }
      operatedLineages.add(operation.lineage);
      const tab = this.tabs.get(operation.tabId);
      if (!tab || tab.lineage !== operation.lineage) {
        this.fail('cleanup', `${context}: operation ${operation.id} references a missing tab`);
      }
    }
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.fail('bounded-operation', `${context}: ${this.events.length} scheduled events`);
    }
    if (this.storageAvailable) {
      for (const [id, operation] of this.persistent.operations) {
        const tab = this.tabs.get(operation.tabId);
        if (!tab || tab.lineage !== operation.lineage) {
          this.fail('cleanup', `${context}: durable operation ${id} references a missing tab`);
        }
      }
    }
    for (const [oldId, alias] of this.aliases) {
      if (this.tabs.has(oldId)) {
        this.fail('cleanup', `${context}: replacement alias ${oldId} is still a live ID`);
      }
      if (![...this.tabs.values()].some(tab => tab.lineage === alias.lineage && tab.id === alias.newId)) {
        this.fail('cleanup', `${context}: replacement alias ${oldId} has no live destination`);
      }
      if (alias.expiresAt <= this.now) {
        this.fail('cleanup', `${context}: replacement alias ${oldId} exceeded retention`);
      }
    }
  }

  snapshot() {
    const sorted = map => [...map.values()].map(clone).sort((left, right) =>
      String(left.id || left.lineage).localeCompare(String(right.id || right.lineage)));
    return {
      aliases: [...this.aliases].map(([oldId, alias]) => ({oldId, ...clone(alias)})),
      events: clone(this.events),
      now: this.now,
      operations: sorted(this.operations),
      ownership: sorted(this.ownership),
      persistentOperations: sorted(this.persistent.operations),
      persistentOwnership: sorted(this.persistent.ownership),
      storageAvailable: this.storageAvailable,
      tabs: sorted(this.tabs)
    };
  }
}

const actionFor = (scheduler, random) => {
  const all = scheduler.tabIds();
  const inactive = scheduler.tabIds({active: false});
  const choices = [
    'external-discard', 'external-discard', 'extension-discard', 'activate', 'replace',
    'close', 'restart', 'storage-failure', 'run-next-event', 'run-next-event', 'release', 'new-tab'
  ];
  let type = random.pick(choices);
  if ((type === 'external-discard' || type === 'extension-discard') && inactive.length === 0) {
    type = 'new-tab';
  }
  if (['activate', 'replace', 'close', 'release'].includes(type) && all.length === 0) {
    type = 'new-tab';
  }
  if (type === 'new-tab') {
    return {active: all.length === 0 || random.integer(8) === 0, type};
  }
  if (type === 'storage-failure') {
    return {duration: 1 + random.integer(5), type};
  }
  if (type === 'run-next-event' || type === 'restart') {
    return {type};
  }
  return {
    tabId: random.pick(type === 'external-discard' || type === 'extension-discard' ? inactive : all),
    type
  };
};

export const generateLifecycleScenario = (seed, {steps = 32} = {}) => {
  const random = new SeededRandom(seed);
  const initialTabs = 2 + random.integer(5);
  const scheduler = new MockChromeEventScheduler({initialTabs, seed: random.nextUint32()});
  const actionRandom = new SeededRandom(random.nextUint32());
  const actions = [];
  for (let index = 0; index < steps; index += 1) {
    const action = actionFor(scheduler, actionRandom);
    actions.push(action);
    try {
      scheduler.applyAction(action);
    }
    catch (error) {
      error.scenario = {actions, initialTabs, schedulerSeed: scheduler.seed, seed: seed >>> 0};
      throw error;
    }
  }
  return {actions, initialTabs, schedulerSeed: scheduler.seed, seed: seed >>> 0};
};

export const replayLifecycleScenario = scenario => {
  const scheduler = new MockChromeEventScheduler({
    initialTabs: scenario.initialTabs,
    seed: scenario.schedulerSeed
  });
  for (const action of scenario.actions) {
    scheduler.applyAction(action);
  }
  scheduler.settle();
  return {snapshot: scheduler.snapshot(), trace: scheduler.trace};
};

export const runLifecycleScenario = (seed, options) => {
  let scenario;
  try {
    scenario = generateLifecycleScenario(seed, options);
    const result = replayLifecycleScenario(scenario);
    return {ok: true, result, scenario};
  }
  catch (error) {
    return {
      error: {
        invariant: error.invariant || 'unexpected',
        message: error.message,
        snapshot: error.snapshot
      },
      ok: false,
      scenario: scenario || error.scenario || {actions: [], initialTabs: 0, schedulerSeed: 0, seed: seed >>> 0}
    };
  }
};

export const runLifecycleCampaign = ({baseSeed = 0x41544401, scenarioCount = 10_000, steps = 32} = {}) => {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1) {
    throw new RangeError('scenarioCount must be a positive integer');
  }
  const seedSource = new SeededRandom(baseSeed);
  const coverage = {};
  for (let index = 0; index < scenarioCount; index += 1) {
    const seed = seedSource.nextUint32();
    const outcome = runLifecycleScenario(seed, {steps});
    for (const action of outcome.scenario.actions) {
      coverage[action.type] = (coverage[action.type] || 0) + 1;
    }
    if (!outcome.ok) {
      return {...outcome, baseSeed: baseSeed >>> 0, index, scenarioCount, steps};
    }
  }
  return {baseSeed: baseSeed >>> 0, coverage, ok: true, scenarioCount, steps};
};

const sameFailure = (scenario, invariant) => {
  try {
    replayLifecycleScenario(scenario);
    return false;
  }
  catch (error) {
    return !invariant || error.invariant === invariant;
  }
};

export const minimizeLifecycleFailure = (scenario, invariant) => {
  let actions = clone(scenario.actions);
  let granularity = 2;
  while (actions.length >= 2) {
    const chunkSize = Math.ceil(actions.length / granularity);
    let reduced = false;
    for (let start = 0; start < actions.length; start += chunkSize) {
      const candidate = actions.slice(0, start).concat(actions.slice(start + chunkSize));
      if (candidate.length === 0) {
        continue;
      }
      const replay = {...scenario, actions: candidate};
      if (sameFailure(replay, invariant)) {
        actions = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= actions.length) {
        break;
      }
      granularity = Math.min(actions.length, granularity * 2);
    }
  }
  return {...clone(scenario), actions};
};

export const persistLifecycleFailure = async ({directory, failure}) => {
  const seed = failure.scenario.seed >>> 0;
  const invariant = failure.error?.invariant || 'unexpected';
  const minimized = minimizeLifecycleFailure(failure.scenario, invariant);
  await mkdir(directory, {recursive: true});
  const jsonPath = path.join(directory, `seed-${seed}.json`);
  const commandPath = path.join(directory, `seed-${seed}.repro.txt`);
  const payload = {
    error: failure.error,
    formatVersion: 1,
    minimized,
    originalActionCount: failure.scenario.actions.length,
    reproduction: `node scripts/run-lifecycle-fuzz.mjs --reproduce ${jsonPath.replaceAll('\\', '/')}`
  };
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    writeFile(commandPath, `${payload.reproduction}\n`, 'utf8')
  ]);
  return {commandPath, jsonPath, minimized};
};

export const lifecycleFuzzConstants = Object.freeze({
  ALIAS_TTL,
  MAX_OPERATION_AGE,
  MAX_OPERATION_ATTEMPTS,
  MAX_PENDING_EVENTS
});

export const lifecycleInvariants = Object.freeze([
  'active-safety',
  'unique-ownership',
  'bounded-operation',
  'cleanup'
]);
