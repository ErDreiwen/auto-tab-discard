'use strict';

const {randomBytes} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLER_SOURCE = path.join(__dirname, 'windows-job-controller.cs');
const CONTROLLER_BUILD_TIMEOUT = 60000;
const PROCESS_BIND_TIMEOUT = 30000;
const PROCESS_CLEANUP_TIMEOUT = 90000;
const PROCESS_FORCE_TIMEOUT = 30000;
const PROCESS_INSPECT_TIMEOUT = 30000;
const powershellPath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ensure = (condition, message) => {
  if (!condition) throw Error(message);
};

const validRecord = record => record?.complete === true && Number.isInteger(record.pid) && record.pid > 0 &&
  Number.isInteger(record.parentPid) && /^\d+$/.test(record.creation || '') &&
  typeof record.executablePath === 'string' && record.executablePath.length > 0 &&
  typeof record.commandLine === 'string' && record.commandLine.length > 0;

const sameProcessIdentity = (left, right) => Boolean(validRecord(left) && validRecord(right) &&
  left.pid === right.pid && left.creation === right.creation &&
  left.executablePath === right.executablePath && left.commandLine === right.commandLine);

const classifyProcessTreeCandidate = (parent, child) => {
  if (child?.parentPid !== parent?.pid) return 'unrelated';
  if (!validRecord(parent) || !validRecord(child)) return 'unverified';
  try {
    return BigInt(child.creation) >= BigInt(parent.creation) ? 'descendant' : 'stale';
  }
  catch {
    return 'unverified';
  }
};

const isCausallyDescended = (parent, child) =>
  classifyProcessTreeCandidate(parent, child) === 'descendant';

const validateRefreshedRootIdentity = (binding, records) => {
  const originalRoot = binding?.records?.find(record => record.pid === binding.rootPid);
  const refreshedRoot = records?.find(record => record.pid === binding?.rootPid);
  ensure(sameProcessIdentity(originalRoot, refreshedRoot),
    'The browser root PID was reused before the exact process tree could be refreshed');
  return true;
};

const classifyBoundProcesses = (boundRecords, currentRecords) => {
  const currentByPid = new Map(currentRecords.map(record => [record.pid, record]));
  const remaining = [];
  const unverified = [];
  for (const bound of boundRecords) {
    const current = currentByPid.get(bound.pid);
    if (!current) continue;
    if (current.complete !== true) unverified.push(bound.pid);
    else if (sameProcessIdentity(bound, current)) remaining.push(bound.pid);
  }
  return {remaining: [...new Set(remaining)], unverified: [...new Set(unverified)]};
};

