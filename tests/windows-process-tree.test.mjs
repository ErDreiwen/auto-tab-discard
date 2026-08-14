import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  bindExactProcessTree,
  classifyBoundProcesses,
  classifyProcessTreeCandidate,
  cleanupExactProcessTree,
  forceCleanupExactProcessTreeSync,
  isCausallyDescended,
  launchProcessInExactJob,
  mergeProcessTreeBindings,
  sameProcessIdentity,
  validateRefreshedRootIdentity,
  waitForExactProcessTreeExit
} = require('../e2e/windows-process-tree.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const record = (pid, {
  commandLine = `browser.exe --type=process-${pid}`,
  complete = true,
  creation = String(100000 + pid),
  executablePath = 'C:\\Browser\\browser.exe',
  parentPid = 1
} = {}) => ({commandLine, complete, creation, executablePath, parentPid, pid});

test('exact process identity treats PID reuse as exited and unreadable identity as unverified', () => {
  const bound = record(101);
  assert.equal(sameProcessIdentity(bound, {...bound}), true);
  assert.equal(sameProcessIdentity(bound, {...bound, creation: '999999'}), false);
  assert.deepEqual(classifyBoundProcesses([bound], [{...bound, creation: '999999'}]), {
    remaining: [], unverified: []
  });
  assert.deepEqual(classifyBoundProcesses([bound], [{...bound, commandLine: '', complete: false}]), {
    remaining: [], unverified: [101]
  });
});

test('process-tree bindings retain distinct identities and reject a reused refreshed root', () => {
  const root = record(101, {commandLine: 'browser.exe --profile C:\\Profiles\\one'});
  const base = {
    executable: 'C:\\Browser\\browser.exe',
    profile: 'C:\\Profiles\\one',
    profileSwitch: 'profile',
    records: [root],
    rootPid: 101
  };
  const merged = mergeProcessTreeBindings(base, {
    ...base,
    records: [root, record(102, {parentPid: 101})]
  });
  assert.deepEqual(merged.records.map(item => item.pid), [101, 102]);
  assert.equal(validateRefreshedRootIdentity(base, [{...root}]), true);
  assert.throws(() => validateRefreshedRootIdentity(base, [{...root, creation: '999999'}]),
    /root PID was reused/);
  assert.throws(() => validateRefreshedRootIdentity(base, [{...root, commandLine: `${root.commandLine} --new`}]),
    /root PID was reused/);
});

test('ancestry excludes only a complete older orphan and marks unreadable candidates unverified', () => {
  const parent = record(101, {creation: '200'});
  const older = record(102, {creation: '100', parentPid: 101});
  const newer = record(103, {creation: '300', parentPid: 101});
  const unreadable = record(104, {commandLine: '', complete: false, creation: '', parentPid: 101});
  assert.equal(classifyProcessTreeCandidate(parent, older), 'stale');
  assert.equal(classifyProcessTreeCandidate(parent, newer), 'descendant');
  assert.equal(classifyProcessTreeCandidate(parent, unreadable), 'unverified');
  assert.equal(isCausallyDescended(parent, older), false);
  assert.equal(isCausallyDescended(parent, newer), true);
});

test('bounded exit proof retries active and unverified evidence until the exact Job is empty', async () => {
  const binding = {records: [record(101)]};
  const states = [
    {active: -1, remaining: [], unverified: [101]},
    {active: 1, remaining: [101], unverified: []},
    {active: 0, remaining: [], unverified: []}
  ];
  let clock = 0;
  const result = await waitForExactProcessTreeExit(binding, {
    delay: async milliseconds => {
      clock += milliseconds;
    },
    inspect: async () => states.shift(),
    interval: 10,
    now: () => clock,
    timeout: 30
  });
  assert.equal(result.exited, true);
  assert.equal(result.active, 0);
  assert.equal(clock, 20);
});

