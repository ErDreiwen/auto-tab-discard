import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const readMatrix = () => readFile(new URL('../e2e/popup-matrix.cjs', import.meta.url), 'utf8');

test('declared minimum uses a headed Playwright-managed persistent launch plus public CDP attach', async () => {
  const source = await readMatrix();
  const managed = source.slice(
    source.indexOf('const launchPlaywrightManagedOverCDP'),
    source.indexOf('const launchOverCDP = options')
  );

  assert.match(source, /process\.argv\.includes\('--playwright-managed-launch'\)/);
  assert.match(source, /if \(playwrightManaged && allowEdge\)/);
  assert.match(managed, /chromium\.launchPersistentContext\(profile/);
  assert.match(managed, /executablePath,/);
  assert.match(managed, /headless: false/);
  assert.match(managed, /ignoreDefaultArgs: \['--disable-extensions'\]/);
  assert.match(managed, /timeout: 90000/);
  assert.doesNotMatch(managed, /timeout: 30000/);
  assert.match(managed, /chromiumLaunchSafetyArgs\(\{edgePrivacy: false, extensionPath\}\)/);
  assert.match(managed, /'--remote-debugging-port=0'/);
  assert.match(managed, /'Playwright-managed browser DevTools port', 5000/);
  assert.match(managed, /connectOverCDP\(`[\s\S]*\{timeout: 10000\}\)/);
  assert.doesNotMatch(managed, /`--user-data-dir=/);
  assert.match(managed, /chromium\.connectOverCDP\(`/);
  assert.doesNotMatch(managed, /context\.browser\(\)|\._browser|\._connection|\._initializer/);
});

test('managed launch keeps browser-level CDP as the sole runtime PID and version authority', async () => {
  const source = await readMatrix();
  const attach = source.slice(
    source.indexOf('const {browser, context} = launched'),
    source.indexOf('const timeline = []')
  );

  assert.match(attach, /cdp = await browser\.newBrowserCDPSession\(\)/);
  assert.match(attach, /nativeMenuBrowserProcessId = await resolveNativeMenuBrowserProcessId\(cdp\)/);
  assert.match(attach, /await launched\.bindAuthoritativeBrowserProcessId\(nativeMenuBrowserProcessId\)/);
  assert.match(source, /version: browser\.version\(\)/);
  assert.match(source, /sampleMemory\(cdp\)/);
  assert.match(source, /startNativeContextMenuSelector\([\s\S]*nativeMenuBrowserProcessId/);
});

test('managed cleanup closes the owning persistent context and force-kills only an exact identity', async () => {
  const source = await readMatrix();
  const cleanup = source.slice(
    source.indexOf('const MANAGED_BROWSER_IDENTITY_SCRIPT'),
    source.indexOf('const PRIMARY_BACKGROUND')
  );

  assert.match(source, /const closeBrowserLaunch = launched => launched\.managed \?\s*launched\.persistentContext\.close\(\)/);
  assert.match(source, /settleWithin\(closeBrowserLaunch\(launched\), launched\.managed \? 45000 : 5000\)/);
  assert.match(cleanup, /if \(graceful\) \{[\s\S]*exited: true[\s\S]*forced: \{needed: false\}/);
  assert.match(cleanup, /ProcessId = ' \+ \$expectedProcessId/);
  assert.match(cleanup, /ExecutablePath, CommandLine/);
  assert.match(cleanup, /--user-data-dir=/);
  assert.match(cleanup, /if \(before\.state !== 'match'\)/);
  assert.match(cleanup, /taskkill-exact-managed-process-tree/);
  assert.match(cleanup,
    /if \(forcedResult\.exited && emergencyManagedBrowser === controller\)/);
  assert.doesNotMatch(cleanup, /context\.browser\(\)|\._browser|\._connection/);
});

test('managed pre-PID signal cleanup retains a nonzero exit while Playwright drains', async () => {
  const source = await readMatrix();
  const handlers = source.slice(
    source.indexOf("process.once('SIGINT'"),
    source.indexOf('const PRIMARY_BACKGROUND')
  );

  assert.match(handlers,
    /process\.once\('SIGINT',[\s\S]*?if \(emergencyCleanup\(\) === 'deferred'\) \{\s*process\.exitCode = 130;[\s\S]*?process\.exit\(130\)/);
  assert.match(handlers,
    /process\.once\('SIGTERM',[\s\S]*?if \(emergencyCleanup\(\) === 'deferred'\) \{\s*process\.exitCode = 143;[\s\S]*?process\.exit\(143\)/);
  assert.equal((handlers.match(/30000\)\.unref\?\.\(\)/g) || []).length, 2);
});

test('managed launch failure retains emergency cleanup until browser exit is confirmed', async () => {
  const source = await readMatrix();
  const managed = source.slice(
    source.indexOf('const launchPlaywrightManagedOverCDP'),
    source.indexOf('const launchOverCDP = options')
  );

  assert.match(managed,
    /error\.processCleanup = await terminateManagedBrowserProcess\(managedProcess, ownerClose\);\s*if \(error\.processCleanup\.exited\) \{\s*emergencyManagedBrowser = undefined;\s*\}\s*throw error;/);
  assert.doesNotMatch(managed,
    /terminateManagedBrowserProcess\(managedProcess, ownerClose\);\s*emergencyManagedBrowser = undefined;/);
});

test('managed cleanup identity accepts only exact quoted or unquoted profile switches', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell command-line matching is Windows-specific');
    return;
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) {
    t.skip('Windows PowerShell is unavailable');
    return;
  }
  const source = await readMatrix();
  const matcher = source.match(
    /\$expectedProfile = \[string\] \$env:ATD_EXPECTED_PROFILE\n([\s\S]*?)\n\$profileMatches = \[regex\]::IsMatch\(\[string\] \$candidate\.CommandLine, \$profilePattern\)/
  );
  assert.ok(matcher, 'production profile identity matcher must remain extractable');
  const profile = String.raw`C:\runner work\minimum profile`;
  const cases = [
    {commandLine: `chrome.exe --user-data-dir="${profile}" about:blank`, expected: true},
    {commandLine: `chrome.exe --user-data-dir=${profile} about:blank`, expected: true},
    {commandLine: `chrome.exe --user-data-dir="${profile}-other" about:blank`, expected: false}
  ];
  for (const {commandLine, expected} of cases) {
    const probe = [
      `$env:ATD_EXPECTED_PROFILE='${profile.replaceAll("'", "''")}'`,
      `$candidate=[pscustomobject]@{CommandLine='${commandLine.replaceAll("'", "''")}'}`,
      '$expectedProfile = [string] $env:ATD_EXPECTED_PROFILE',
      matcher[1],
      '$profileMatches = [regex]::IsMatch([string] $candidate.CommandLine, $profilePattern)',
      '[Console]::Out.WriteLine($profileMatches)'
    ].join('\n');
    const outcome = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.status, 0);
    assert.equal(outcome.stdout.trim(), expected ? 'True' : 'False', commandLine);
  }
});