const mergeProcessTreeBindings = (original, update) => {
  ensure(original?.rootPid === update?.rootPid && original?.profile === update?.profile &&
    original?.executable === update?.executable && original?.profileSwitch === update?.profileSwitch,
  'Cannot merge unrelated browser process-tree bindings');
  const records = [];
  const seen = new Set();
  for (const record of [...original.records, ...update.records]) {
    const key = `${record.pid}\0${record.creation}\0${record.executablePath}\0${record.commandLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  }
  return {...original, records};
};

const compileJobController = profile => {
  ensure(process.platform === 'win32' && fs.existsSync(powershellPath) && fs.existsSync(CONTROLLER_SOURCE),
    'Exact process-tree ownership requires the checked Windows Job controller');
  ensure(fs.existsSync(profile) && fs.statSync(profile).isDirectory(),
    'Exact process-tree ownership requires an existing isolated profile');
  const output = path.join(profile, 'atd-windows-job-controller.exe');
  const outcome = spawnSync(powershellPath, [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -Path $env:ATD_CONTROLLER_SOURCE -OutputAssembly $env:ATD_CONTROLLER_OUTPUT ' +
      '-OutputType ConsoleApplication -ErrorAction Stop'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATD_CONTROLLER_OUTPUT: output,
      ATD_CONTROLLER_SOURCE: CONTROLLER_SOURCE
    },
    timeout: CONTROLLER_BUILD_TIMEOUT,
    windowsHide: true
  });
  ensure(!outcome.error && outcome.status === 0 && fs.existsSync(output),
    'The checked Windows Job controller could not be built');
  return output;
};

const createControllerProtocol = (child, secret, timeout = PROCESS_BIND_TIMEOUT) => {
  let buffer = '';
  let nextRequestId = 1;
  let settled = false;
  const pending = new Map();
  let resolveInitial;
  let rejectInitial;
  const initial = new Promise((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  const initialTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectInitial(Error('The Windows Job controller did not bind the browser in time'));
    }
  }, timeout);
  const rejectPending = () => {
    if (!settled) {
      settled = true;
      clearTimeout(initialTimer);
      rejectInitial(Error('The Windows Job controller exited before binding the browser'));
    }
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error('The Windows Job controller exited during exact-tree cleanup'));
    }
    pending.clear();
  };
  child.once('error', rejectPending);
  child.once('exit', rejectPending);
  child.stdout.on('data', chunk => {
    buffer = (buffer + String(chunk)).slice(-1024 * 1024);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const prefix = `ATD_JOB_CONTROL ${secret} `;
      if (!line.startsWith(prefix)) continue;
      let message;
      try {
        message = JSON.parse(line.slice(prefix.length));
      }
      catch {
        continue;
      }
      if (message.requestId === 0 && !settled) {
        settled = true;
        clearTimeout(initialTimer);
        resolveInitial(message);
        continue;
      }
      const request = pending.get(message.requestId);
      if (request) {
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        request.resolve(message);
      }
    }
  });
  const command = (name, timeoutMs, operationTimeout = timeoutMs) => {
    ensure(child.exitCode === null && child.signalCode === null && child.stdin.writable,
      'The Windows Job controller is unavailable');
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) {
          reject(Error('The Windows Job controller command timed out'));
        }
      }, timeoutMs);
      pending.set(requestId, {reject, resolve, timer});
      child.stdin.write(`${secret}\t${requestId}\t${name}\t${operationTimeout}\n`, error => {
        if (error && pending.delete(requestId)) {
          clearTimeout(timer);
          reject(Error('The Windows Job controller command could not be sent'));
        }
      });
    });
  };
  return {
    child,
    close: timeoutMs => {
      if (child.stdin.writable) child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
      if (!(timeoutMs > 0)) return Promise.resolve(false);
      return new Promise(resolve => {
        let finished = false;
        const finish = value => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          resolve(value);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('exit', onExit);
      });
    },
    command,
    initial
  };
};

const launchProcessInExactJob = ({
  args,
  environment = process.env,
  executable,
  profile,
  profileSwitch,
  testAbruptPostCreateProof,
  testUnassignedFailureProof
}) => {
  ensure(Array.isArray(args), 'Exact process-tree launch requires an argument array');
  const controllerExecutable = compileJobController(profile);
  const secret = randomBytes(32).toString('hex');
  const controllerEnvironment = {...environment};
  for (const name of Object.keys(controllerEnvironment)) {
    if (/^ATD_(?:CONTROL_|EXPECTED_|HARNESS_|PROFILE_|REAL_|TEST_)/i.test(name)) {
      delete controllerEnvironment[name];
    }
  }
  const child = spawn(controllerExecutable, args, {
    env: {
      ...controllerEnvironment,
      ATD_CONTROL_SECRET: secret,
      ATD_EXPECTED_PROFILE: path.resolve(profile),
      ATD_HARNESS_PROCESS_ID: String(process.pid),
      ATD_PROFILE_SWITCH: profileSwitch,
      ATD_REAL_EXECUTABLE: path.resolve(executable),
      ...(testAbruptPostCreateProof ? {
        ATD_TEST_ABRUPT_POST_CREATE_PROOF: path.resolve(testAbruptPostCreateProof)
      } : {}),
      ...(testUnassignedFailureProof ? {
        ATD_TEST_UNASSIGNED_FAILURE_PROOF: path.resolve(testUnassignedFailureProof)
      } : {})
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const protocol = createControllerProtocol(child, secret);
  const processTree = protocol.initial.then(response => {
    ensure(response?.status === 'bound' && Number.isInteger(response.browserPid) && response.browserPid > 0 &&
      Number.isInteger(response.active) && response.active > 0 && /^\d+$/.test(response.creation || ''),
    'The Windows Job controller returned invalid binding evidence');
    const executablePath = path.resolve(executable);
    const record = {
      commandLine: 'kernel-job-owned-browser',
      complete: true,
      creation: response.creation,
      executablePath,
      parentPid: child.pid,
      pid: response.browserPid
    };
    return {
      boundProcessCount: response.active,
      controller: protocol,
      executable: executablePath,
      profile: path.resolve(profile),
      profileSwitch,
      records: [record],
      rootPid: response.browserPid
    };
  }).catch(error => {
    protocol.close();
    throw error;
  });
  return {child, processTree};
};

const bindExactProcessTree = async launch => {
  ensure(launch?.processTree && typeof launch.processTree.then === 'function',
    'Exact process-tree binding requires a launch-under-job result');
  return launch.processTree;
};

const refreshExactProcessTree = binding => {
  ensure(binding?.controller?.child?.exitCode === null && binding.controller.child.signalCode === null,
    'The Windows Job controller exited before exact-tree cleanup');
  return binding;
};

const inspectExactProcessTree = async (binding, {timeout = PROCESS_INSPECT_TIMEOUT} = {}) => {
  ensure(binding?.controller, 'Exact process-tree inspection requires kernel Job ownership');
  const response = await binding.controller.command('query', timeout);
  ensure(response?.status === 'inspected' && Number.isInteger(response.active) && response.active >= 0,
    'The Windows Job controller returned invalid active-process evidence');
  binding.boundProcessCount = Math.max(binding.boundProcessCount || 0, response.active);
  return {
    active: response.active,
    remaining: response.active === 0 ? [] : [binding.rootPid],
    unverified: []
  };
};

const terminateExactProcessJob = async (binding, {timeout = PROCESS_FORCE_TIMEOUT} = {}) => {
  ensure(binding?.controller, 'Exact process-tree termination requires kernel Job ownership');
  const response = await binding.controller.command('terminate', timeout, Math.max(0, timeout - 1000));
  ensure(['terminated', 'termination-pending'].includes(response?.status) &&
    Number.isInteger(response.active) && response.active >= 0,
  'The Windows Job controller returned invalid termination evidence');
  return response.active === 0 ? 'killed' : 'kill-pending';
};

const waitForExactProcessTreeExit = async (binding, {
  deadline,
  delay = sleep,
  inspect = inspectExactProcessTree,
  interval = 100,
  now = Date.now,
  timeout = 5000
} = {}) => {
  const startedAt = now();
  const absoluteDeadline = deadline ?? startedAt + timeout;
  const waitDeadline = Math.min(absoluteDeadline, startedAt + timeout);
  let state;
  do {
    const remainingTime = Math.max(0, absoluteDeadline - now());
    if (remainingTime <= 0 && state) break;
    try {
      state = await inspect(binding, {
        timeout: Math.max(1, Math.min(PROCESS_INSPECT_TIMEOUT, remainingTime || 1))
      });
    }
    catch {
      state = {active: -1, remaining: [], unverified: [-1]};
    }
    if (state.remaining.length === 0 && state.unverified.length === 0 && state.active !== -1) {
      return {...state, exited: true};
    }
    const delayTime = Math.min(interval, Math.max(0, waitDeadline - now()));
    if (delayTime > 0) await delay(delayTime);
  } while (now() < waitDeadline);
  return {...state, exited: false};
};

const cleanupExactProcessTree = async (binding, {
  delay,
  forceKill = terminateExactProcessJob,
  graceTimeout = PROCESS_INSPECT_TIMEOUT,
  inspect,
  interval,
  nominalCloseSucceeded,
  now = Date.now,
  timeout = PROCESS_CLEANUP_TIMEOUT
} = {}) => {
  ensure(binding?.records?.length > 0, 'Exact browser process-tree cleanup requires a binding');
  const startedAt = now();
  const deadline = startedAt + timeout;
  const waitOptions = {delay, inspect, interval, now};
  const before = await waitForExactProcessTreeExit(binding, {
    ...waitOptions,
    deadline,
    timeout: nominalCloseSucceeded ? Math.min(graceTimeout, timeout) : 0
  });
  let forceOutcome;
  if (!before.exited && before.unverified.length === 0) {
    const remainingTime = Math.max(0, deadline - now());
    if (remainingTime > 0) {
      forceOutcome = await forceKill(binding, {
        timeout: Math.max(1, Math.min(PROCESS_FORCE_TIMEOUT, remainingTime))
      });
    }
  }
  const after = before.exited ? before : await waitForExactProcessTreeExit(binding, {
    ...waitOptions,
    deadline,
    timeout: Math.max(0, deadline - now())
  });
  let controllerExited;
  if (after.exited && after.unverified.length === 0 && binding.controller) {
    controllerExited = await binding.controller.close(Math.max(0, deadline - now()));
  }
  return {
    boundProcessCount: binding.boundProcessCount ?? binding.records.length,
    exited: after.exited === true,
    forced: {
      attempted: forceOutcome === undefined ? 0 : 1,
      needed: forceOutcome !== undefined,
      succeeded: ['killed', 'missing'].includes(forceOutcome) ? 1 : 0
    },
    graceful: nominalCloseSucceeded === true && forceOutcome === undefined && after.exited === true,
    identityVerified: after.exited === true && after.unverified.length === 0,
    jobEmptyVerified: after.exited === true && after.active === 0,
    owner: 'windows-kernel-job',
    ownerExited: binding.controller ? controllerExited === true : undefined,
    remainingProcessCount: Math.max(0, after.active ?? after.remaining.length),
    unverifiedProcessCount: after.unverified.length
  };
};

const forceCleanupExactProcessTreeSync = binding => {
  if (!binding?.controller?.child || binding.controller.child.exitCode !== null) return false;
  try {
    const {child} = binding.controller;
    if (child.stdin.writable) {
      // Ending the controller's stdin is itself the fail-safe command: the
      // checked owner terminates its kernel Job and waits for ACTIVE_PROCESS_ZERO.
      child.stdin.end();
      return true;
    }
  }
  catch {}
  return false;
};

module.exports = {
  bindExactProcessTree,
  classifyBoundProcesses,
  classifyProcessTreeCandidate,
  cleanupExactProcessTree,
  compileJobController,
  forceCleanupExactProcessTreeSync,
  isCausallyDescended,
  launchProcessInExactJob,
  mergeProcessTreeBindings,
  refreshExactProcessTree,
  sameProcessIdentity,
  validateRefreshedRootIdentity,
  waitForExactProcessTreeExit
};