test('cleanup terminates one owned Job and passes only after ACTIVE_PROCESS_ZERO', async () => {
  const binding = {records: [record(101), record(102, {parentPid: 101})]};
  const states = [
    {active: 2, remaining: [101], unverified: []},
    {active: 0, remaining: [], unverified: []}
  ];
  let forced = 0;
  const cleanup = await cleanupExactProcessTree(binding, {
    delay: async () => {},
    forceKill: async owned => {
      assert.equal(owned, binding);
      forced += 1;
      return 'killed';
    },
    inspect: async () => states.shift(),
    nominalCloseSucceeded: false,
    now: () => 0,
    timeout: 10
  });
  assert.equal(forced, 1);
  assert.equal(cleanup.exited, true);
  assert.equal(cleanup.identityVerified, true);
  assert.equal(cleanup.jobEmptyVerified, true);
  assert.deepEqual(cleanup.forced, {attempted: 1, needed: true, succeeded: 1});
});

test('exact-tree cleanup shares one absolute realistic 90 second phase budget', async () => {
  const binding = {records: [record(101)]};
  const states = [
    {active: 1, remaining: [101], unverified: []},
    {active: 0, remaining: [], unverified: []}
  ];
  const inspectTimeouts = [];
  const forceTimeouts = [];
  let clock = 0;
  const cleanup = await cleanupExactProcessTree(binding, {
    delay: async milliseconds => {
      clock += milliseconds;
    },
    forceKill: async (_owned, {timeout}) => {
      forceTimeouts.push(timeout);
      clock += timeout;
      return 'killed';
    },
    graceTimeout: 30000,
    inspect: async (_binding, {timeout}) => {
      inspectTimeouts.push(timeout);
      clock += timeout;
      return states.shift();
    },
    nominalCloseSucceeded: true,
    now: () => clock,
    timeout: 90000
  });
  assert.deepEqual(inspectTimeouts, [30000, 30000]);
  assert.deepEqual(forceTimeouts, [30000]);
  assert.equal(clock, 90000);
  assert.equal(cleanup.jobEmptyVerified, true);
});

test('sync emergency cleanup closes the checked owner channel instead of issuing a PID kill', () => {
  let ended = 0;
  const binding = {
    controller: {
      child: {
        exitCode: null,
        stdin: {
          end: () => {
            ended += 1;
          },
          writable: true
        }
      }
    }
  };
  assert.equal(forceCleanupExactProcessTreeSync(binding), true);
  assert.equal(ended, 1);
});

test('checked controller source atomically launches into its Job, isolates protocol, and never PID-kills', async () => {
  const helper = await readFile(new URL('../e2e/windows-process-tree.cjs', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../e2e/windows-job-controller.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /taskkill|Get-CimInstance|Win32_Process/i);
  assert.doesNotMatch(controller, /taskkill|Get-CimInstance|Win32_Process/i);
  assert.match(controller, /CREATE_SUSPENDED/);
  assert.match(controller, /EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(controller, /STARTUPINFOEX/);
  assert.match(controller, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(controller, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(controller, /UpdateProcThreadAttribute\(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(controller,
    /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT[\s\S]*IsProcessInJob\(child\.hProcess, job/);
  assert.ok(controller.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST') <
    controller.indexOf('CreateProcessW(executable'),
  'the Job list must be attached before process creation');
  assert.ok(controller.indexOf('CreateProcessW(executable') <
    controller.indexOf('ResumeThread(child.hThread)'),
  'atomic creation and verification must precede the first browser instruction');
  assert.ok(controller.indexOf('CreateProcessW(executable') <
    controller.indexOf('if (!String.IsNullOrEmpty(abruptProofFile))') &&
    controller.indexOf('if (!String.IsNullOrEmpty(abruptProofFile))') <
    controller.indexOf('IsProcessInJob(child.hProcess, job'),
  'abrupt-death injection must be the earliest operation after atomic process creation');
  assert.doesNotMatch(controller, /AssignProcessToJobObject/);
  assert.match(controller, /QueryFullProcessImageName/);
  assert.match(controller, /GetProcessTimes/);
  assert.match(controller, /TerminateJobObject/);
  assert.match(controller, /information\.ActiveProcesses/);
  assert.match(controller, /SetHandleInformation\(standardOutput, HANDLE_FLAG_INHERIT, 0\)/);
  assert.match(controller, /startup\.StartupInfo\.hStdOutput = standardError/);
  assert.match(controller, /occurrences != 1 \|\| matches != 1/);
  assert.match(controller, /childCreated && !childAssigned[\s\S]*TerminateProcessByHandle/);
  assert.doesNotMatch(controller, /error\.Message/);
  assert.match(helper, /PROCESS_BIND_TIMEOUT = 30000/);
  assert.match(helper, /PROCESS_CLEANUP_TIMEOUT = 90000/);
  assert.match(helper, /timeout - 1000/);
});

test('real controller captures descendants from first instruction, accepts a spaced profile, ignores spoofed output, and spares unrelated processes', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows Job Objects are Windows-specific');
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'atd job profile with spaces '));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true
  });
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
    await rm(profile, {force: true, recursive: true});
  });
  const grandchild = 'setInterval(() => {}, 1000)';
  const child = `const {spawn}=require('node:child_process');` +
    `spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
    `setInterval(() => {}, 1000);`;
  const root = `const {spawn}=require('node:child_process');` +
    `process.stdout.write('ATD_JOB_CONTROL '+process.env.ATD_CONTROL_SECRET+` +
      `' {"requestId":0,"status":"bound","active":0,"browserPid":999,"creation":"1"}\\n');` +
    `spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});` +
    `setInterval(() => {}, 1000);`;
  const launched = launchProcessInExactJob({
    args: ['-e', root, '--', `--user-data-dir=${profile}`],
    executable: process.execPath,
    profile,
    profileSwitch: 'user-data-dir'
  });
  launched.child.stderr.resume();
  const binding = await bindExactProcessTree(launched);
  assert.notEqual(binding.rootPid, 999, 'browser stderr cannot spoof the controller-only protocol');
  await delay(250);
  const cleanup = await cleanupExactProcessTree(binding, {nominalCloseSucceeded: false});
  assert.equal(cleanup.jobEmptyVerified, true);
  assert.equal(cleanup.ownerExited, true);
  assert.ok(cleanup.boundProcessCount >= 3, 'root, child, and grandchild were all kernel Job members');
  assert.equal(unrelated.exitCode, null, 'an unrelated process survived exact Job termination');
  assert.equal(unrelated.signalCode, null, 'an unrelated process was not signaled');
});

test('real controller rejects duplicate profile switches before creating a process', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows Job Objects are Windows-specific');
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'atd duplicate profile '));
  t.after(() => rm(profile, {force: true, recursive: true}));
  const launched = launchProcessInExactJob({
    args: [
      '-e', 'setInterval(() => {}, 1000)', '--',
      `--user-data-dir=${profile}`,
      '--user-data-dir=C:\\wrong-profile'
    ],
    executable: process.execPath,
    profile,
    profileSwitch: 'user-data-dir'
  });
  launched.child.stderr.resume();
  await assert.rejects(bindExactProcessTree(launched), /controller exited before binding/);
});

test('pre-assignment controller failure terminates and verifies the suspended child by pinned handle', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows process-handle termination is Windows-specific');
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'atd unassigned failure '));
  const proof = path.join(profile, 'unassigned-failure-proof.txt');
  t.after(() => rm(profile, {force: true, recursive: true}));
  const launched = launchProcessInExactJob({
    args: ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`],
    executable: process.execPath,
    profile,
    profileSwitch: 'user-data-dir',
    testUnassignedFailureProof: proof
  });
  launched.child.stderr.resume();
  await assert.rejects(bindExactProcessTree(launched), /controller exited before binding/);
  assert.equal(await readFile(proof, 'utf8'), 'terminated');
});

test('abrupt controller death at the earliest post-create point leaves no child outside the atomic Job', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows atomic Job-list creation is Windows-specific');
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'atd atomic death '));
  const proof = path.join(profile, 'abrupt-post-create-proof.txt');
  t.after(() => rm(profile, {force: true, recursive: true}));
  const launched = launchProcessInExactJob({
    args: ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`],
    executable: process.execPath,
    profile,
    profileSwitch: 'user-data-dir',
    testAbruptPostCreateProof: proof
  });
  launched.child.stderr.resume();
  await assert.rejects(bindExactProcessTree(launched), /controller exited before binding/);
  const childPid = Number.parseInt(await readFile(proof, 'utf8'), 10);
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'controller recorded the created child PID');
  const deadline = Date.now() + 30000;
  let childExists = true;
  while (childExists && Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await delay(25);
    }
    catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      childExists = false;
    }
  }
  assert.equal(childExists, false,
    'closing the abruptly terminated controller\'s only Job handle killed the atomically associated child');
});
