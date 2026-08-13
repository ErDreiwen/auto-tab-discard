const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');

let emergencyBrowserProcess;

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publicFailureReason = error => {
  const message = String(error?.message || error || '');
  const nativeReason = message.match(/native context-menu UI Automation failed \(([a-z-]+)\)/i)?.[1];
  if (nativeReason) {
    return `native-menu-${nativeReason.toLowerCase()}`;
  }
  if (/timed out|timeout/i.test(message)) {
    return 'bounded-timeout';
  }
  if (/cleanup|profile directory/i.test(message)) {
    return 'cleanup-failed';
  }
  if (/does not exist/i.test(message)) {
    return 'input-missing';
  }
  if (/refusing|requires the explicit/i.test(message)) {
    return 'safety-refusal';
  }
  if (/browser exited|spawn/i.test(message)) {
    return 'browser-launch-failed';
  }
  return 'matrix-invariant-failed';
};
const EARLY_FAILURE_PHASES = new Set(['browser-launch', 'cdp-attach', 'startup']);
const EARLY_FAILURE_REASONS = new Set([
  'bounded-timeout',
  'browser-launch-failed',
  'cleanup-failed',
  'input-missing',
  'matrix-invariant-failed',
  'safety-refusal'
]);
const reportOmittedKeys = new Set([
  'executablePath',
  'parentProcessId',
  'path',
  'pid',
  'processId',
  'processIds',
  'processInfo',
  'processes',
  'stack',
  'stderr',
  'stdout'
]);
const reportIdKey = key => key === 'id' || key === 'pid' || /(?:Id|Ids|ID|IDs)$/.test(key);
const reportIdDomain = key => key.toLowerCase() === 'pid' || /process/i.test(key) ? 'process' :
  /window/i.test(key) ? 'window' :
    /group/i.test(key) ? 'group' :
      /extension/i.test(key) ? 'extension' :
        /browserContext/i.test(key) ? 'browser-context' :
          /attempt|job|menuItem|operation/i.test(key) ? 'opaque' : 'tab';
const sanitizeReportString = value => String(value?.message ?? value ?? '')
  .replace(/file:\/{2,3}[^\s"'<>]+/gi, '<local-path>')
  .replace(/\\\\[^\\/\s]+[\\/][^\r\n"'<>|]*/g, '<local-path>')
  .replace(/(?<![A-Za-z])\b[A-Za-z]:[\\/](?![\\/])[^\r\n"'<>|]*/g, '<local-path>')
  .replace(/\/(?:Users|home|tmp|private|var\/folders)\/[^\s"'<>]+/gi, '<local-path>')
  .replace(/\b(?:127\.0\.0\.1|localhost):\d+[^\s"'<>)}\]]*/gi, '<fixture-url>')
  .replace(/\b(?:https?|wss?|ftp|file|blob|data|about|chrome|edge|moz-extension|chrome-extension|edge-extension):[^\s"'<>)}\]]+/gi,
    '<url>')
  .replace(/\b[a-p]{32}\b/gi, '<extension-id>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<opaque-id>')
  .replace(/\b(?:secret|private|sensitive)[-_ ]?canary(?:[-_:][A-Za-z0-9%._~+/=]+)*/gi,
    '<secret-canary>')
  .replace(/("(?:id|tabId|windowId|groupId|keeperId|targetId|processId|pid)"\s*:\s*)-?\d+/gi,
    '$1"<redacted-id>"')
  .replace(/\b((?:tab|window|group|target|keeper|process)(?:\s+(?:with\s+)?)?(?:id)?\s*[:=#]?\s*)-?\d+\b/gi,
    '$1<redacted-id>')
  .replace(/\b(PID\s*[:=#]?\s*)-?\d+\b/gi, '$1<redacted-id>')
  .replace(/[?#][^\s"'<>]*/g, '<url-component>');

const sanitizePopupReport = value => {
  const aliases = new Map();
  const redactId = (entry, domain) => {
    const identity = `${domain}:${String(entry)}`;
    if (!aliases.has(identity)) {
      aliases.set(identity, `<${domain}-id-${aliases.size + 1}>`);
    }
    return aliases.get(identity);
  };
  const visit = (entry, key = '') => {
    if (entry instanceof Error) {
      return {
        message: sanitizeReportString(entry.message),
        name: sanitizeReportString(entry.name)
      };
    }
    if (reportIdKey(key) && typeof entry === 'number') {
      return redactId(entry, reportIdDomain(key));
    }
    if (reportIdKey(key) && typeof entry === 'string' &&
        (key !== 'id' || /^-?\d+$/.test(entry))) {
      return redactId(entry, reportIdDomain(key));
    }
    if (typeof entry === 'string') {
      return sanitizeReportString(entry);
    }
    if (Array.isArray(entry)) {
      return entry.map(item => reportIdKey(key) && ['number', 'string'].includes(typeof item) ?
        redactId(item, reportIdDomain(key)) : visit(item));
    }
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    const sanitized = {};
    for (const [rawKey, item] of Object.entries(entry)) {
      if (reportOmittedKeys.has(rawKey)) {
        continue;
      }
      let safeKey = /^-?\d+$/.test(rawKey) ? redactId(rawKey, 'tab') : sanitizeReportString(rawKey);
      while (Object.hasOwn(sanitized, safeKey)) {
        safeKey += '-duplicate';
      }
      sanitized[safeKey] = visit(item, rawKey);
    }
    return sanitized;
  };
  return visit(value);
};
const createEarlyFailureReport = ({
  browserFamily,
  cleanup = {},
  crashes = [],
  error,
  extension,
  fixtureRequests = [],
  phase
}) => {
  const boundedPhase = EARLY_FAILURE_PHASES.has(phase) ? phase : 'startup';
  const candidateReason = publicFailureReason(error);
  const reasonCode = EARLY_FAILURE_REASONS.has(candidateReason) ?
    candidateReason : 'matrix-invariant-failed';
  return sanitizePopupReport({
    browser: {
      family: browserFamily === 'edge' ? 'edge' : 'chromium',
      version: null
    },
    cleanup,
    crashes,
    error: {phase: boundedPhase, reasonCode},
    extension,
    fixtureRequests,
    memory: [],
    ok: false,
    reportFormat: 'sanitized-v1',
    scenarios: [],
    timeline: [{event: 'early-failure', phase: boundedPhase, reasonCode}]
  });
};
const waitFor = async (task, description, timeout = 15000, interval = 50) => {
  const deadline = Date.now() + timeout;
  let value;
  let error;
  while (Date.now() < deadline) {
    try {
      value = await task();
      error = undefined;
      if (value) {
        return value;
      }
    }
    catch (cause) {
      error = cause;
    }
    await sleep(interval);
  }
  throw Error(`timed out waiting for ${description}; last value: ${JSON.stringify(value)}${
    error ? `; last error: ${error.message}` : ''}`);
};

const taskkillPath = process.platform === 'win32' ?
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe') : undefined;
const powershellPath = process.platform === 'win32' ? path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
) : undefined;
const NATIVE_CONTEXT_MENU_TITLE = 'ZATD E2E Discard Tab';
const NATIVE_MENU_TIMEOUT_MS = 5000;
const NATIVE_MENU_SURFACE_PROBE_MS = 1000;
const NATIVE_MENU_UPDATE_SETTLE_MS = 500;
const NATIVE_POINTER_TIMEOUT_MS = 2000;
const NATIVE_FOREGROUND_TIMEOUT_MS = 750;
const NATIVE_MENU_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

function Stop-Sanitized([int] $Code, [string] $Reason) {
  [Console]::Out.WriteLine('ATD_UIA_ERROR:' + $Reason)
  exit $Code
}

try {
  $rootProcessId = 0
  if (![int]::TryParse($env:ATD_UIA_ROOT_PROCESS_ID, [ref] $rootProcessId) -or $rootProcessId -le 0) {
    Stop-Sanitized 20 'invalid-process-scope'
  }
  $exactName = $env:ATD_UIA_EXACT_MENU_NAME
  if ([string]::IsNullOrWhiteSpace($exactName)) {
    Stop-Sanitized 20 'invalid-accessible-name'
  }
  $exactParentName = $env:ATD_UIA_EXACT_PARENT_NAME
  if ([string]::IsNullOrWhiteSpace($exactParentName) -or $exactParentName -ceq $exactName) {
    Stop-Sanitized 20 'invalid-parent-name'
  }
  $exactDocumentName = $env:ATD_UIA_EXACT_DOCUMENT_NAME
  if ([string]::IsNullOrWhiteSpace($exactDocumentName)) {
    Stop-Sanitized 20 'invalid-document-name'
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AtdNativePointer {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [StructLayout(LayoutKind.Sequential)]
  public struct Point {
    public int x;
    public int y;
  }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out Point point);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(Point point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

  [StructLayout(LayoutKind.Sequential)]
  public struct MouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MouseInput mouse;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Input {
    public uint type;
    public InputUnion value;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint inputCount, Input[] inputs, int inputSize);

  private static uint SendMouseInput(uint flags) {
    Input[] inputs = new Input[1];
    inputs[0] = new Input {
      type = 0,
      value = new InputUnion {mouse = new MouseInput {flags = flags}}
    };
    return SendInput((uint) inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
  }

  public static uint SendRightButtonDown() {
    return SendMouseInput(0x0008);
  }

  public static uint SendRightButtonUp() {
    return SendMouseInput(0x0010);
  }
}
'@

  $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $exactName
  )
  $parentNameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $exactParentName
  )
  $documentNameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $exactDocumentName
  )
  $surfaceControlTypes = @(
    [System.Windows.Automation.ControlType]::Menu,
    [System.Windows.Automation.ControlType]::MenuItem
  )

  # Locate only the exact selected document inside the authoritative CDP
  # browser process tree. Top-level window names are never read or emitted.
  $documentDeadline = [DateTime]::UtcNow.AddMilliseconds(${NATIVE_POINTER_TIMEOUT_MS})
  $documentTarget = $null
  $lastDocumentMatchCount = 0
  do {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop)
    $allowed = [System.Collections.Generic.HashSet[int]]::new()
    [void] $allowed.Add($rootProcessId)
    do {
      $added = $false
      foreach ($process in $processes) {
        $processId = [int] $process.ProcessId
        $parentId = [int] $process.ParentProcessId
        if ($allowed.Contains($parentId) -and $allowed.Add($processId)) {
          $added = $true
        }
      }
    } while ($added)

    $documents = @{}
    $topLevel = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($root in $topLevel) {
      try {
        $rootCurrent = $root.Current
        if (!$allowed.Contains([int] $rootCurrent.ProcessId) -or
            [long] $rootCurrent.NativeWindowHandle -le 0) {
          continue
        }
        $matches = $root.FindAll(
          [System.Windows.Automation.TreeScope]::Subtree,
          $documentNameCondition
        )
        foreach ($element in $matches) {
          $current = $element.Current
          if (!$allowed.Contains([int] $current.ProcessId) -or
              $current.Name -cne $exactDocumentName -or
              !$current.IsEnabled -or $current.IsOffscreen) {
            continue
          }
          $isDocument = $current.ControlType -eq [System.Windows.Automation.ControlType]::Document
          if (!$isDocument) {
            $legacyDocument = $null
            if ($element.TryGetCurrentPattern(
                [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
                [ref] $legacyDocument)) {
              # MSAA ROLE_SYSTEM_DOCUMENT is the RootWebArea fallback exposed
              # by some Chromium accessibility providers.
              $isDocument = [int] $legacyDocument.Current.Role -eq 15
            }
          }
          if (!$isDocument) {
            continue
          }
          $rect = $current.BoundingRectangle
          if ([double]::IsNaN($rect.X) -or [double]::IsInfinity($rect.X) -or
              [double]::IsNaN($rect.Y) -or [double]::IsInfinity($rect.Y) -or
              [double]::IsNaN($rect.Width) -or [double]::IsInfinity($rect.Width) -or
              [double]::IsNaN($rect.Height) -or [double]::IsInfinity($rect.Height) -or
              $rect.Width -lt 48 -or $rect.Height -lt 48) {
            continue
          }
          $runtimeId = [string]::Join('.', $element.GetRuntimeId())
          $documents[$runtimeId] = [pscustomobject] @{
            Rectangle = $rect
            TopLevelHandle = [long] $rootCurrent.NativeWindowHandle
            TopLevelProcessId = [int] $rootCurrent.ProcessId
          }
        }
      }
      catch {
        # The exact disposable window can refresh its accessibility tree while
        # the fixture settles; the next bounded poll obtains a fresh element.
      }
    }
    $lastDocumentMatchCount = $documents.Count
    if ($lastDocumentMatchCount -eq 1) {
      $documentTarget = @($documents.Values)[0]
      break
    }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $documentDeadline)

  if ($lastDocumentMatchCount -gt 1) {
    Stop-Sanitized 27 'ambiguous-document-match'
  }
  if ($null -eq $documentTarget) {
    Stop-Sanitized 27 'exact-document-not-found'
  }

  $targetWindow = [IntPtr]::new([long] $documentTarget.TopLevelHandle)
  if ($targetWindow -eq [IntPtr]::Zero -or
      ![AtdNativePointer]::IsWindow($targetWindow)) {
    Stop-Sanitized 28 'invalid-document-window'
  }
  $targetProcessId = [uint32] 0
  $targetThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
    $targetWindow, [ref] $targetProcessId)
  if ($targetThreadId -eq 0 -or $targetProcessId -eq 0 -or
      [int] $targetProcessId -ne [int] $documentTarget.TopLevelProcessId -or
      !$allowed.Contains([int] $targetProcessId)) {
    Stop-Sanitized 28 'document-window-outside-process-scope'
  }

  # SetForegroundWindow is intentionally attempted only for the exact HWND
  # that owns the one exact document match. When Windows foreground locking
  # rejects the direct call, temporarily join this helper thread to the live
  # foreground and target input queues. Every successful attachment is
  # detached in the same iteration's finally block, including error paths.
  $foregroundDeadline = [DateTime]::UtcNow.AddMilliseconds(${NATIVE_FOREGROUND_TIMEOUT_MS})
  do {
    $foregroundWindow = [AtdNativePointer]::GetForegroundWindow()
    if ($foregroundWindow -eq $targetWindow) {
      break
    }
    $foregroundProcessId = [uint32] 0
    $foregroundThreadId = [uint32] 0
    if ($foregroundWindow -ne [IntPtr]::Zero) {
      $foregroundThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
        $foregroundWindow, [ref] $foregroundProcessId)
    }
    $currentThreadId = [AtdNativePointer]::GetCurrentThreadId()
    $attachedToForeground = $false
    $attachedToTarget = $false
    try {
      if ($foregroundThreadId -ne 0 -and $foregroundThreadId -ne $currentThreadId) {
        $attachedToForeground = [AtdNativePointer]::AttachThreadInput(
          $currentThreadId, $foregroundThreadId, $true)
      }
      if ($targetThreadId -ne $currentThreadId -and
          $targetThreadId -ne $foregroundThreadId) {
        $attachedToTarget = [AtdNativePointer]::AttachThreadInput(
          $currentThreadId, $targetThreadId, $true)
      }
      [void] [AtdNativePointer]::BringWindowToTop($targetWindow)
      [void] [AtdNativePointer]::SetForegroundWindow($targetWindow)
    }
    finally {
      if ($attachedToTarget) {
        [void] [AtdNativePointer]::AttachThreadInput(
          $currentThreadId, $targetThreadId, $false)
      }
      if ($attachedToForeground) {
        [void] [AtdNativePointer]::AttachThreadInput(
          $currentThreadId, $foregroundThreadId, $false)
      }
    }
    if ([AtdNativePointer]::GetForegroundWindow() -eq $targetWindow) {
      break
    }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $foregroundDeadline)

  $foregroundWindow = [AtdNativePointer]::GetForegroundWindow()
  $foregroundProcessId = [uint32] 0
  [void] [AtdNativePointer]::GetWindowThreadProcessId(
    $foregroundWindow, [ref] $foregroundProcessId)
  $foregroundIsExactTarget = $foregroundWindow -eq $targetWindow
  if (!$foregroundIsExactTarget -or
      [int] $foregroundProcessId -ne [int] $targetProcessId -or
      !$allowed.Contains([int] $foregroundProcessId)) {
    Stop-Sanitized 28 'exact-document-window-not-foreground'
  }

  # Re-resolve the exact document HWND immediately before pointer input. A
  # destroyed/reused handle or process-tree escape fails closed even if another
  # isolated browser window happened to own foreground at the final poll.
  $verifiedTargetProcessId = [uint32] 0
  $verifiedTargetThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
    $targetWindow, [ref] $verifiedTargetProcessId)
  if ($verifiedTargetThreadId -eq 0 -or
      [int] $verifiedTargetProcessId -ne [int] $targetProcessId -or
      !$allowed.Contains([int] $verifiedTargetProcessId)) {
    Stop-Sanitized 28 'document-window-became-stale'
  }

  $clickX = [int] [Math]::Floor($documentTarget.Rectangle.X + 24)
  $clickY = [int] [Math]::Floor(
    $documentTarget.Rectangle.Y + $documentTarget.Rectangle.Height - 24)
  if (![AtdNativePointer]::SetCursorPos($clickX, $clickY)) {
    Stop-Sanitized 28 'pointer-position-failed'
  }

  # Resolve the cursor hit immediately before delivery. Child renderer HWNDs
  # are accepted only when both GA_ROOT and GA_ROOTOWNER are the exact target
  # window and every involved process remains inside the isolated tree.
  $pointerPoint = [AtdNativePointer+Point]::new()
  if (![AtdNativePointer]::GetCursorPos([ref] $pointerPoint) -or
      $pointerPoint.x -ne $clickX -or $pointerPoint.y -ne $clickY) {
    Stop-Sanitized 28 'pointer-moved-before-input'
  }
  $hitWindow = [AtdNativePointer]::WindowFromPoint($pointerPoint)
  $hitRootWindow = [AtdNativePointer]::GetAncestor($hitWindow, 2)
  $hitRootOwnerWindow = [AtdNativePointer]::GetAncestor($hitWindow, 3)
  $hitProcessId = [uint32] 0
  $hitThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
    $hitWindow, [ref] $hitProcessId)
  $hitRootProcessId = [uint32] 0
  $hitRootThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
    $hitRootWindow, [ref] $hitRootProcessId)
  $hitRootOwnerProcessId = [uint32] 0
  $hitRootOwnerThreadId = [AtdNativePointer]::GetWindowThreadProcessId(
    $hitRootOwnerWindow, [ref] $hitRootOwnerProcessId)
  $deliveryForegroundWindow = [AtdNativePointer]::GetForegroundWindow()
  if ($hitWindow -eq [IntPtr]::Zero -or
      $hitRootWindow -ne $targetWindow -or $hitRootOwnerWindow -ne $targetWindow -or
      $hitThreadId -eq 0 -or $hitRootThreadId -eq 0 -or $hitRootOwnerThreadId -eq 0 -or
      [int] $hitRootProcessId -ne [int] $targetProcessId -or
      [int] $hitRootOwnerProcessId -ne [int] $targetProcessId -or
      !$allowed.Contains([int] $hitProcessId) -or
      !$allowed.Contains([int] $hitRootProcessId) -or
      !$allowed.Contains([int] $hitRootOwnerProcessId) -or
      $deliveryForegroundWindow -ne $targetWindow) {
    Stop-Sanitized 28 'pointer-hit-test-missed-target'
  }

  [Console]::Out.WriteLine('ATD_UIA_POINTER_ATTEMPT:CheckedSendInputHeldRightClick')
  $sentDownCount = [AtdNativePointer]::SendRightButtonDown()
  if ($sentDownCount -ne 1) {
    Stop-Sanitized 28 'checked-send-input-down-incomplete'
  }
  $sentUpCount = [uint32] 0
  try {
    Start-Sleep -Milliseconds 30
  }
  finally {
    $sentUpCount = [AtdNativePointer]::SendRightButtonUp()
  }
  if ($sentUpCount -ne 1) {
    Stop-Sanitized 28 'checked-send-input-up-incomplete'
  }
  [Console]::Out.WriteLine('ATD_UIA_POINTER_RESULT:CheckedSendInputHeldRightClick')

  $deadline = [DateTime]::UtcNow.AddMilliseconds(${NATIVE_MENU_TIMEOUT_MS})
  $firstSurfaceDeadline = [DateTime]::UtcNow.AddMilliseconds(${NATIVE_MENU_SURFACE_PROBE_MS})
  $lastMatchCount = 0
  $lastParentMatchCount = 0
  $parentExpansionAttempted = $false
  $sawUnsupportedExactMatch = $false
  $firstSurfaceDecisionMade = $false
  $firstSurfaceProofIntact = $true
  $firstSurfaceScanCount = 0
  $surfaceProofIntact = $true
  $surfaceScanCount = 0
  $allowedSurfaceObserved = $false

  do {
    # Refresh the transitive process tree on every bounded poll. Chromium can
    # create its native UI host after the page's right click, so a one-time
    # child snapshot can incorrectly exclude the real menu provider.
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop)
    $allowed = [System.Collections.Generic.HashSet[int]]::new()
    [void] $allowed.Add($rootProcessId)
    do {
      $added = $false
      foreach ($process in $processes) {
        $processId = [int] $process.ProcessId
        $parentId = [int] $process.ParentProcessId
        if ($allowed.Contains($parentId) -and $allowed.Add($processId)) {
          $added = $true
        }
      }
    } while ($added)

    $preferred = @{}
    $fallbacks = @{}
    $allowedSurfaces = @{}
    $surfaceScanComplete = $true
    $exactChildObserved = $false
    $topLevel = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($root in $topLevel) {
      try {
        # Reject unrelated top-level windows before reading any descendant
        # accessibility tree. This prevents a personal browser or another app
        # with the same menu label from ever entering the candidate set.
        if (!$allowed.Contains([int] $root.Current.ProcessId)) {
          continue
        }
        # Observe only generic Menu/MenuItem control types in the isolated
        # process tree. Names, bounds, and unrelated accessibility properties
        # never cross the helper boundary; only fixed presence categories do.
        foreach ($surfaceControlType in $surfaceControlTypes) {
          $surfaceCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            $surfaceControlType
          )
          $surfaceMatches = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Subtree,
            $surfaceCondition
          )
          foreach ($surface in $surfaceMatches) {
            $surfaceCurrent = $surface.Current
            if ($allowed.Contains([int] $surfaceCurrent.ProcessId) -and
                $surfaceCurrent.ControlType -eq $surfaceControlType) {
              $surfaceRuntimeId = [string]::Join('.', $surface.GetRuntimeId())
              $allowedSurfaces[$surfaceRuntimeId] = $true
            }
          }
        }
        $matches = $root.FindAll(
          [System.Windows.Automation.TreeScope]::Subtree,
          $nameCondition
        )
        foreach ($element in $matches) {
          $current = $element.Current
          if ($allowed.Contains([int] $current.ProcessId) -and
              $current.Name -ceq $exactName) {
            $exactChildObserved = $true
            if (!$current.IsEnabled) {
              continue
            }
            # Edge can report an actionable native menu item as offscreen when
            # its context menu is long or scrollable. UIA pattern invocation
            # does not require a screen coordinate, so retain the exact-name,
            # enabled-state, process-scope, and uniqueness gates without
            # treating that provider-specific visibility flag as authority.
            $method = $null
            $pattern = $null
            if ($element.TryGetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern,
                [ref] $pattern)) {
              $method = 'InvokePattern'
            }
            else {
              $legacy = $null
              if ($element.TryGetCurrentPattern(
                  [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
                  [ref] $legacy) -and
                  ![string]::IsNullOrWhiteSpace($legacy.Current.DefaultAction)) {
                $method = 'LegacyIAccessiblePattern'
                $pattern = $legacy
              }
            }
            # Chromium-family providers can expose both an actionable parent
            # and a same-name Text child. Eliminate non-actionable duplicates
            # before runtime-ID uniqueness is evaluated.
            if ($null -eq $method) {
              $sawUnsupportedExactMatch = $true
              continue
            }
            $runtimeId = [string]::Join('.', $element.GetRuntimeId())
            $candidate = [pscustomobject] @{
              Method = $method
              Pattern = $pattern
            }
            if ($current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) {
              $preferred[$runtimeId] = $candidate
            }
            else {
              $fallbacks[$runtimeId] = $candidate
            }
          }
        }
      }
      catch {
        $surfaceScanComplete = $false
        # A transient native-menu element can disappear while its properties
        # are read. The next bounded poll obtains a fresh UIA element.
      }
    }
    if ($surfaceScanComplete) {
      $surfaceScanCount += 1
      if (!$firstSurfaceDecisionMade) {
        $firstSurfaceScanCount += 1
      }
      if ($allowedSurfaces.Count -gt 0) {
        $allowedSurfaceObserved = $true
        if (!$firstSurfaceDecisionMade) {
          $firstSurfaceDecisionMade = $true
          [Console]::Out.WriteLine('ATD_UIA_FIRST_SURFACE_RESULT:Present')
        }
      }
    }
    else {
      $surfaceProofIntact = $false
      if (!$firstSurfaceDecisionMade) {
        $firstSurfaceProofIntact = $false
      }
    }
    # Prefer the browser-neutral MenuItem contract when a provider exposes it.
    # Edge's native popup may instead expose the exact entry as another
    # actionable control type; only that pattern-proven fallback is eligible.
    $scoped = $fallbacks
    if ($preferred.Count -gt 0) {
      $scoped = $preferred
    }
    $lastMatchCount = $scoped.Count

    if ($lastMatchCount -eq 1) {
      $allowedSurfaceObserved = $true
      if (!$firstSurfaceDecisionMade) {
        $firstSurfaceDecisionMade = $true
        [Console]::Out.WriteLine('ATD_UIA_FIRST_SURFACE_RESULT:Present')
      }
      [Console]::Out.WriteLine('ATD_UIA_FINAL_SURFACE_RESULT:Present')
      $target = @($scoped.Values)[0]
      if ($target.Method -eq 'InvokePattern') {
        $target.Pattern.Invoke()
        [Console]::Out.WriteLine('ATD_UIA_RESULT:InvokePattern')
        exit 0
      }
      if ($target.Method -eq 'LegacyIAccessiblePattern') {
        $target.Pattern.DoDefaultAction()
        [Console]::Out.WriteLine('ATD_UIA_RESULT:LegacyIAccessiblePattern')
        exit 0
      }
      Stop-Sanitized 23 'unsupported-menu-pattern'
    }

    if ($lastMatchCount -eq 0 -and !$exactChildObserved -and !$parentExpansionAttempted) {
      $parents = @{}
      foreach ($root in $topLevel) {
        try {
          if (!$allowed.Contains([int] $root.Current.ProcessId)) {
            continue
          }
          # Query only the exact manifest-derived extension parent. No other
          # accessible names are read into the candidate set or output.
          $parentMatches = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Subtree,
            $parentNameCondition
          )
          foreach ($element in $parentMatches) {
            $current = $element.Current
            if (!$allowed.Contains([int] $current.ProcessId) -or
                $current.Name -cne $exactParentName -or
                !$current.IsEnabled) {
              continue
            }
            $parentMethod = $null
            $parentPattern = $null
            if ($element.TryGetCurrentPattern(
                [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
                [ref] $parentPattern) -and
                $parentPattern.Current.ExpandCollapseState -ne
                  [System.Windows.Automation.ExpandCollapseState]::LeafNode) {
              $parentMethod = 'ExpandCollapsePattern'
            }
            else {
              $legacy = $null
              if ($element.TryGetCurrentPattern(
                  [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
                  [ref] $legacy)) {
                $defaultAction = $legacy.Current.DefaultAction
                if (![string]::IsNullOrWhiteSpace($defaultAction) -and
                    $defaultAction -match '(?i)\b(expand|open|show)\b') {
                  $parentMethod = 'LegacyIAccessiblePattern'
                  $parentPattern = $legacy
                }
              }
            }
            # Same-name non-actionable Text descendants are excluded before
            # the unique runtime-ID safety decision.
            if ($null -eq $parentMethod) {
              continue
            }
            $runtimeId = [string]::Join('.', $element.GetRuntimeId())
            $parents[$runtimeId] = [pscustomobject] @{
              Method = $parentMethod
              Pattern = $parentPattern
            }
          }
        }
        catch {
          # A disappearing native-menu parent is retried by the next poll.
        }
      }
      $lastParentMatchCount = $parents.Count
      if ($lastParentMatchCount -eq 1) {
        $parent = @($parents.Values)[0]
        $parentExpansionAttempted = $true
        if ($parent.Method -eq 'ExpandCollapsePattern') {
          $parent.Pattern.Expand()
        }
        elseif ($parent.Method -eq 'LegacyIAccessiblePattern') {
          $parent.Pattern.DoDefaultAction()
        }
        else {
          Stop-Sanitized 25 'unsupported-parent-pattern'
        }
        [Console]::Out.WriteLine('ATD_UIA_PARENT_RESULT:' + $parent.Method)
        Start-Sleep -Milliseconds 100
        continue
      }
    }

    if (!$firstSurfaceDecisionMade -and
        [DateTime]::UtcNow -ge $firstSurfaceDeadline) {
      $firstSurfaceDecisionMade = $true
      if ($firstSurfaceProofIntact -and $firstSurfaceScanCount -gt 0 -and
          !$allowedSurfaceObserved) {
        # This is diagnostic evidence only. A second native input sequence
        # requires stronger hit-test and fresh-document proof than UIA surface
        # absence alone provides, so the helper remains single-click.
        [Console]::Out.WriteLine('ATD_UIA_FIRST_SURFACE_RESULT:Absent')
      }
      else {
        [Console]::Out.WriteLine('ATD_UIA_FIRST_SURFACE_RESULT:Indeterminate')
      }
    }

    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($allowedSurfaceObserved) {
    [Console]::Out.WriteLine('ATD_UIA_FINAL_SURFACE_RESULT:Present')
  }
  elseif ($surfaceProofIntact -and $surfaceScanCount -gt 0) {
    [Console]::Out.WriteLine('ATD_UIA_FINAL_SURFACE_RESULT:Absent')
  }
  else {
    [Console]::Out.WriteLine('ATD_UIA_FINAL_SURFACE_RESULT:Indeterminate')
  }

  if ($lastMatchCount -gt 1) {
    Stop-Sanitized 22 'ambiguous-exact-match'
  }
  if ($lastParentMatchCount -gt 1) {
    Stop-Sanitized 25 'ambiguous-parent-match'
  }
  if ($sawUnsupportedExactMatch) {
    Stop-Sanitized 23 'unsupported-menu-pattern'
  }
  if ($parentExpansionAttempted) {
    Stop-Sanitized 26 'expanded-parent-child-not-found'
  }
  Stop-Sanitized 21 'exact-item-not-found'
}
catch {
  Stop-Sanitized 24 'automation-failure'
}
`;
const nativeMenuDiagnosticsFromOutput = output => {
  const fixedSurface = marker => output.match(
    new RegExp(`ATD_UIA_${marker}_SURFACE_RESULT:(Present|Absent|Indeterminate)`)
  )?.[1]?.toLowerCase() || 'not-observed';
  const pointerAttempted = /ATD_UIA_POINTER_ATTEMPT:CheckedSendInputHeldRightClick/.test(output);
  return {
    finalSurface: fixedSurface('FINAL'),
    firstClickSurface: fixedSurface('FIRST'),
    rightClickAttempts: pointerAttempted ? 1 : 0
  };
};
const startNativeContextMenuSelector = (
  exactName, browserPid, exactParentName, exactDocumentName
) => {
  if (process.platform !== 'win32' || !powershellPath || !fs.existsSync(powershellPath)) {
    throw Error('native context-menu UI Automation is unavailable');
  }
  if (typeof exactName !== 'string' || exactName.length === 0 || exactName.length > 128) {
    throw Error('native context-menu selection requires one exact accessible name');
  }
  if (typeof exactParentName !== 'string' || exactParentName.length === 0 ||
      exactParentName.length > 128 || exactParentName === exactName) {
    throw Error('native context-menu selection requires one exact accessible parent name');
  }
  if (typeof exactDocumentName !== 'string' || exactDocumentName.trim().length === 0 ||
      exactDocumentName.length > 256) {
    throw Error('native context-menu selection requires one exact accessible document name');
  }
  if (!Number.isInteger(browserPid) || browserPid <= 0) {
    throw Error('native context-menu selection requires an isolated browser process scope');
  }
  const child = spawn(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'
  ], {
    env: {
      ...process.env,
      ATD_UIA_EXACT_MENU_NAME: exactName,
      ATD_UIA_EXACT_PARENT_NAME: exactParentName,
      ATD_UIA_EXACT_DOCUMENT_NAME: exactDocumentName,
      ATD_UIA_ROOT_PROCESS_ID: String(browserPid)
    },
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  child.stdout.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', chunk => output = (output + chunk).slice(-4096));

  let cancelled = false;
  let settled = false;
  let timer;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A failed pointer action can delay the caller's await until cleanup. Mark
  // the original promise handled immediately while preserving its rejection
  // for the later explicit await.
  completion.catch(() => {});
  const finishError = reason => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    const error = Error(`native context-menu UI Automation failed (${reason})`);
    error.nativeMenuDiagnostics = nativeMenuDiagnosticsFromOutput(output);
    rejectCompletion(error);
  };
  const finishSuccess = value => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolveCompletion(value);
  };
  const closed = new Promise(resolve => child.once('close', () => resolve(true)));
  child.once('error', () => finishError('helper-failure'));
  child.stdin.once('error', () => {
    finishError('helper-input-failure');
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  child.once('close', code => {
    const nativeMenuDiagnostics = nativeMenuDiagnosticsFromOutput(output);
    const result = output.match(
      /ATD_UIA_RESULT:(InvokePattern|LegacyIAccessiblePattern)/)?.[1];
    const parentExpansionMethod = output.match(
      /ATD_UIA_PARENT_RESULT:(ExpandCollapsePattern|LegacyIAccessiblePattern)/)?.[1];
    const pointerMethod = output.match(
      /ATD_UIA_POINTER_RESULT:(CheckedSendInputHeldRightClick)/)?.[1];
    if (!cancelled && code === 0 && result) {
      finishSuccess({
        ...nativeMenuDiagnostics,
        method: result,
        parentExpansionMethod,
        pointerMethod,
        scope: 'cdp-browser-process-tree'
      });
      return;
    }
    const reason = output.match(/ATD_UIA_ERROR:([a-z-]+)/)?.[1] ||
      (cancelled ? 'selector-cancelled' : 'helper-failure');
    finishError(reason);
  });
  timer = setTimeout(() => {
    finishError('bounded-timeout');
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, NATIVE_POINTER_TIMEOUT_MS + NATIVE_FOREGROUND_TIMEOUT_MS +
    NATIVE_MENU_TIMEOUT_MS + 2000);
  // Stream the exact in-memory script over this child's private stdin. This
  // avoids Windows command-line length and quoting limits without a shell or
  // a shared/global temporary file.
  child.stdin.end(NATIVE_MENU_UIA_SCRIPT, 'utf8');

  const cancel = async () => {
    const needed = child.exitCode === null && child.signalCode === null;
    if (needed) {
      cancelled = true;
      finishError('selector-cancelled');
      child.kill('SIGKILL');
    }
    let exited = await Promise.race([closed, sleep(2000).then(() => false)]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      exited = await Promise.race([closed, sleep(2000).then(() => false)]);
    }
    if (!exited) {
      throw Error('native context-menu selector cleanup timed out');
    }
    return {needed};
  };

  return {cancel, completion};
};
const killProcessTreeSync = child => {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) {
    return {needed: false};
  }
  if (process.platform === 'win32' && fs.existsSync(taskkillPath)) {
    const outcome = spawnSync(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    });
    return {
      needed: true,
      method: 'taskkill-process-tree',
      status: outcome.status
    };
  }
  return {needed: true, signal: child.kill('SIGKILL')};
};
const waitForProcessExit = (child, timeout = 5000) => {
  if (!child || child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeout).then(() => false)
  ]);
};
const terminateBrowserProcess = async child => {
  const graceful = await waitForProcessExit(child, 5000);
  const forced = graceful ? {needed: false} : killProcessTreeSync(child);
  const exited = graceful || await waitForProcessExit(child, 5000);
  if (emergencyBrowserProcess === child) {
    emergencyBrowserProcess = undefined;
  }
  return {exited, forced, graceful};
};
const settleWithin = async (operation, timeout = 5000) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(value => ({status: 'fulfilled', value}), error => ({
        reasonCode: publicFailureReason(error),
        status: 'rejected'
      })),
      new Promise(resolve => timer = setTimeout(() => resolve({status: 'timeout'}), timeout))
    ]);
  }
  finally {
    clearTimeout(timer);
  }
};

const emergencyCleanup = () => {
  if (emergencyBrowserProcess?.exitCode === null) {
    killProcessTreeSync(emergencyBrowserProcess);
  }
};
process.once('exit', emergencyCleanup);
process.once('SIGINT', () => {
  emergencyCleanup();
  process.exit(130);
});
process.once('SIGTERM', () => {
  emergencyCleanup();
  process.exit(143);
});

const PRIMARY_BACKGROUND = [
  'p-left-far',
  'p-left-near',
  'p-right-near',
  'p-right-mid',
  'p-right-far'
];
const OTHER_BACKGROUND = ['a-bg-1', 'a-bg-2', 'b-bg-1', 'b-bg-2'];
const ALL_BACKGROUND = [...PRIMARY_BACKGROUND, ...OTHER_BACKGROUND];
const ALL_SCOPED_TABS = [
  ...PRIMARY_BACKGROUND,
  'p-selected',
  ...OTHER_BACKGROUND,
  'a-active',
  'b-active'
];
const SETUP_EXTERNAL = new Set(['p-left-near', 'p-right-mid', 'a-bg-2', 'b-bg-2']);
const DISCARD_SPECS = {
  'discard-window': PRIMARY_BACKGROUND,
  'discard-rights': ['p-right-near', 'p-right-mid', 'p-right-far'],
  'discard-lefts': ['p-left-far', 'p-left-near'],
  // The blank-tab safety plug-in moves focus to bg-1 in each other window so
  // the formerly active tab can be discarded without leaving a window with no
  // live keeper.
  'discard-other-windows': ['a-active', 'a-bg-2', 'b-active', 'b-bg-2'],
  // The all-windows form performs the same keeper swap in every window.
  'discard-tabs': [
    ...PRIMARY_BACKGROUND,
    'a-active',
    'a-bg-2',
    'b-active',
    'b-bg-2'
  ]
};
const SCOPED_SHIFT_PROTECTED = {
  'discard-window': 'p-right-far',
  'discard-rights': 'p-right-far',
  'discard-lefts': 'p-left-far',
  'discard-other-windows': 'a-active',
  'discard-tabs': 'p-right-far'
};
const ROTATED_OTHER_WINDOW_KEEPERS = ['a-bg-1', 'b-bg-1'];
const RELEASE_SPECS = {
  'release-window': PRIMARY_BACKGROUND,
  'release-rights': ['p-right-near', 'p-right-mid', 'p-right-far'],
  'release-lefts': ['p-left-far', 'p-left-near'],
  'release-other-windows': OTHER_BACKGROUND,
  'release-tabs': ALL_BACKGROUND
};
const RELEASE_AVAILABILITY_AFTER = {
  'release-window': {
    'release-window': false,
    'release-lefts': false,
    'release-rights': false,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-rights': {
    'release-window': true,
    'release-lefts': true,
    'release-rights': false,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-lefts': {
    'release-window': true,
    'release-lefts': false,
    'release-rights': true,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-other-windows': {
    'release-window': true,
    'release-lefts': true,
    'release-rights': true,
    'release-other-windows': false,
    'release-tabs': true
  },
  'release-tabs': {
    'release-window': false,
    'release-lefts': false,
    'release-rights': false,
    'release-other-windows': false,
    'release-tabs': false
  }
};
const POPUP_COMMANDS = [
  'discard-tab',
  'discard-tree',
  ...Object.keys(DISCARD_SPECS),
  ...Object.keys(RELEASE_SPECS)
];

const minimalPdf = () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 46 >>\nstream\nBT /F1 18 Tf 36 72 Td (ATD PDF fixture) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
};
const PDF_FIXTURE = minimalPdf();

const startFixtureServer = async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.svg') {
      response.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'image/svg+xml'
      });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="6" fill="#3267d6"/>' +
        '<circle cx="16" cy="16" r="7" fill="#fff"/></svg>');
      return;
    }
    if (url.pathname === '/document.pdf') {
      response.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Disposition': 'inline; filename="atd-e2e.pdf"',
        'Content-Length': PDF_FIXTURE.length,
        'Content-Type': 'application/pdf'
      });
      response.end(PDF_FIXTURE);
      return;
    }
    if (url.pathname !== '/tab') {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('not found');
      return;
    }

    const id = url.searchParams.get('id') || 'unknown';
    const mb = Number(url.searchParams.get('mb') || 0);
    const ordinal = requests.filter(entry => entry.id === id).length + 1;
    const holdReload = Number(url.searchParams.get('holdReload') || 0);
    const entry = {
      aborted: false,
      at: Date.now(),
      closedAt: undefined,
      finishedAt: undefined,
      heldUntil: undefined,
      id,
      ordinal,
      path: request.url,
      writableFinished: false
    };
    requests.push(entry);
    let finishTimer;
    request.on('aborted', () => entry.aborted = true);
    response.on('finish', () => {
      entry.finishedAt = Date.now();
      entry.writableFinished = response.writableFinished;
    });
    response.on('close', () => {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = undefined;
      }
      entry.closedAt = Date.now();
      entry.writableFinished = response.writableFinished;
    });
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'text/html; charset=utf-8',
      'Pragma': 'no-cache'
    });
    response.write(`<!doctype html>
<meta charset="utf-8">
<title>ATD E2E ${id}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?id=${encodeURIComponent(id)}">
<body data-id="${id}">ATD E2E ${id}</body>
<script>
  const key = 'atd-e2e-loads-${id}';
  const loads = Number(localStorage.getItem(key) || 0) + 1;
  localStorage.setItem(key, String(loads));
  document.title = 'ATD E2E ${id} loads=' + loads;
  const memory = new Uint8Array(${mb} * 1024 * 1024);
  for (let i = 0; i < memory.length; i += 4096) memory[i] = (i / 4096) % 251;
  globalThis.__atdE2EMemory = memory;
  globalThis.__atdE2ELoads = loads;
</script>`);
    const finish = () => {
      if (!response.destroyed && !response.writableEnded) {
        response.end('\n<!-- complete -->');
      }
    };
    if (ordinal > 1 && holdReload > 0) {
      entry.heldUntil = Date.now() + holdReload;
      finishTimer = setTimeout(() => {
        finishTimer = undefined;
        finish();
      }, holdReload);
      finishTimer.unref?.();
    }
    else {
      finish();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    count(id) {
      return requests.filter(entry => entry.id === id).length;
    },
    entries(id) {
      return requests.filter(entry => entry.id === id);
    },
    requests,
    stop: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
};

const launchOverCDP = async ({edgePrivacy, executablePath, extensionPath, profile}) => {
  const {chromium} = require('./playwright-runtime.cjs');
  const disabledFeatures = ['OptimizationHints', 'MediaRouter'];
  if (edgePrivacy) {
    disabledFeatures.push('msImplicitSignin', 'msM365LinksImplicitSignin');
  }
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-mode',
    `--disable-features=${disabledFeatures.join(',')}`,
    '--window-position=20,20',
    'about:blank'
  ];
  if (edgePrivacy) {
    args.splice(-2, 0, '--disable-background-networking');
  }
  const browserProcess = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  });
  emergencyBrowserProcess = browserProcess;
  let stderr = '';
  let spawnError;
  browserProcess.once('error', error => spawnError = error);
  browserProcess.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-256 * 1024);
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  try {
    const port = await waitFor(() => {
      if (spawnError) {
        throw spawnError;
      }
      if (browserProcess.exitCode !== null) {
        const details = edgePrivacy ? 'Edge stderr suppressed for identity privacy' : stderr;
        throw Error(`browser exited before CDP was ready (${browserProcess.exitCode}): ${details}`);
      }
      if (!fs.existsSync(portFile)) {
        return false;
      }
      const [value] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      return Number(value) || false;
    }, 'browser DevTools port', 15000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw Error('CDP browser did not expose its default context');
    }
    return {browser, browserProcess, context, stderr: () => stderr};
  }
  catch (error) {
    error.processCleanup = await terminateBrowserProcess(browserProcess);
    throw error;
  }
};

const findCrashDumps = root => {
  const found = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) {
      return;
    }
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      }
      else if (entry.name.toLowerCase().endsWith('.dmp')) {
        const stat = fs.statSync(target);
        found.push({size: stat.size, updatedAt: stat.mtimeMs});
      }
    }
  };
  visit(root);
  return found;
};

const hashDirectory = root => {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      }
      else if (entry.isFile()) {
        files.push(target);
      }
    }
  };
  visit(root);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
};

const sampleMemory = async cdp => {
  let processInfo;
  try {
    ({processInfo = []} = await cdp.send('SystemInfo.getProcessInfo'));
  }
  catch (error) {
    return {available: false, error: `CDP process query failed: ${error.message}`};
  }
  const pids = processInfo.map(info => Number(info.id)).filter(Number.isInteger);
  if (process.platform !== 'win32') {
    return {available: false, error: 'OS memory sampling is implemented for Windows only', processInfo};
  }
  if (pids.length === 0) {
    return {available: false, error: 'CDP returned no browser process IDs', processInfo};
  }
  // A renderer can exit between the CDP snapshot and the OS query. Filtering a
  // full process snapshot avoids Get-Process -Id treating that normal race as
  // a failed sample.
  const command = `$ids=@(${pids.join(',')}); Get-Process | Where-Object { $ids -contains $_.Id } | ` +
    'Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress';
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(powershell)) {
    return {available: false, error: `PowerShell not found: ${powershell}`, processInfo};
  }
  const outcome = spawnSync(powershell, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  if (outcome.error || outcome.status !== 0) {
    return {
      available: false,
      error: outcome.error?.message || outcome.stderr?.trim() || `PowerShell exited ${outcome.status}`,
      processInfo
    };
  }
  let processes = [];
  try {
    const parsed = outcome.stdout.trim() ? JSON.parse(outcome.stdout) : [];
    processes = Array.isArray(parsed) ? parsed : [parsed];
  }
  catch (error) {
    return {available: false, error: `Cannot parse PowerShell memory sample: ${error.message}`, processInfo};
  }
  if (processes.length === 0) {
    return {available: false, error: 'No CDP browser processes remained in the OS snapshot', processInfo};
  }
  return {
    available: true,
    privateBytes: processes.reduce((sum, process) => sum + Number(process.PrivateMemorySize64 || 0), 0),
    processInfo,
    processes,
    workingSetBytes: processes.reduce((sum, process) => sum + Number(process.WorkingSet64 || 0), 0)
  };
};

const resolveNativeMenuBrowserProcessId = async cdp => {
  let processInfo;
  try {
    ({processInfo = []} = await cdp.send('SystemInfo.getProcessInfo'));
  }
  catch {
    throw Error('CDP browser process scope is unavailable');
  }
  const browserProcessIds = [...new Set(processInfo
    .filter(info => info?.type === 'browser')
    .map(info => Number(info.id))
    .filter(id => Number.isInteger(id) && id > 0))];
  if (browserProcessIds.length !== 1) {
    throw Error('CDP browser process scope is missing or ambiguous');
  }
  return browserProcessIds[0];
};

const browserSnapshot = (driver, ids) => driver.evaluate(async tabIds => {
  const tabs = [];
  for (const id of tabIds) {
    try {
      tabs.push(await chrome.tabs.get(id));
    }
    catch (error) {
      tabs.push({id, missing: true, error: error.message});
    }
  }
  const stored = await chrome.storage.session.get(null);
  const prefix = '__discardOwnership:tab:';
  const ownership = Object.fromEntries(Object.entries(stored)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value?.marker]));
  return {ownership, tabs};
}, ids);

const main = async () => {
  const executableArg = arg('executable');
  if (!executableArg) {
    throw Error('Pass --executable <isolated Chrome-for-Testing executable>; this harness never defaults to Edge');
  }
  const executablePath = path.resolve(executableArg);
  const allowEdge = process.argv.includes('--allow-edge');
  const retainProfile = process.argv.includes('--retain-profile');
  if (path.basename(executablePath).toLowerCase() === 'msedge.exe' &&
      allowEdge === false) {
    throw Error('Refusing to launch Edge without the explicit --allow-edge safety flag');
  }
  const extensionPath = path.resolve(arg('extension', path.join(__dirname, '..', 'v3')));
  const profileRoot = path.resolve(arg('profile-root', path.join(__dirname, '.profiles')));
  const resultsRoot = path.resolve(arg('results', path.join(__dirname, 'results')));
  const runId = `matrix-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const profile = path.join(profileRoot, runId);
  const resultPath = path.join(resultsRoot, `${runId}.json`);
  for (const [label, target] of [['browser executable', executablePath], ['extension', extensionPath]]) {
    if (!fs.existsSync(target)) {
      throw Error(`${label} does not exist: ${target}`);
    }
  }
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});
  const extensionMetadata = {
    treeSha256: hashDirectory(extensionPath),
    version: JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8')).version
  };
  const persistEarlyFailureReport = ({cleanup, crashes, error, fixtureRequests, phase}) => {
    const earlyReport = createEarlyFailureReport({
      browserFamily: allowEdge ? 'edge' : 'chromium',
      cleanup,
      crashes,
      error,
      extension: extensionMetadata,
      fixtureRequests,
      phase
    });
    fs.writeFileSync(resultPath, `${JSON.stringify(earlyReport, null, 2)}\n`);
  };
  const restrictedFilePath = path.join(profile, 'restricted-file.html');
  fs.writeFileSync(restrictedFilePath, '<!doctype html><meta charset="utf-8">' +
    '<title>ATD restricted file fixture</title><body>ATD restricted file fixture</body>', 'utf8');
  const restrictedFileUrl = pathToFileURL(restrictedFilePath).href;
  const removeIsolatedProfile = () => {
    fs.rmSync(profile, {force: true, maxRetries: 3, recursive: true, retryDelay: 250});
    if (fs.existsSync(profile)) {
      throw Error('profile directory still exists after removal');
    }
  };
  const cleanupEarlyFailure = error => {
    if (retainProfile) {
      return {explicit: true, removed: false, retained: true};
    }
    try {
      removeIsolatedProfile();
      return {removed: true, retained: false};
    }
    catch (cleanupError) {
      error.message += `\nIsolated profile cleanup also failed: ${cleanupError.message}`;
      return {
        reasonCode: publicFailureReason(cleanupError),
        removed: false,
        retained: fs.existsSync(profile)
      };
    }
  };

  let fixture;
  try {
    fixture = await startFixtureServer();
  }
  catch (error) {
    const crashes = findCrashDumps(profile);
    const profileCleanup = cleanupEarlyFailure(error);
    persistEarlyFailureReport({
      cleanup: {
        fixture: {status: 'not-started'},
        process: {status: 'not-started'},
        profile: profileCleanup
      },
      crashes,
      error,
      fixtureRequests: [],
      phase: 'startup'
    });
    throw error;
  }
  let launched;
  try {
    launched = await launchOverCDP({
      edgePrivacy: allowEdge,
      executablePath,
      extensionPath,
      profile
    });
  }
  catch (error) {
    const fixtureCleanup = await settleWithin(fixture.stop(), 5000);
    const crashes = findCrashDumps(profile);
    const profileCleanup = cleanupEarlyFailure(error);
    persistEarlyFailureReport({
      cleanup: {
        fixture: fixtureCleanup,
        process: error.processCleanup || {exited: false},
        profile: profileCleanup
      },
      crashes,
      error,
      fixtureRequests: fixture.requests,
      phase: 'browser-launch'
    });
    throw error;
  }
  const {browser, browserProcess, context} = launched;
  let cdp;
  let nativeMenuBrowserProcessId;
  try {
    cdp = await browser.newBrowserCDPSession();
    nativeMenuBrowserProcessId = await resolveNativeMenuBrowserProcessId(cdp);
  }
  catch (error) {
    const detach = cdp ? await settleWithin(cdp.detach(), 3000) : {status: 'not-started'};
    const close = await settleWithin(browser.close(), 5000);
    const processCleanup = await terminateBrowserProcess(browserProcess);
    const fixtureCleanup = await settleWithin(fixture.stop(), 5000);
    const crashes = findCrashDumps(profile);
    const profileCleanup = cleanupEarlyFailure(error);
    persistEarlyFailureReport({
      cleanup: {
        browser: close,
        cdp: detach,
        fixture: fixtureCleanup,
        process: processCleanup,
        profile: profileCleanup
      },
      crashes,
      error,
      fixtureRequests: fixture.requests,
      phase: 'cdp-attach'
    });
    throw error;
  }
  const timeline = [];
  const scenarios = [];
  const memory = [];
  let report;
  let driver;
  let extensionId;
  let manifest;
  let driverWindowId;
  let driverTabId;
  let lastNativeMenuDiagnostics;
  let scenarioSequence = 0;
  let runError;
  const telemetryToken = `${runId}-${crypto.randomUUID()}`;
  const replacementIds = new Map();
  const lineageById = new Map();
  const trackedLayouts = new Set();
  const persistReport = () => {
    fs.writeFileSync(resultPath, `${JSON.stringify(sanitizePopupReport(report), null, 2)}\n`);
  };

  const resolveTabId = id => {
    const visited = [];
    const seen = new Set();
    let current = id;
    while (replacementIds.has(current) && !seen.has(current)) {
      seen.add(current);
      visited.push(current);
      current = replacementIds.get(current);
    }
    for (const previous of visited) {
      replacementIds.set(previous, current);
    }
    return current;
  };
  const lineageFor = id => lineageById.get(id) || new Set([id]);
  const syncLayoutLineage = layout => {
    for (const tab of Object.values(layout.tabs)) {
      const current = resolveTabId(tab.id);
      tab.idHistory ||= [tab.id];
      if (!tab.idHistory.includes(current)) {
        tab.idHistory.push(current);
      }
      tab.id = current;
    }
    layout.selectedId = resolveTabId(layout.selectedId);
    return layout;
  };
  const trackLayout = layout => {
    syncLayoutLineage(layout);
    trackedLayouts.add(layout);
    return layout;
  };
  const recordTabReplacement = (addedId, removedId) => {
    const lineage = new Set([
      ...lineageFor(removedId),
      ...lineageFor(addedId),
      removedId,
      addedId
    ]);
    replacementIds.set(removedId, addedId);
    for (const id of lineage) {
      lineageById.set(id, lineage);
    }
    for (const layout of trackedLayouts) {
      for (const tab of Object.values(layout.tabs)) {
        if (tab.id === removedId) {
          tab.idHistory ||= [removedId];
          if (!tab.idHistory.includes(addedId)) {
            tab.idHistory.push(addedId);
          }
          tab.id = addedId;
        }
      }
      if (layout.selectedId === removedId) {
        layout.selectedId = addedId;
      }
    }
    if (driverTabId === removedId) {
      driverTabId = addedId;
    }
  };

  const writeReport = (ok, error) => {
    report = {
      browser: {family: allowEdge ? 'edge' : 'chromium', version: browser.version()},
      crashes: findCrashDumps(profile),
      error: error ? {
        nativeMenu: error.nativeMenuDiagnostics || lastNativeMenuDiagnostics,
        reasonCode: publicFailureReason(error)
      } : undefined,
      extension: extensionId ? {
        treeSha256: hashDirectory(extensionPath),
        version: manifest?.version
      } : undefined,
      fixtureRequests: fixture.requests,
      memory,
      ok,
      reportFormat: 'sanitized-v1',
      scenarios,
      timeline
    };
    persistReport();
  };

  try {
    const worker = await waitFor(async () => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')), 'extension service worker', 15000);
    extensionId = new URL(worker.url()).host;
    manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/data/options/index.html`);
    await context.exposeBinding('__atdEmit', (source, event) => {
      if (event?.event === 'tabs.onReplaced') {
        recordTabReplacement(event.addedId, event.removedId);
      }
      timeline.push({...event, receivedAt: Date.now()});
    });
    await driver.evaluate(async token => {
      globalThis.__atdE2ETelemetryToken = token;
      await chrome.storage.local.set({
        favicon: true,
        'favicon-delay': 100,
        log: false,
        number: 0,
        period: 86400,
        prepends: '💤'
      });
      const current = await chrome.tabs.getCurrent();
      await chrome.tabs.update(current.id, {autoDiscardable: false, pinned: true});
      if (!globalThis.__atdTelemetryInstalled) {
        globalThis.__atdTelemetryInstalled = true;
        const compactTab = tab => tab && ({
          active: tab.active,
          discarded: tab.discarded,
          groupId: tab.groupId,
          id: tab.id,
          index: tab.index,
          status: tab.status,
          url: tab.url,
          windowId: tab.windowId
        });
        globalThis.__atdTelemetrySequence = 0;
        globalThis.__atdTelemetryPending = new Set();
        const emit = event => {
          const delivery = globalThis.__atdEmit({
            at: Date.now(),
            performanceAt: performance.now(),
            telemetrySequence: ++globalThis.__atdTelemetrySequence,
            ...event
          }).catch(() => {});
          globalThis.__atdTelemetryPending.add(delivery);
          delivery.finally(() => globalThis.__atdTelemetryPending.delete(delivery));
          return delivery;
        };
        globalThis.__atdFlushTelemetry = async () => {
          // Drain deliveries already created, then yield once so queued Chrome
          // events can enter their listeners and drain those deliveries too.
          for (let pass = 0; pass < 20; pass += 1) {
            const pending = [...globalThis.__atdTelemetryPending];
            if (pending.length) {
              await Promise.allSettled(pending);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            if (globalThis.__atdTelemetryPending.size === 0) {
              return globalThis.__atdTelemetrySequence;
            }
          }
          throw Error('telemetry delivery queue did not drain');
        };
        chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => emit({
          changeInfo,
          event: 'tabs.onUpdated',
          id,
          tab: compactTab(tab)
        }));
        chrome.tabs.onActivated.addListener(activeInfo => emit({event: 'tabs.onActivated', activeInfo}));
        chrome.tabs.onRemoved.addListener((id, removeInfo) => emit({event: 'tabs.onRemoved', id, removeInfo}));
        chrome.tabs.onReplaced.addListener((addedId, removedId) => emit({
          addedId,
          event: 'tabs.onReplaced',
          removedId
        }));
        chrome.storage.onChanged.addListener((changes, areaName) => {
          for (const [key, value] of Object.entries(changes)) {
            if (key === '__discardOwnership' || key.startsWith('__discardOwnership:tab:')) {
              emit({
                areaName,
                event: 'storage.ownership',
                key,
                value
              });
            }
          }
        });
        chrome.runtime.onMessage.addListener(request => {
          const api = request?.__atdE2EApiTelemetry;
          if (api?.token === globalThis.__atdE2ETelemetryToken) {
            emit(api);
          }
        });
      }
      return current;
    }, telemetryToken);
    const driverTab = await driver.evaluate(() => chrome.tabs.getCurrent());
    driverWindowId = driverTab.windowId;
    driverTabId = driverTab.id;

    const ensureDriver = async () => {
      if (!driver || driver.isClosed()) {
        driver = await context.newPage();
        await driver.goto(`chrome-extension://${extensionId}/data/options/index.html`);
      }
      return driver;
    };
    const currentWorker = () => waitFor(async () => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')), 'live extension service worker', 10000);
    const installWorkerApiTelemetry = async () => {
      const workerNow = await currentWorker();
      const installed = await workerNow.evaluate(token => {
        if (globalThis.__atdE2EApiTelemetry?.token === token) {
          return globalThis.__atdE2EApiTelemetry.status;
        }

        const instance = crypto.randomUUID();
        let apiSequence = 0;
        let operationSequence = 0;
        const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
        const originalDiscard = chrome.tabs.discard.bind(chrome.tabs);
        const record = event => {
          const value = {
            apiSequence: ++apiSequence,
            apiAt: Date.now(),
            token,
            workerInstance: instance,
            ...event
          };
          try {
            chrome.runtime.sendMessage({__atdE2EApiTelemetry: value}, () => chrome.runtime.lastError);
          }
          catch (error) {}
          return value;
        };

        const hookedExecuteScript = details => {
          const stopScript = details?.injectImmediately === true &&
            details.target?.allFrames !== true && typeof details.func === 'function';
          if (!stopScript) {
            return originalExecuteScript(details);
          }
          const operationId = `${instance}:stop:${++operationSequence}`;
          record({
            event: 'api.scripting.stop-call',
            id: details.target?.tabId,
            operationId
          });
          let operation;
          try {
            operation = originalExecuteScript(details);
          }
          catch (error) {
            record({
              error: error?.message || String(error),
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          }
          return Promise.resolve(operation).then(result => {
            record({
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'fulfilled'
            });
            return result;
          }, error => {
            record({
              error: error?.message || String(error),
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          });
        };

        const hookedDiscard = (...args) => {
          const id = args[0];
          const operationId = `${instance}:discard:${++operationSequence}`;
          record({event: 'api.tabs.discard-call', id, operationId});
          const callbackIndex = args.findLastIndex(value => typeof value === 'function');
          if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = function(...callbackArgs) {
              // Preserve runtime.lastError for production code by invoking its
              // callback before making another extension API call.
              const result = callback.apply(this, callbackArgs);
              record({event: 'api.tabs.discard-complete', id, operationId});
              return result;
            };
          }
          let operation;
          try {
            operation = originalDiscard(...args);
          }
          catch (error) {
            record({
              error: error?.message || String(error),
              event: 'api.tabs.discard-complete',
              id,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          }
          if (callbackIndex < 0 && operation?.then) {
            return operation.then(result => {
              record({event: 'api.tabs.discard-complete', id, operationId, outcome: 'fulfilled'});
              return result;
            }, error => {
              record({
                error: error?.message || String(error),
                event: 'api.tabs.discard-complete',
                id,
                operationId,
                outcome: 'rejected'
              });
              throw error;
            });
          }
          return operation;
        };

        chrome.scripting.executeScript = hookedExecuteScript;
        chrome.tabs.discard = hookedDiscard;
        const status = {
          discard: chrome.tabs.discard === hookedDiscard,
          executeScript: chrome.scripting.executeScript === hookedExecuteScript,
          instance
        };
        globalThis.__atdE2EApiTelemetry = {status, token};
        return status;
      }, telemetryToken);
      assert.equal(installed.executeScript, true, 'service-worker executeScript telemetry hook must install');
      assert.equal(installed.discard, true, 'service-worker tabs.discard telemetry hook must install');
      return installed;
    };
    const flushTelemetry = async () => {
      await ensureDriver();
      return driver.evaluate(async () => {
        if (typeof globalThis.__atdFlushTelemetry !== 'function') {
          throw Error('persistent telemetry page is not initialized');
        }
        // Two drains put both queued Chrome event tasks and their exposed-
        // binding deliveries behind this synchronization point.
        await globalThis.__atdFlushTelemetry();
        await new Promise(resolve => setTimeout(resolve, 0));
        return globalThis.__atdFlushTelemetry();
      });
    };
    const telemetryCheckpoint = async () => ({
      at: Date.now(),
      sequence: await flushTelemetry()
    });
    const telemetrySince = async checkpoint => {
      await flushTelemetry();
      return timeline.filter(event => event.telemetrySequence > checkpoint.sequence &&
        (!event.at || event.at >= checkpoint.at));
    };
    const readSnapshot = ids => browserSnapshot(driver, ids);
    const assertNoCrashes = label => {
      const dumps = findCrashDumps(profile);
      assert.deepEqual(dumps, [], `${label} must not create a browser crash dump`);
    };
    const recordMemory = async label => {
      const sample = {at: Date.now(), label, ...await sampleMemory(cdp)};
      memory.push(sample);
      assert.equal(sample.available, true, `${label}: ${sample.error || 'memory sample unavailable'}`);
      return sample;
    };

    const reset = async () => {
      driver = await ensureDriver();
      driverTabId = resolveTabId(driverTabId);
      const state = await driver.evaluate(async ({keepTabId, keepWindowId}) => {
        const windows = await chrome.windows.getAll({populate: true});
        for (const window of windows) {
          if (window.id !== keepWindowId) {
            await chrome.windows.remove(window.id).catch(() => {});
          }
        }
        const tabs = await chrome.tabs.query({windowId: keepWindowId});
        const removable = tabs.filter(tab => tab.id !== keepTabId).map(tab => tab.id);
        if (removable.length) {
          await chrome.tabs.remove(removable);
        }
        await chrome.tabs.update(keepTabId, {active: true, autoDiscardable: false, pinned: true});
        await chrome.windows.update(keepWindowId, {focused: true});
        return {removable};
      }, {keepTabId: driverTabId, keepWindowId: driverWindowId});
      await waitFor(async () => {
        const snapshot = await readSnapshot([]);
        return Object.keys(snapshot.ownership).length === 0;
      }, `ownership cleanup after removing ${state.removable.length} tabs`, 15000);
      trackedLayouts.clear();
    };

    const fixtureUrl = (prefix, key, {holdReload = 0, mb = 4} = {}) => {
      const label = `${prefix}-${key}`;
      return {
        key,
        label,
        url: `${fixture.baseUrl}/tab?id=${encodeURIComponent(label)}&mb=${mb}` +
          (holdReload ? `&holdReload=${holdReload}` : '')
      };
    };

    const createWindow = async (entries, activeKey) => {
      const created = await driver.evaluate(async ({items, selectedKey}) => {
        const window = await chrome.windows.create({focused: false, url: items[0].url});
        const tabs = {[items[0].key]: window.tabs[0]};
        for (const item of items.slice(1)) {
          tabs[item.key] = await chrome.tabs.create({
            active: false,
            url: item.url,
            windowId: window.id
          });
        }
        await chrome.tabs.update(tabs[selectedKey].id, {active: true});
        return {tabs, windowId: window.id};
      }, {items: entries, selectedKey: activeKey});
      const ids = Object.values(created.tabs).map(tab => tab.id);
      await waitFor(async () => {
        const snapshot = await readSnapshot(ids);
        return snapshot.tabs.every(tab => tab.status === 'complete' && tab.discarded === false);
      }, `${entries.map(entry => entry.key).join(', ')} to load`, 20000);
      return created;
    };

    const mergeWindow = (layout, window, entries) => {
      layout.windowIds.push(window.windowId);
      for (const entry of entries) {
        layout.tabs[entry.key] = {
          ...window.tabs[entry.key],
          idHistory: [window.tabs[entry.key].id],
          key: entry.key,
          label: entry.label,
          url: entry.url
        };
      }
    };

    const focusSelected = async layout => {
      syncLayoutLineage(layout);
      await driver.evaluate(async ({id, windowId}) => {
        await chrome.tabs.update(id, {active: true});
        await chrome.windows.update(windowId, {focused: true});
      }, {id: layout.selectedId, windowId: layout.primaryWindowId});
      const workerNow = await currentWorker();
      const current = await workerNow.evaluate(async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const window = await chrome.windows.getLastFocused();
        return {tab, windowId: window.id};
      });
      assert.equal(current.windowId, layout.primaryWindowId, 'fixture primary window must be last focused');
      assert.equal(current.tab?.id, layout.selectedId, 'worker currentWindow must resolve to the selected fixture tab');
    };

    const buildDirect = async prefix => {
      await reset();
      const entries = [
        fixtureUrl(prefix, 'd-keeper-near'),
        fixtureUrl(prefix, 'd-selected', {mb: 16}),
        fixtureUrl(prefix, 'd-decoy'),
        fixtureUrl(prefix, 'd-keeper-far')
      ];
      const primary = await createWindow(entries, 'd-selected');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, entries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['d-selected'].id;
      trackLayout(layout);
      await focusSelected(layout);
      return layout;
    };

    const buildGroup = async (prefix, {slowExternal = false} = {}) => {
      await reset();
      const entries = [
        fixtureUrl(prefix, 'g-keeper'),
        fixtureUrl(prefix, 'g-selected', {mb: 16}),
        fixtureUrl(prefix, 'g-loaded', {mb: 16}),
        fixtureUrl(prefix, 'g-external', {holdReload: slowExternal ? 10000 : 0, mb: 24}),
        fixtureUrl(prefix, 'g-out-loaded'),
        fixtureUrl(prefix, 'g-out-external')
      ];
      const primary = await createWindow(entries, 'g-selected');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, entries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['g-selected'].id;
      trackLayout(layout);
      const groups = await driver.evaluate(async ({inside, outside, windowId}) => ({
        inside: await chrome.tabs.group({tabIds: inside, createProperties: {windowId}}),
        outside: await chrome.tabs.group({tabIds: outside, createProperties: {windowId}})
      }), {
        inside: ['g-selected', 'g-loaded', 'g-external'].map(key => layout.tabs[key].id),
        outside: ['g-out-loaded', 'g-out-external'].map(key => layout.tabs[key].id),
        windowId: layout.primaryWindowId
      });
      layout.groupIds = groups;
      const highlightState = await driver.evaluate(async ({outsideId, selectedId, windowId}) => {
        const tabs = await chrome.tabs.query({windowId});
        const outside = tabs.find(tab => tab.id === outsideId);
        const selected = tabs.find(tab => tab.id === selectedId);
        // Chromium activates the first listed index while keeping the full
        // list highlighted. Put the selected group tab first so the outsider
        // remains a genuine highlighted decoy without changing the command root.
        await chrome.tabs.highlight({windowId, tabs: [selected.index, outside.index]});
        return chrome.tabs.query({windowId});
      }, {
        outsideId: layout.tabs['g-out-loaded'].id,
        selectedId: layout.selectedId,
        windowId: layout.primaryWindowId
      });
      assert.equal(highlightState.find(tab => tab.id === layout.selectedId)?.highlighted, true,
        'selected group tab must be highlighted');
      assert.equal(highlightState.find(tab => tab.id === layout.tabs['g-out-loaded'].id)?.highlighted, true,
        'out-of-group decoy must be highlighted');
      await focusSelected(layout);
      await externalDiscard(layout, ['g-external', 'g-out-external']);
      return layout;
    };

    const buildScoped = async (prefix, {holdKeys = new Set()} = {}) => {
      await reset();
      const make = key => fixtureUrl(prefix, key, {
        holdReload: holdKeys.has(key) ? 10000 : 0,
        mb: holdKeys.has(key) ? 24 : 4
      });
      const primaryEntries = [
        make('p-left-far'),
        make('p-left-near'),
        make('p-selected'),
        make('p-right-near'),
        make('p-right-mid'),
        make('p-right-far')
      ];
      const aEntries = [make('a-active'), make('a-bg-1'), make('a-bg-2')];
      const bEntries = [make('b-active'), make('b-bg-1'), make('b-bg-2')];
      const primary = await createWindow(primaryEntries, 'p-selected');
      const a = await createWindow(aEntries, 'a-active');
      const b = await createWindow(bEntries, 'b-active');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, primaryEntries);
      mergeWindow(layout, a, aEntries);
      mergeWindow(layout, b, bEntries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['p-selected'].id;
      trackLayout(layout);
      await focusSelected(layout);
      return layout;
    };

    const restrictedCreationCode = message => {
      const value = String(message || '');
      if (/not allowed|cannot access|blocked|disallowed|unsafe/i.test(value)) {
        return 'browser-policy-rejected';
      }
      if (/invalid|malformed|unsupported/i.test(value)) {
        return 'browser-url-rejected';
      }
      return 'tabs-create-rejected';
    };
    const buildRestrictedScope = async prefix => {
      await reset();
      const selectedEntry = fixtureUrl(prefix, 'restricted-keeper');
      const primary = await createWindow([selectedEntry], selectedEntry.key);
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, [selectedEntry]);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs[selectedEntry.key].id;

      const specifications = [{
        expectedProtocols: ['file:'],
        key: 'restricted-file',
        scheme: 'file',
        url: restrictedFileUrl
      }, {
        expectedProtocols: ['data:'],
        key: 'restricted-data',
        scheme: 'data',
        url: 'data:text/html;charset=utf-8,%3Ctitle%3EATD%20data%20fixture%3C%2Ftitle%3EATD'
      }, {
        expectedProtocols: ['http:', 'chrome-extension:', 'edge-extension:'],
        key: 'restricted-pdf',
        scheme: 'pdf',
        url: `${fixture.baseUrl}/document.pdf?case=${encodeURIComponent(prefix)}`
      }, {
        expectedProtocols: allowEdge ? ['edge:', 'chrome:'] : ['chrome:'],
        key: 'restricted-internal',
        scheme: 'internal',
        url: allowEdge ? 'edge://version/' : 'chrome://version/'
      }, {
        expectedProtocols: ['chrome-extension:', 'edge-extension:'],
        key: 'restricted-extension',
        scheme: 'extension',
        url: `chrome-extension://${extensionId}/data/options/index.html#restricted-${prefix}`
      }];
      const capabilities = [];

      for (const specification of specifications) {
        const creation = await driver.evaluate(async ({url, windowId}) => {
          try {
            const tab = await chrome.tabs.create({active: false, url, windowId});
            return {ok: true, tab};
          }
          catch (error) {
            return {message: error?.message || String(error), ok: false};
          }
        }, {url: specification.url, windowId: primary.windowId});
        if (creation?.ok !== true || !Number.isInteger(creation.tab?.id)) {
          capabilities.push({
            availability: 'unavailable',
            creation: 'rejected',
            reasonCode: restrictedCreationCode(creation?.message),
            scheme: specification.scheme
          });
          continue;
        }

        let current = creation.tab;
        try {
          current = await waitFor(async () => {
            const value = await driver.evaluate(id => chrome.tabs.get(id).catch(() => undefined), creation.tab.id);
            return value && value.status !== 'loading' ? value : false;
          }, `${specification.scheme} restricted fixture to settle`, 10000, 100);
        }
        catch (error) {
          current = await driver.evaluate(id => chrome.tabs.get(id).catch(() => undefined), creation.tab.id);
          if (current) {
            await driver.evaluate(id => chrome.tabs.remove(id).catch(() => {}), current.id);
          }
          capabilities.push({
            availability: 'unavailable',
            creation: 'created-but-not-ready',
            reasonCode: 'readiness-timeout',
            scheme: specification.scheme
          });
          continue;
        }
        if (!current) {
          capabilities.push({
            availability: 'unavailable',
            creation: 'created-then-removed',
            reasonCode: 'tab-disappeared',
            scheme: specification.scheme
          });
          continue;
        }

        const exposedUrl = current.url || current.pendingUrl || '';
        let observedProtocol = 'redacted';
        if (exposedUrl) {
          try {
            observedProtocol = new URL(exposedUrl).protocol.toLowerCase();
          }
          catch (error) {
            observedProtocol = 'invalid';
          }
        }
        if (observedProtocol !== 'redacted' &&
            specification.expectedProtocols.includes(observedProtocol) === false) {
          await driver.evaluate(id => chrome.tabs.remove(id).catch(() => {}), current.id);
          capabilities.push({
            availability: 'unavailable',
            creation: 'substituted',
            observedProtocol,
            reasonCode: 'requested-scheme-not-preserved',
            scheme: specification.scheme
          });
          continue;
        }

        layout.tabs[specification.key] = {
          ...current,
          idHistory: [current.id],
          key: specification.key,
          label: `${prefix}-${specification.key}`,
          url: specification.url
        };
        capabilities.push({
          availability: 'available',
          creation: 'created',
          key: specification.key,
          observedProtocol,
          readiness: 'ready',
          scheme: specification.scheme
        });
      }

      trackLayout(layout);
      await focusSelected(layout);
      const expectedIds = tabIds(layout).sort((left, right) => left - right);
      const actualIds = (await driver.evaluate(windowId => chrome.tabs.query({windowId}), primary.windowId))
        .map(tab => tab.id).sort((left, right) => left - right);
      assert.deepEqual(actualIds, expectedIds,
        'restricted-scheme setup must not leave a substituted or rejected tab outside the capability report');
      return {capabilities, layout};
    };

    function tabIds(layout, keys = Object.keys(layout.tabs)) {
      syncLayoutLineage(layout);
      return keys.map(key => layout.tabs[key].id);
    }
    const counts = (layout, keys = Object.keys(layout.tabs)) => Object.fromEntries(
      keys.map(key => [key, fixture.count(layout.tabs[key].label)])
    );
    const compactSnapshot = async layout => {
      await flushTelemetry();
      syncLayoutLineage(layout);
      const keys = Object.keys(layout.tabs);
      let snapshot = await readSnapshot(tabIds(layout, keys));
      if (snapshot.tabs.some(tab => tab.missing === true)) {
        await flushTelemetry();
        syncLayoutLineage(layout);
        snapshot = await readSnapshot(tabIds(layout, keys));
      }
      return {
        ownership: snapshot.ownership,
        tabs: Object.fromEntries(keys.map((key, index) => [key, snapshot.tabs[index]]))
      };
    };
    const outcomeForTabLineage = (outcomes, tab) => {
      const ids = [...new Set([...(tab.idHistory || []), tab.id])].reverse();
      return ids.map(id => outcomes[String(id)]).find(Boolean);
    };
    const assertOwnershipKeys = (snapshot, layout, expectedKeys, label) => {
      const expectedIds = [...new Set(expectedKeys.map(key => String(layout.tabs[key].id)))].sort();
      const actualIds = Object.keys(snapshot.ownership).sort();
      assert.deepEqual(actualIds, expectedIds, `${label}: ownership keys must match the exact fixture scope`);
      for (const id of expectedIds) {
        assert.equal(snapshot.ownership[id]?.state, 'owned', `${label}: marker ${id} must be settled owned state`);
      }
    };
    const sleepVisual = tab => ({
      favicon: tab.favIconUrl || '',
      title: tab.title || ''
    });
    const assertSleepVisual = (tab, marker, label) => {
      const visual = sleepVisual(tab);
      assert.match(visual.title, /^💤\s/, `${label}: sleep title prefix is missing`);
      assert.equal((visual.title.match(/💤\s/g) || []).length, 1,
        `${label}: sleep title prefix must appear exactly once`);
      assert.equal(marker?.visual?.favicon, true,
        `${label}: ownership marker must confirm favicon preparation`);
      assert.equal(marker?.visual?.title, true,
        `${label}: ownership marker must confirm title preparation`);
      assert.equal(marker?.visual?.titleMarker, '\u{1F4A4}',
        `${label}: ownership marker must retain the configured title indicator`);
      assert.equal(marker?.visual?.complete, true,
        `${label}: ownership marker must confirm complete visual preparation`);
      return visual;
    };
    const assertFaviconOnlyVisual = (tab, marker, label) => {
      const visual = sleepVisual(tab);
      assert.doesNotMatch(visual.title, /^\u{1F4A4}\s/u,
        `${label}: favicon-only mode must not add the sleep title prefix`);
      assert.equal(marker?.visual?.title, true,
        `${label}: favicon-only ownership must confirm its no-title requirement`);
      assert.equal(marker?.visual?.titleMarker, undefined,
        `${label}: favicon-only ownership must not persist a title marker`);
      assert.equal(marker?.visual?.favicon, true,
        `${label}: favicon-only ownership must confirm favicon preparation`);
      assert.equal(marker?.visual?.complete, true,
        `${label}: favicon-only ownership must confirm complete visual preparation`);
      return visual;
    };
    const assertReleasedVisual = (tab, label) => {
      const visual = sleepVisual(tab);
      assert.doesNotMatch(visual.title, /^💤\s/, `${label}: stale sleep title survived release`);
      assert.doesNotMatch(visual.favicon, /^data:image\/png/i,
        `${label}: stale generated sleep favicon survived release`);
      assert.match(visual.favicon, /\/favicon\.svg(?:\?|$)/i,
        `${label}: fixture favicon was not restored after release`);
      return visual;
    };

    async function externalDiscard(layout, keys) {
      await focusSelected(layout);
      await driver.evaluate(ids => Promise.all(ids.map(id => new Promise(resolve => {
        chrome.tabs.discard(id, tab => {
          const error = chrome.runtime.lastError;
          resolve({error: error?.message, id, tab});
        });
      }))), tabIds(layout, keys));
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return keys.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'claimed');
      }, `external discards to become claimed: ${keys.join(', ')}`, 15000);
    }

    const openPopup = async layout => {
      await focusSelected(layout);
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = `chrome-extension://${extensionId}/data/popup/index.html#e2e-${nonce}`;
      const created = await driver.evaluate(({windowId, url}) => chrome.tabs.create({
        active: false,
        url,
        windowId
      }), {url, windowId: layout.primaryWindowId});
      const page = await waitFor(() => context.pages().find(candidate => candidate.url() === url),
        `popup test page ${nonce}`, 10000);
      await page.waitForSelector('[data-cmd="discard-tab"]');
      await page.waitForFunction(() =>
        document.querySelector('[data-cmd="discard-tab"]')?.textContent.trim().length > 0);
      await page.waitForFunction(({tabId, windowId}) =>
        document.documentElement.dataset.popupReady === 'true' &&
        document.documentElement.dataset.selectedTabId === String(tabId) &&
        document.documentElement.dataset.selectedWindowId === String(windowId), {
        tabId: layout.selectedId,
        windowId: layout.primaryWindowId
      });
      const hostWindow = await driver.evaluate(tabId => chrome.windows.create({
        focused: false,
        tabId,
        type: 'normal'
      }), created.id);
      assert.ok(Number.isInteger(hostWindow?.id) && hostWindow.id !== layout.primaryWindowId,
        'popup surrogate must move into a dedicated out-of-scope window');
      await waitFor(async () => {
        const host = await driver.evaluate(id => chrome.tabs.get(id).catch(() => undefined), created.id);
        return host?.active === true && host.windowId === hostWindow.id;
      }, `popup surrogate ${nonce} to become active out of scope`, 10000);
      return {created, hostWindowId: hostWindow.id, page};
    };

    const removePopup = async popup => {
      const lineage = [...lineageFor(popup.created.id)];
      const current = resolveTabId(popup.created.id);
      if (!lineage.includes(current)) {
        lineage.push(current);
      }
      const removeIndividually = ids => Promise.all(ids.map(id =>
        chrome.tabs.remove(id).catch(() => {})));
      await driver.evaluate(removeIndividually, lineage);
      await waitFor(async () => {
        const currentLineage = [...lineageFor(popup.created.id)];
        await driver.evaluate(removeIndividually, currentLineage);
        const snapshot = await readSnapshot(currentLineage);
        return snapshot.tabs.every(tab => tab.missing === true) &&
          currentLineage.every(id => snapshot.ownership[id] === undefined);
      }, `popup host ${popup.created.id} lineage removal and ownership cleanup`, 10000);
    };

    const auditPopup = async layout => {
      const popup = await openPopup(layout);
      try {
        for (const command of POPUP_COMMANDS) {
          assert.equal(await popup.page.locator(`[data-cmd="${command}"]`).count(), 1,
            `popup must expose exactly one ${command} control`);
        }
      }
      finally {
        await removePopup(popup);
      }
    };

    const inspectReleaseAvailability = async layout => {
      const popup = await openPopup(layout);
      try {
        await sleep(300);
        return Object.fromEntries(await Promise.all(Object.keys(RELEASE_SPECS).map(async command => [
          command,
          await popup.page.locator(`[data-cmd="${command}"]`).evaluate(element =>
            element.classList.contains('disabled') === false)
        ])));
      }
      finally {
        await removePopup(popup);
      }
    };

    const clickPopup = async (
      layout,
      command,
      shiftKey = false,
      {expectedStates = ['complete']} = {}
    ) => {
      const popup = await openPopup(layout);
      await focusSelected(layout);
      await installWorkerApiTelemetry();
      const responseToken = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const hooked = await popup.page.evaluate(token => {
        globalThis.__atdE2EResponseToken = token;
        if (globalThis.__atdE2ESendHooked) {
          return true;
        }
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        try {
          const hookedSend = (...args) => {
            const request = args.find(value => value && typeof value === 'object' && value.method);
            if (request?.method === 'popup') {
              globalThis.__atdEmit({
                at: Date.now(),
                event: 'popup-request',
                request: {
                  cmd: request.cmd,
                  method: request.method,
                  shiftKey: request.shiftKey === true
                },
                token: globalThis.__atdE2EResponseToken
              }).catch(() => {});
              const callbackIndex = args.findLastIndex(value => typeof value === 'function');
              const callback = callbackIndex >= 0 ? args[callbackIndex] : undefined;
              const wrapped = response => {
                const error = chrome.runtime.lastError?.message;
                globalThis.__atdE2EPopupResult = {
                  done: true,
                  error,
                  response
                };
                globalThis.__atdEmit({
                  at: Date.now(),
                  error,
                  event: 'popup-response',
                  response,
                  token: globalThis.__atdE2EResponseToken
                }).then(() => callback?.(response), () => callback?.(response));
              };
              if (callbackIndex >= 0) {
                args[callbackIndex] = wrapped;
              }
              else {
                args.push(wrapped);
              }
            }
            return original(...args);
          };
          chrome.runtime.sendMessage = hookedSend;
          globalThis.__atdE2ESendHooked = true;
          return chrome.runtime.sendMessage === hookedSend;
        }
        catch (error) {
          return false;
        }
      }, responseToken);
      assert.equal(hooked, true, `${command}: popup response hook must install`);
      const marker = {at: Date.now(), command, event: 'command-start', shiftKey};
      timeline.push(marker);
      let polling = true;
      const poll = (async () => {
        while (polling) {
          try {
            const snapshot = await compactSnapshot(layout);
            timeline.push({
              at: Date.now(),
              command,
              event: 'poll',
              shiftKey,
              tabs: Object.fromEntries(Object.entries(snapshot.tabs).map(([key, tab]) => [key, {
                active: tab.active,
                discarded: tab.discarded,
                id: tab.id,
                status: tab.status
              }]))
            });
          }
          catch (error) {
            timeline.push({at: Date.now(), command, error: error.message, event: 'poll-error', shiftKey});
          }
          await sleep(25);
        }
      })();
      let commandResult;
      try {
        await popup.page.locator(`[data-cmd="${command}"]`).click({
          modifiers: shiftKey ? ['Shift'] : []
        });
        const popupRequest = await waitFor(() => timeline.find(event =>
          event.event === 'popup-request' && event.token === responseToken),
        `${command} popup request`, 5000);
        assert.deepEqual(popupRequest.request, {
          cmd: command,
          method: 'popup',
          shiftKey
        }, `${command}: the real popup click must forward its modifier state`);
        const delivery = await waitFor(async () => {
          const outcome = timeline.find(event =>
            event.event === 'popup-response' && event.token === responseToken);
          if (outcome) {
            return {kind: 'response', outcome};
          }
          const host = await driver.evaluate(id => chrome.tabs.get(id).catch(() => undefined), popup.created.id);
          return !host || host.discarded === true ? {kind: 'host-discarded'} : undefined;
        }, `${command} popup response or in-scope host discard`, 30000);
        if (delivery.kind === 'response') {
          assert.equal(delivery.outcome.error, undefined, `${command} popup runtime error`);
          assert.equal(delivery.outcome.response?.ok, true,
            `${command} failed: ${delivery.outcome.response?.error}`);
          const progress = delivery.outcome.response?.value;
          assert.ok(expectedStates.includes(progress?.state),
            `${command}: progress state ${progress?.state} is not one of ${expectedStates.join(', ')}`);
          assert.equal(progress?.completed, progress?.total,
            `${command}: every intended target must have a terminal outcome`);
          assert.equal((progress?.summary?.success || 0) + (progress?.summary?.skipped || 0) +
            (progress?.summary?.failed || 0), progress?.total,
          `${command}: progress summary must account for every intended target`);
          commandResult = {kind: delivery.kind, progress, response: delivery.outcome.response};
        }
        else {
          // A real browser-action popup is not a tab.  Our stable, tab-hosted
          // UI surrogate is intentionally in the selected window so
          // currentWindow resolves exactly as it does for the popup.  A forced
          // all/window/side command can therefore include that surrogate and
          // close its response channel.  Record the distinction; the command's
          // authoritative final-state assertions immediately follow.
          timeline.push({
            at: Date.now(),
            command,
            event: 'popup-host-discarded-before-response',
            shiftKey
          });
          commandResult = {kind: delivery.kind};
        }
      }
      finally {
        polling = false;
        await poll;
        await removePopup(popup);
        timeline.push({at: Date.now(), command, event: 'command-response', shiftKey});
      }
      return commandResult;
    };

    const delayNextStopScript = async (tabId, delayMs = 750) => {
      const workerNow = await currentWorker();
      return workerNow.evaluate(({delayMs, tabId}) => {
        const original = chrome.scripting.executeScript.bind(chrome.scripting);
        const token = crypto.randomUUID();
        const state = {
          delayed: false,
          delayMs,
          settledAt: 0,
          startedAt: 0,
          tabId,
          token
        };
        const hooked = details => {
          if (state.delayed === false && details?.injectImmediately === true &&
              details?.target?.tabId === tabId && typeof details.func === 'function') {
            state.delayed = true;
            state.startedAt = Date.now();
            return new Promise(resolve => setTimeout(resolve, delayMs))
              .then(() => original(details))
              .finally(() => state.settledAt = Date.now());
          }
          return original(details);
        };
        chrome.scripting.executeScript = hooked;
        globalThis.__atdE2EDelayedStop = {hooked, original, state};
        return token;
      }, {delayMs, tabId});
    };

    const delayedStopState = async token => {
      const workerNow = await currentWorker();
      return workerNow.evaluate(token => {
        const current = globalThis.__atdE2EDelayedStop;
        return current?.state?.token === token ? {...current.state} : undefined;
      }, token);
    };

    const restoreDelayedStopHook = async token => {
      const workerNow = await currentWorker();
      return workerNow.evaluate(token => {
        const current = globalThis.__atdE2EDelayedStop;
        if (current?.state?.token !== token) {
          return false;
        }
        if (chrome.scripting.executeScript === current.hooked) {
          chrome.scripting.executeScript = current.original;
        }
        delete globalThis.__atdE2EDelayedStop;
        return true;
      }, token);
    };

    const popupProgressSnapshot = (popup, layout) => popup.page.evaluate(windowId =>
      new Promise(resolve => chrome.runtime.sendMessage({
        method: 'popup-progress-snapshot',
        windowId
      }, response => resolve(chrome.runtime.lastError ? undefined : response?.value))),
    layout.primaryWindowId);

    const registerNativeContextMenu = async () => {
      const controller = await ensureDriver();
      await controller.evaluate(async title => {
        await new Promise((resolve, reject) => chrome.contextMenus.removeAll(() => {
          const error = chrome.runtime.lastError;
          error ? reject(Error(error.message)) : resolve();
        }));
        await new Promise((resolve, reject) => chrome.contextMenus.create({
          contexts: ['page'],
          id: 'discard-tab',
          title
        }, () => {
          const error = chrome.runtime.lastError;
          error ? reject(Error(error.message)) : resolve();
        }));
      }, NATIVE_CONTEXT_MENU_TITLE);
      timeline.push({
        at: Date.now(),
        contexts: ['page'],
        event: 'native-context-menu-registered',
        status: 'created'
      });
    };

    const invokeNativeContextMenu = async layout => {
      await focusSelected(layout);
      const selected = Object.values(layout.tabs).find(tab => tab.id === layout.selectedId);
      const targetPage = await waitFor(() => context.pages().find(page => page.url() === selected.url),
        'selected fixture page for native context menu', 10000);
      const token = `context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const worker = await currentWorker();
      const observerInstalled = await worker.evaluate(value => {
        globalThis.__atdE2EContextEvents ||= [];
        globalThis.__atdE2EContextTokens ||= new Set();
        if (globalThis.__atdE2EContextTokens.has(value) === false) {
          globalThis.__atdE2EContextTokens.add(value);
          chrome.contextMenus.onClicked.addListener((info, tab) => {
            globalThis.__atdE2EContextEvents.push({
              menuItemId: info.menuItemId,
              tabId: tab?.id,
              token: value,
              windowId: tab?.windowId
            });
          });
        }
        return true;
      }, token);
      assert.equal(observerInstalled, true, 'native context-menu observer must install in the live worker');

      let nativeSelector;
      try {
        await targetPage.bringToFront();
        const exactDocumentName = await targetPage.title();
        const controller = await ensureDriver();
        await controller.evaluate(title => new Promise((resolve, reject) => {
          chrome.contextMenus.update('discard-tab', {
            contexts: ['page'],
            title
          }, () => {
            const error = chrome.runtime.lastError;
            error ? reject(Error(error.message)) : resolve();
          });
        }), NATIVE_CONTEXT_MENU_TITLE);
        timeline.push({
          at: Date.now(),
          contexts: ['page'],
          event: 'native-context-menu-updated',
          status: 'verified'
        });
        await sleep(NATIVE_MENU_UPDATE_SETTLE_MS);
        timeline.push({
          at: Date.now(),
          event: 'native-context-menu-update-settled',
          status: 'bounded'
        });
        timeline.push({at: Date.now(), command: 'discard-tab', event: 'native-context-menu-start'});
        nativeSelector = startNativeContextMenuSelector(
          NATIVE_CONTEXT_MENU_TITLE,
          nativeMenuBrowserProcessId,
          manifest.name,
          exactDocumentName
        );
        const selection = await nativeSelector.completion;
        const observed = await waitFor(() => worker.evaluate(({token, tabId, windowId}) =>
          globalThis.__atdE2EContextEvents?.find(event => event.token === token &&
            event.menuItemId === 'discard-tab' && event.tabId === tabId && event.windowId === windowId), {
          tabId: layout.selectedId,
          token,
          windowId: layout.primaryWindowId
        }), 'browser-generated chrome.contextMenus.onClicked event', 10000, 100);
        timeline.push({
          at: Date.now(),
          command: 'discard-tab',
          event: 'native-context-menu-clicked',
          finalSurface: selection.finalSurface,
          firstClickSurface: selection.firstClickSurface,
          menuItemId: observed.menuItemId,
          parentExpansionMethod: selection.parentExpansionMethod,
          pointerMethod: selection.pointerMethod,
          rightClickAttempts: selection.rightClickAttempts,
          selectionMethod: selection.method
        });
        return {
          entryEvent: 'chrome.contextMenus.onClicked',
          finalSurface: selection.finalSurface,
          firstClickSurface: selection.firstClickSurface,
          menuItemId: observed.menuItemId,
          parentExpansionMethod: selection.parentExpansionMethod,
          pointerMethod: selection.pointerMethod,
          rightClickAttempts: selection.rightClickAttempts,
          selectionMethod: selection.method,
          selectionScope: selection.scope
        };
      }
      catch (error) {
        if (error.nativeMenuDiagnostics) {
          lastNativeMenuDiagnostics = error.nativeMenuDiagnostics;
          timeline.push({
            at: Date.now(),
            command: 'discard-tab',
            event: 'native-context-menu-failed',
            ...lastNativeMenuDiagnostics,
            reasonCode: publicFailureReason(error)
          });
        }
        throw error;
      }
      finally {
        try {
          await nativeSelector?.cancel();
        }
        finally {
          await driver.evaluate(() => new Promise(resolve => {
            chrome.runtime.sendMessage({method: 'build-context'}, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          }));
        }
      }
    };

    const assertTakeoverApiOrder = async (checkpoint, id, label) => {
      const events = await telemetrySince(checkpoint);
      const lineage = lineageFor(id);
      const api = events.filter(event => event.token === telemetryToken && lineage.has(event.id) &&
        Number.isInteger(event.apiSequence)).sort((a, b) => a.apiSequence - b.apiSequence);
      const discardCalls = api.filter(event => event.event === 'api.tabs.discard-call');
      assert.equal(discardCalls.length, 1, `${label}: native tabs.discard must be invoked exactly once`);
      const discardCall = discardCalls[0];
      const stopCalls = api.filter(event => event.event === 'api.scripting.stop-call');
      const stopCompletions = api.filter(event => event.event === 'api.scripting.stop-complete');
      assert.ok(stopCalls.length > 0, `${label}: at least one injected stop script must run`);
      assert.equal(discardCall.workerInstance, stopCalls[0].workerInstance,
        `${label}: stop and native discard boundaries must come from one live worker`);

      for (const call of stopCalls) {
        const completion = stopCompletions.find(event => event.operationId === call.operationId);
        assert.ok(completion, `${label}: stop operation ${call.operationId} must settle`);
        assert.equal(completion.workerInstance, discardCall.workerInstance,
          `${label}: stop completion must belong to the worker that performs native discard`);
        assert.ok(call.apiSequence < completion.apiSequence && completion.apiSequence < discardCall.apiSequence,
          `${label}: stop ${call.operationId} must complete before native tabs.discard`);
      }
      assert.ok(stopCompletions.some(event => event.outcome === 'fulfilled' &&
        event.apiSequence < discardCall.apiSequence),
      `${label}: a stop script must fulfill before native tabs.discard`);
      assert.equal(api.some(event => event.event.startsWith('api.scripting.stop-') &&
        event.apiSequence > discardCall.apiSequence), false,
      `${label}: no stop injection may remain or start after native tabs.discard`);
      return {
        discardSequence: discardCall.apiSequence,
        stopSequences: stopCompletions.map(event => event.apiSequence)
      };
    };

    const assertStable = async (layout, duration = 1500) => {
      const before = await compactSnapshot(layout);
      const requestBefore = counts(layout);
      const telemetryStart = await telemetryCheckpoint();
      const sleeperRoots = Object.entries(before.tabs)
        .filter(([, tab]) => tab.discarded === true)
        .map(([, tab]) => tab.id);
      await sleep(duration);
      const after = await compactSnapshot(layout);
      const requestAfter = counts(layout);
      for (const key of Object.keys(layout.tabs)) {
        assert.deepEqual({
          discarded: after.tabs[key].discarded,
          favicon: after.tabs[key].favIconUrl || '',
          source: after.ownership[layout.tabs[key].id]?.source,
          status: after.tabs[key].status,
          title: after.tabs[key].title || ''
        }, {
          discarded: before.tabs[key].discarded,
          favicon: before.tabs[key].favIconUrl || '',
          source: before.ownership[layout.tabs[key].id]?.source,
          status: before.tabs[key].status,
          title: before.tabs[key].title || ''
        }, `${key} must remain stable during the quiescence dwell`);
      }
      assert.deepEqual(requestAfter, requestBefore, 'quiescence dwell must not issue delayed document requests');
      const sleeperIds = new Set(sleeperRoots.flatMap(id => [...lineageFor(id)]));
      const wakeEvents = (await telemetrySince(telemetryStart)).filter(event =>
        event.event === 'tabs.onUpdated' && sleeperIds.has(event.id) &&
        (event.tab?.discarded === false || event.tab?.status === 'loading'));
      assert.deepEqual(wakeEvents, [], 'quiescence dwell must not contain a transient sleeper wake/loading cycle');
    };

    const nextPrefix = name => `${String(++scenarioSequence).padStart(2, '0')}-${name}`;

    // Register once before scenario work gives Edge several seconds to publish
    // the extension item into its native menu model. The native row later uses
    // update as an exact-ID existence check and never removes/recreates it.
    await registerNativeContextMenu();

    // Selected-tab row through the real popup DOM.
    {
      const name = 'discard-tab';
      const layout = await buildDirect(nextPrefix(name));
      await auditPopup(layout);
      const baseline = counts(layout);
      await recordMemory(`${name}:loaded`);
      await clickPopup(layout, name, false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return snapshot.tabs['d-selected'].discarded === true &&
          snapshot.tabs['d-selected'].status === 'unloaded' &&
          snapshot.ownership[layout.tabs['d-selected'].id]?.source === 'self';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ['d-selected'], name);
      assertSleepVisual(after.tabs['d-selected'], after.ownership[layout.tabs['d-selected'].id],
        'a tab physically discarded by the extension');
      assert.equal(after.tabs['d-keeper-near'].active, true, 'nearest eligible keeper must become active');
      for (const key of ['d-keeper-near', 'd-decoy', 'd-keeper-far']) {
        assert.equal(after.tabs[key].discarded, false, `${key} must remain loaded`);
        assert.equal(after.ownership[layout.tabs[key].id], undefined, `${key} must remain unowned`);
      }
      assert.deepEqual(counts(layout), baseline, 'discard-tab must not reload a document');
      await assertStable(layout);
      await recordMemory(`${name}:discarded`);
      assertNoCrashes(name);
      scenarios.push({
        activeDiscardRepeatCoverage:
          'not-run: activating an inactive discarded tab to make it the popup target necessarily wakes it',
        externalTakeoverCoverage: 'group-and-scoped-commands',
        name,
        ok: true,
        targets: ['d-selected']
      });
    }

    // This is deliberately not a popup-message surrogate. A single temporary
    // page context item is selected from the browser's native menu, and an
    // independent listener in the live worker must observe the browser-created
    // chrome.contextMenus.onClicked event before final state is accepted.
    {
      const name = 'discard-tab-native-context-menu';
      const layout = await buildDirect(nextPrefix(name));
      const baseline = counts(layout);
      const entry = await invokeNativeContextMenu(layout);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return snapshot.tabs['d-selected'].discarded === true &&
          snapshot.tabs['d-selected'].status === 'unloaded' &&
          snapshot.ownership[layout.tabs['d-selected'].id]?.source === 'self';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ['d-selected'], name);
      assertSleepVisual(after.tabs['d-selected'], after.ownership[layout.tabs['d-selected'].id], name);
      assert.equal(after.tabs['d-keeper-near'].active, true,
        `${name}: the nearest safe keeper must become active`);
      assert.deepEqual(counts(layout), baseline, `${name} must not reload a document`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({
        entryEvent: entry.entryEvent,
        finalSurface: entry.finalSurface,
        firstClickSurface: entry.firstClickSurface,
        menuItemId: entry.menuItemId,
        name,
        ok: true,
        parentExpansionMethod: entry.parentExpansionMethod,
        pointerMethod: entry.pointerMethod,
        rightClickAttempts: entry.rightClickAttempts,
        selectionMethod: entry.selectionMethod,
        selectionScope: entry.selectionScope
      });
    }

    {
      const name = 'discard-tree-ungrouped';
      const layout = await buildDirect(nextPrefix(name));
      const baseline = counts(layout);
      await clickPopup(layout, 'discard-tree', false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return snapshot.tabs['d-selected'].discarded === true &&
          snapshot.tabs['d-selected'].status === 'unloaded' &&
          snapshot.ownership[layout.tabs['d-selected'].id]?.source === 'self';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ['d-selected'], name);
      assertSleepVisual(after.tabs['d-selected'], after.ownership[layout.tabs['d-selected'].id], name);
      for (const key of ['d-keeper-near', 'd-decoy', 'd-keeper-far']) {
        assert.equal(after.tabs[key].discarded, false, `${name} must not include neighboring ungrouped ${key}`);
      }
      assert.deepEqual(counts(layout), baseline, `${name} must not reload a document`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({name, ok: true, targets: ['d-selected']});
    }

    // Native Chromium/Edge group row: a normal click physically takes over an
    // existing external discard, applies the portable sleep marker, and then
    // owns it exactly like the group's loaded members. Shift is not required.
    {
      const name = 'discard-tree-normal-takeover';
      const layout = await buildGroup(nextPrefix(name));
      const baseline = counts(layout);
      const start = await telemetryCheckpoint();
      await clickPopup(layout, 'discard-tree', false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return ['g-selected', 'g-loaded', 'g-external'].every(key =>
          snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout,
        ['g-selected', 'g-loaded', 'g-external', 'g-out-external'], name);
      for (const key of ['g-selected', 'g-loaded', 'g-external']) {
        assert.equal(after.tabs[key].groupId, layout.groupIds.inside, `${key} must retain the selected group ID`);
        assertSleepVisual(after.tabs[key], after.ownership[layout.tabs[key].id], `${name} ${key}`);
      }
      for (const key of ['g-out-loaded', 'g-out-external']) {
        assert.equal(after.tabs[key].groupId, layout.groupIds.outside, `${key} must retain the outsider group ID`);
      }
      assert.notEqual(layout.groupIds.inside, layout.groupIds.outside, 'fixture groups must be distinct');
      assert.equal(after.tabs['g-keeper'].active, true, 'out-of-group keeper must become active');
      assert.equal(after.tabs['g-out-loaded'].discarded, false, 'other group loaded member must be untouched');
      assert.equal(after.tabs['g-out-external'].discarded, true, 'other group sleeper must stay asleep');
      assert.equal(after.ownership[layout.tabs['g-out-external'].id]?.source, 'claimed');
      const requestAfter = counts(layout);
      assert.equal(requestAfter['g-external'], baseline['g-external'] + 1,
        'normal group takeover must wake the external member exactly once');
      for (const key of Object.keys(layout.tabs).filter(key => key !== 'g-external')) {
        assert.equal(requestAfter[key], baseline[key], `${key} must not be reloaded by normal group takeover`);
      }
      const externalId = layout.tabs['g-external'].id;
      await assertTakeoverApiOrder(start, externalId, name);
      const externalLineage = lineageFor(externalId);
      assert.equal((await telemetrySince(start)).some(event => event.event === 'tabs.onUpdated' &&
        externalLineage.has(event.id) && event.tab?.discarded === false), true,
      'normal group takeover must wake the existing discard');
      assert.equal(fixture.entries(layout.tabs['g-external'].label).length, 2,
        'normal group takeover must never enter a reload loop');
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({name, ok: true, sources: {external: 'self', loaded: 'self'}, wakeCount: 1});
    }

    {
      const name = 'discard-tree-normal-takeover-favicon-only';
      await driver.evaluate(() => chrome.storage.local.set({favicon: true, prepends: ''}));
      const layout = await buildGroup(nextPrefix(name));
      const baseline = counts(layout);
      await clickPopup(layout, 'discard-tree', false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return ['g-selected', 'g-loaded', 'g-external'].every(key =>
          snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${name} final state`, 25000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout,
        ['g-selected', 'g-loaded', 'g-external', 'g-out-external'], name);
      for (const key of ['g-selected', 'g-loaded', 'g-external']) {
        assertFaviconOnlyVisual(after.tabs[key], after.ownership[layout.tabs[key].id], `${name} ${key}`);
      }
      const requestAfter = counts(layout);
      assert.equal(requestAfter['g-external'], baseline['g-external'] + 1,
        `${name}: external sleeper must wake exactly once`);
      for (const key of Object.keys(layout.tabs).filter(key => key !== 'g-external')) {
        assert.equal(requestAfter[key], baseline[key], `${name}: ${key} must not reload`);
      }
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({favicon: true, name, ok: true, prepends: '', takeover: 'external'});
      await driver.evaluate(() => chrome.storage.local.set({favicon: true, prepends: '\u{1F4A4}'}));
    }

    {
      const name = 'discard-tree-shift-takeover';
      const layout = await buildGroup(nextPrefix(name), {slowExternal: true});
      const baseline = counts(layout);
      const memoryBefore = await recordMemory(`${name}:before`);
      const start = await telemetryCheckpoint();
      const startedAt = Date.now();
      await clickPopup(layout, 'discard-tree', true);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return ['g-selected', 'g-loaded', 'g-external'].every(key =>
          snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${name} final state`, 20000);
      const durationMs = Date.now() - startedAt;
      const requestAfter = counts(layout);
      assert.equal(requestAfter['g-external'], baseline['g-external'] + 1,
        'Shift group takeover must wake the external member exactly once');
      for (const key of Object.keys(layout.tabs).filter(key => key !== 'g-external')) {
        assert.equal(requestAfter[key], baseline[key], `${key} must not be reloaded by Shift group takeover`);
      }
      const secondRequest = fixture.entries(layout.tabs['g-external'].label)[1];
      assert.ok(secondRequest, 'slow takeover reload must reach the fixture server');
      await waitFor(() => secondRequest.closedAt, 'stopped takeover response to close', 5000);
      assert.equal(secondRequest.aborted, true, 'window.stop must abort the deliberately held response');
      assert.equal(secondRequest.writableFinished, false, 'held response must stop before natural completion');
      assert.ok(durationMs < 5000, `takeover must stop the 10-second response promptly, got ${durationMs}ms`);
      const id = layout.tabs['g-external'].id;
      const groupAfter = await compactSnapshot(layout);
      assertOwnershipKeys(groupAfter, layout,
        ['g-selected', 'g-loaded', 'g-external', 'g-out-external'], name);
      for (const key of ['g-selected', 'g-loaded', 'g-external']) {
        assert.equal(groupAfter.tabs[key].groupId, layout.groupIds.inside, `${key} must retain its group after Shift`);
      }
      assertSleepVisual(groupAfter.tabs['g-external'],
        groupAfter.ownership[layout.tabs['g-external'].id], 'physical takeover');
      for (const key of ['g-out-loaded', 'g-out-external']) {
        assert.equal(groupAfter.tabs[key].groupId, layout.groupIds.outside, `${key} outsider group must remain intact`);
      }
      const apiOrder = await assertTakeoverApiOrder(start, id, name);
      const idLineage = lineageFor(id);
      const events = (await telemetrySince(start))
        .filter(event => event.event === 'tabs.onUpdated' && idLineage.has(event.id));
      const loading = events.findIndex(event => event.tab?.discarded === false && event.tab?.status === 'loading');
      const complete = events.findIndex((event, index) => index > loading &&
        event.tab?.discarded === false && event.tab?.status === 'complete');
      const unloaded = events.findIndex((event, index) => index > complete &&
        event.tab?.discarded === true && event.tab?.status === 'unloaded');
      assert.ok(loading >= 0, 'telemetry must observe the takeover reload in loading state');
      assert.ok(complete > loading, 'the reload must quiesce before native discard');
      assert.ok(unloaded > complete, 'native discard must happen only after reload quiescence');
      assert.equal(fixture.entries(layout.tabs['g-external'].label).length, 2,
        'Shift group takeover must never enter a reload loop');
      const memoryImmediate = await recordMemory(`${name}:immediate`);
      await assertStable(layout, 3000);
      const memoryAfter = await recordMemory(`${name}:after`);
      const memoryCeiling = Math.max(memoryBefore.privateBytes, memoryImmediate.privateBytes) + 64 * 1024 * 1024;
      assert.ok(memoryAfter.privateBytes <= memoryCeiling,
        `${name} private memory must not keep climbing after quiescence`);
      assertNoCrashes(name);
      scenarios.push({
        apiOrder,
        durationMs,
        name,
        ok: true,
        sequence: ['loading', 'complete', 'unloaded']
      });
    }

    // Reproduce the original spinner/RAM complaint at the costly point: a
    // discarded target has started its second, deliberately held document
    // request, but marker preparation has not settled.  The real popup Cancel
    // control must stop that request and leave the target awake and stable.
    {
      const name = 'discard-tree-cancel-during-slow-wake';
      const layout = await buildGroup(nextPrefix(name), {slowExternal: true});
      const target = layout.tabs['g-external'];
      const baseline = counts(layout);
      const memoryBefore = await recordMemory(`${name}:before`);
      await installWorkerApiTelemetry();
      const stopToken = await delayNextStopScript(target.id);
      const checkpoint = await telemetryCheckpoint();
      const popup = await openPopup(layout);
      let terminal;
      try {
        await focusSelected(layout);
        await popup.page.locator('[data-cmd="discard-tree"]').click();
        await waitFor(async () => {
          const delayed = await delayedStopState(stopToken);
          const snapshot = await compactSnapshot(layout);
          return delayed?.startedAt > 0 && fixture.entries(target.label)[1] &&
            snapshot.tabs['g-external'].discarded === false &&
            snapshot.tabs['g-external'].status === 'loading';
        }, `${name}: held wake request and delayed stop preparation`, 5000, 10);
        await popup.page.waitForFunction(() => {
          const cancel = document.getElementById('activity-cancel');
          return cancel && cancel.hidden === false && cancel.disabled === false;
        });
        const running = await popupProgressSnapshot(popup, layout);
        assert.equal(running?.state, 'running', `${name}: popup job must be cancellable while waking`);
        assert.ok(running?.jobId && running.jobId !== 'pending', `${name}: popup must expose a real job ID`);
        await popup.page.locator('#activity-cancel').click();

        terminal = await waitFor(async () => {
          const snapshot = await popupProgressSnapshot(popup, layout);
          return snapshot?.state === 'cancelled' ? snapshot : false;
        }, `${name}: popup cancellation to settle`, 15000);
        assert.equal(terminal.completed, terminal.total,
          `${name}: cancellation must produce one terminal outcome per intended tab`);
        await waitFor(async () => (await delayedStopState(stopToken))?.settledAt > 0,
          `${name}: delayed preparation call to settle`, 5000);
        await waitFor(async () => {
          const snapshot = await compactSnapshot(layout);
          const tab = snapshot.tabs['g-external'];
          return tab.discarded === false && tab.status === 'complete' &&
            snapshot.ownership[target.id] === undefined ? snapshot : false;
        }, `${name}: cancelled target to become stably awake and unowned`, 10000);

        const secondRequest = fixture.entries(target.label)[1];
        assert.ok(secondRequest, `${name}: takeover must start one wake request before cancellation`);
        await waitFor(() => secondRequest.closedAt, `${name}: cancelled response to close`, 5000);
        assert.equal(secondRequest.aborted, true, `${name}: cancellation must abort the held response`);
        assert.equal(secondRequest.writableFinished, false,
          `${name}: held response must not finish naturally after cancellation`);
        const immediate = await compactSnapshot(layout);
        assert.equal(immediate.ownership[target.id], undefined,
          `${name}: cancelled takeover must not retain ownership`);
        assertReleasedVisual(immediate.tabs['g-external'], `${name}: cancelled target`);
        const memoryImmediate = await recordMemory(`${name}:immediate`);
        const requestsBeforeDwell = fixture.entries(target.label).length;
        const dwellCheckpoint = await telemetryCheckpoint();
        await sleep(3000);
        const after = await compactSnapshot(layout);
        const dwellEvents = await telemetrySince(dwellCheckpoint);
        const lineage = lineageFor(target.id);
        assert.equal(fixture.entries(target.label).length, requestsBeforeDwell,
          `${name}: no delayed document request may start during dwell`);
        assert.equal(dwellEvents.some(event => event.event === 'tabs.onUpdated' &&
          lineage.has(event.id) && (event.changeInfo?.status === 'loading' ||
            event.tab?.status === 'loading' || event.tab?.discarded === true)), false,
        `${name}: no delayed loading or rediscard transition may occur during dwell`);
        assert.equal(after.tabs['g-external'].discarded, false);
        assert.equal(after.tabs['g-external'].status, 'complete');
        assert.equal(after.ownership[target.id], undefined);
        assertReleasedVisual(after.tabs['g-external'], `${name}: post-dwell target`);
        const memoryAfter = await recordMemory(`${name}:after`);
        const memoryCeiling = Math.max(memoryBefore.privateBytes, memoryImmediate.privateBytes) +
          64 * 1024 * 1024;
        assert.ok(memoryAfter.privateBytes <= memoryCeiling,
          `${name}: private memory must not keep climbing after cancellation`);
        assert.equal(counts(layout)['g-external'], baseline['g-external'] + 1,
          `${name}: cancellation must perform exactly one wake request`);
        const commandEvents = await telemetrySince(checkpoint);
        assert.equal(commandEvents.some(event => event.event === 'tabs.onUpdated' &&
          lineage.has(event.id) && event.tab?.discarded === true), false,
        `${name}: cancelled target must never be rediscarded`);
        assertNoCrashes(name);
        scenarios.push({
          cancellation: 'real-popup-control',
          dwellMilliseconds: 3000,
          name,
          ok: true,
          requestDelta: 1,
          terminalState: terminal.state
        });
      }
      finally {
        await restoreDelayedStopHook(stopToken).catch(() => false);
        await removePopup(popup);
      }
    }

    // Non-HTTP geometry is queried without a URL filter. Normal commands must
    // give every physically-only target a precise protected outcome; Shift
    // then either handles it through native discard or gives the target an
    // explicit terminal failure. Browser-rejected creations are capability
    // results, never synthetic passes.
    {
      const name = 'restricted-scheme-bulk-scope';
      const {capabilities, layout} = await buildRestrictedScope(nextPrefix(name));
      const available = capabilities.filter(entry => entry.availability === 'available');
      assert.ok(available.length > 0, `${name}: the browser exposed none of the requested scheme fixtures`);
      const terminalStates = {expectedStates: ['complete', 'partial', 'failed']};
      const normal = await clickPopup(layout, 'discard-window', false, terminalStates);
      assert.equal(normal?.kind, 'response', `${name}: normal command must retain its response channel`);
      const normalOutcomes = normal.progress?.outcomes || {};
      for (const capability of available) {
        const tab = layout.tabs[capability.key];
        const outcome = outcomeForTabLineage(normalOutcomes, tab);
        assert.ok(outcome, `${name}: normal ${capability.scheme} target silently disappeared`);
        if (outcome.code === 'TAB_DISCARDED') {
          assert.equal(outcome.status, 'success');
          capability.normal = {
            code: outcome.code,
            disposition: 'handled',
            status: outcome.status
          };
        }
        else if (outcome.code === 'TAB_PROTECTED') {
          assert.equal(outcome.status, 'skipped');
          capability.normal = {
            code: outcome.code,
            disposition: 'protected',
            status: outcome.status
          };
        }
        else if (outcome.code === 'TAB_SUSPENSION_UNKNOWN') {
          // Chromium redacts file/data/internal/extension URLs unless the user
          // grants broader optional access and can simultaneously expose the
          // optional frozen field as null. That is not proof of either a loaded
          // tab or a frozen sleeper, so both normal and forced commands must
          // fail closed with this precise capability result.
          assert.equal(outcome.status, 'failed');
          capability.normal = {
            code: outcome.code,
            disposition: 'unknown-suspension',
            status: outcome.status
          };
        }
        else {
          assert.deepEqual(outcome, {
            code: 'TAB_UNSUPPORTED',
            status: 'failed',
            tabId: tab.id
          }, `${name}: normal ${capability.scheme} failure must be explicit`);
          capability.normal = {
            code: outcome.code,
            disposition: 'unsupported',
            status: outcome.status
          };
        }
      }

      const forced = await clickPopup(layout, 'discard-window', true, terminalStates);
      assert.equal(forced?.kind, 'response', `${name}: Shift command must retain its response channel`);
      const forcedOutcomes = forced.progress?.outcomes || {};
      const final = await compactSnapshot(layout);
      for (const capability of available) {
        const tab = layout.tabs[capability.key];
        const outcome = outcomeForTabLineage(forcedOutcomes, tab);
        if (capability.normal.disposition === 'handled') {
          assert.deepEqual(outcome, {
            code: 'TAB_ALREADY_OWNED',
            status: 'skipped',
            tabId: tab.id
          }, `${name}: repeat ${capability.scheme} target must stay owned without another discard`);
          assert.equal(final.tabs[capability.key].discarded, true,
            `${name}: normal-handled ${capability.scheme} target must remain discarded`);
          capability.forced = {
            code: outcome.code,
            disposition: 'already-handled',
            status: outcome.status
          };
          continue;
        }
        if (capability.normal.disposition === 'unknown-suspension') {
          assert.deepEqual(outcome, {
            code: 'TAB_SUSPENSION_UNKNOWN',
            status: 'failed',
            tabId: tab.id
          }, `${name}: Shift ${capability.scheme} must fail closed on ambiguous browser state`);
          assert.equal(final.tabs[capability.key].discarded, false,
            `${name}: an ambiguous ${capability.scheme} target must not be mutated`);
          capability.forced = {
            code: outcome.code,
            disposition: 'unknown-suspension',
            status: outcome.status
          };
          continue;
        }
        assert.ok(outcome && ['success', 'failed'].includes(outcome.status),
          `${name}: Shift ${capability.scheme} target silently disappeared`);
        assert.ok(['TAB_DISCARDED', 'TAB_FAILED', 'TAB_UNSUPPORTED'].includes(outcome.code),
          `${name}: Shift ${capability.scheme} target has no precise terminal code`);
        const current = final.tabs[capability.key];
        if (outcome.status === 'success') {
          assert.equal(current.discarded, true,
            `${name}: successful ${capability.scheme} target must be physically discarded`);
          capability.forced = {code: outcome.code, disposition: 'handled', status: outcome.status};
        }
        else {
          assert.ok(['TAB_FAILED', 'TAB_UNSUPPORTED'].includes(outcome.code));
          assert.equal(current.discarded, false,
            `${name}: unsupported ${capability.scheme} target must not be reported as discarded`);
          capability.forced = {code: outcome.code, disposition: 'unsupported', status: outcome.status};
        }
      }
      assert.equal(capabilities.every(entry => entry.availability === 'unavailable' ||
        (entry.normal?.disposition && entry.forced?.disposition)), true,
      `${name}: every requested scheme must be capability-reported and reconciled`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({capabilities, command: 'discard-window', name, ok: true});
    }

    // Every scoped command gets two independent fixtures. The normal fixture
    // proves external-sleeper takeover. The fresh Shift fixture begins with a
    // still-loaded autoDiscardable:false target, so Shift cannot pass merely
    // because a previous normal invocation already self-owned the scope.
    for (const [command, targets] of Object.entries(DISCARD_SPECS)) {
      const name = `${command}-normal-and-fresh-shift`;
      const inScope = new Set(targets);
      const dynamicKeepers = ['discard-other-windows', 'discard-tabs'].includes(command) ?
        ROTATED_OTHER_WINDOW_KEEPERS : [];

      const layout = await buildScoped(nextPrefix(`${command}-normal`), {holdKeys: SETUP_EXTERNAL});
      await externalDiscard(layout, [...SETUP_EXTERNAL]);
      const baseline = counts(layout);
      const normalStart = await telemetryCheckpoint();
      await clickPopup(layout, command, false);
      const normalTakeovers = targets.filter(key => SETUP_EXTERNAL.has(key));
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return targets.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${command} normal final state`, 25000);
      let after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, [...targets, ...SETUP_EXTERNAL], `${command} normal`);
      const normalVisuals = Object.fromEntries(targets.map(key => [key,
        assertSleepVisual(after.tabs[key], after.ownership[layout.tabs[key].id],
          `${command} normal ${key}`)]));
      for (const key of ALL_SCOPED_TABS.filter(key => !inScope.has(key))) {
        if (SETUP_EXTERNAL.has(key)) {
          assert.equal(after.tabs[key].discarded, true, `${command} must keep ${key} asleep`);
          assert.equal(after.ownership[layout.tabs[key].id]?.source, 'claimed',
            `${command} must not take over out-of-scope ${key}`);
        }
        else {
          assert.equal(after.tabs[key].discarded, false, `${command} must keep ${key} loaded`);
          assert.equal(after.ownership[layout.tabs[key].id], undefined,
            `${command} must not own out-of-scope ${key}`);
        }
      }
      const normalAfter = counts(layout);
      for (const key of Object.keys(layout.tabs)) {
        const expectedDelta = normalTakeovers.includes(key) ? 1 : 0;
        assert.equal(normalAfter[key], baseline[key] + expectedDelta,
          `${command} normal request delta for ${key}`);
      }
      for (const key of normalTakeovers) {
        const id = layout.tabs[key].id;
        await assertTakeoverApiOrder(normalStart, id, `${command} normal ${key}`);
        const idLineage = lineageFor(id);
        const events = (await telemetrySince(normalStart))
          .filter(event => event.event === 'tabs.onUpdated' && idLineage.has(event.id));
        const loading = events.findIndex(event => event.tab?.discarded === false && event.tab?.status === 'loading');
        const complete = events.findIndex((event, index) => index > loading &&
          event.tab?.discarded === false && event.tab?.status === 'complete');
        const unloaded = events.findIndex((event, index) => index > complete &&
          event.tab?.discarded === true && event.tab?.status === 'unloaded');
        assert.ok(loading >= 0 && complete > loading && unloaded > complete,
          `${command} normal takeover must quiesce ${key} in loading -> complete -> unloaded order`);
        const secondRequest = fixture.entries(layout.tabs[key].label)[1];
        await waitFor(() => secondRequest?.closedAt, `${command} normal stopped response for ${key}`, 5000);
        assert.equal(secondRequest.aborted, true);
        assert.equal(secondRequest.writableFinished, false);
        assert.equal(fixture.entries(layout.tabs[key].label).length, 2,
          `${command} normal takeover must wake ${key} exactly once`);
      }

      const normalRepeatBaseline = counts(layout);
      const normalRepeatStart = await telemetryCheckpoint();
      await clickPopup(layout, command, false);
      assert.deepEqual(counts(layout), normalRepeatBaseline,
        `${command} repeat normal command must not reload any fixture`);
      const normalRepeat = await compactSnapshot(layout);
      for (const key of targets) {
        assert.equal(normalRepeat.tabs[key].discarded, true, `${command} repeat must keep ${key} discarded`);
        assert.equal(normalRepeat.ownership[layout.tabs[key].id]?.source, 'self');
        assert.deepEqual(assertSleepVisual(normalRepeat.tabs[key],
          normalRepeat.ownership[layout.tabs[key].id], `${command} repeat normal ${key}`),
          normalVisuals[key], `${command} repeat normal must not mutate ${key}'s visual marker`);
      }
      const normalDynamicOwned = dynamicKeepers.filter(key =>
        normalRepeat.ownership[layout.tabs[key].id]?.source === 'self');
      assertOwnershipKeys(normalRepeat, layout,
        [...targets, ...SETUP_EXTERNAL, ...normalDynamicOwned], `${command} repeat normal`);
      const normalRepeatEvents = await telemetrySince(normalRepeatStart);
      for (const key of targets) {
        const idLineage = lineageFor(layout.tabs[key].id);
        assert.equal(normalRepeatEvents.some(event => event.event === 'tabs.onUpdated' &&
          idLineage.has(event.id) && (event.tab?.discarded === false || event.tab?.status === 'loading')), false,
        `${command} repeat normal command must not wake self-owned ${key}`);
      }
      for (const key of dynamicKeepers) {
        const marker = normalRepeat.ownership[layout.tabs[key].id];
        if (marker?.source === 'self') {
          assertSleepVisual(normalRepeat.tabs[key], marker, `${command} rotated keeper ${key}`);
        }
        else {
          assert.equal(normalRepeat.tabs[key].discarded, false,
            `${command} uncommitted keeper ${key} must remain loaded and unowned`);
        }
      }
      await assertStable(layout);

      const shiftLayout = await buildScoped(nextPrefix(`${command}-fresh-shift`));
      const protectedKey = SCOPED_SHIFT_PROTECTED[command];
      assert.ok(targets.includes(protectedKey), `${command}: Shift protection fixture must be in scope`);
      await driver.evaluate(id => chrome.tabs.update(id, {autoDiscardable: false}),
        shiftLayout.tabs[protectedKey].id);
      await externalDiscard(shiftLayout, [...SETUP_EXTERNAL]);
      const protectedBefore = await compactSnapshot(shiftLayout);
      assert.equal(protectedBefore.tabs[protectedKey].discarded, false,
        `${command}: protected Shift target must begin loaded`);
      assert.equal(protectedBefore.tabs[protectedKey].autoDiscardable, false,
        `${command}: protected Shift target must begin autoDiscardable:false`);
      assert.equal(protectedBefore.ownership[shiftLayout.tabs[protectedKey].id], undefined,
        `${command}: protected Shift target must begin unowned`);

      const shiftBaseline = counts(shiftLayout);
      await clickPopup(shiftLayout, command, true);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(shiftLayout);
        return targets.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[shiftLayout.tabs[key].id]?.source === 'self');
      }, `${command} fresh Shift final state`, 30000);
      after = await compactSnapshot(shiftLayout);
      assertOwnershipKeys(after, shiftLayout, [...targets, ...SETUP_EXTERNAL], `${command} fresh Shift`);
      const shiftVisuals = Object.fromEntries(targets.map(key => [key,
        assertSleepVisual(after.tabs[key], after.ownership[shiftLayout.tabs[key].id],
          `${command} fresh Shift ${key}`)]));
      assert.equal(after.tabs[protectedKey].autoDiscardable, false,
        `${command}: Shift must override eligibility without rewriting autoDiscardable`);
      const shiftAfter = counts(shiftLayout);
      const shiftTakeovers = targets.filter(key => SETUP_EXTERNAL.has(key));
      for (const key of Object.keys(shiftLayout.tabs)) {
        const expectedDelta = shiftTakeovers.includes(key) ? 1 : 0;
        assert.equal(shiftAfter[key], shiftBaseline[key] + expectedDelta,
          `${command} fresh Shift request delta for ${key}`);
      }
      for (const key of ALL_SCOPED_TABS.filter(key => !inScope.has(key))) {
        if (SETUP_EXTERNAL.has(key)) {
          assert.equal(after.ownership[shiftLayout.tabs[key].id]?.source, 'claimed',
            `${command} fresh Shift must not take over out-of-scope ${key}`);
        }
        else {
          assert.equal(after.tabs[key].discarded, false,
            `${command} fresh Shift must keep out-of-scope ${key} loaded`);
          assert.equal(after.ownership[shiftLayout.tabs[key].id], undefined);
        }
      }

      const shiftRepeatBaseline = counts(shiftLayout);
      const shiftRepeatStart = await telemetryCheckpoint();
      await clickPopup(shiftLayout, command, true);
      assert.deepEqual(counts(shiftLayout), shiftRepeatBaseline,
        `${command} repeat Shift command must not reload any fixture`);
      const shiftRepeat = await compactSnapshot(shiftLayout);
      const shiftDynamicOwned = dynamicKeepers.filter(key =>
        shiftRepeat.ownership[shiftLayout.tabs[key].id]?.source === 'self');
      assertOwnershipKeys(shiftRepeat, shiftLayout,
        [...targets, ...SETUP_EXTERNAL, ...shiftDynamicOwned], `${command} repeat Shift`);
      const shiftRepeatEvents = await telemetrySince(shiftRepeatStart);
      for (const key of targets) {
        assert.equal(shiftRepeat.ownership[shiftLayout.tabs[key].id]?.source, 'self');
        assert.deepEqual(assertSleepVisual(shiftRepeat.tabs[key],
          shiftRepeat.ownership[shiftLayout.tabs[key].id], `${command} repeat Shift ${key}`),
          shiftVisuals[key], `${command} repeat Shift must not mutate ${key}'s visual marker`);
        const idLineage = lineageFor(shiftLayout.tabs[key].id);
        assert.equal(shiftRepeatEvents.some(event => event.event === 'tabs.onUpdated' &&
          idLineage.has(event.id) && (event.tab?.discarded === false || event.tab?.status === 'loading')), false,
        `${command} repeat Shift must not wake self-owned ${key}`);
      }
      for (const key of dynamicKeepers) {
        const marker = shiftRepeat.ownership[shiftLayout.tabs[key].id];
        if (marker?.source === 'self') {
          assertSleepVisual(shiftRepeat.tabs[key], marker, `${command} Shift rotated keeper ${key}`);
        }
        else {
          assert.equal(shiftRepeat.tabs[key].discarded, false,
            `${command} uncommitted Shift keeper ${key} must remain loaded and unowned`);
        }
      }
      await assertStable(shiftLayout);
      assertNoCrashes(name);
      scenarios.push({
        dynamicRepeatScope: {
          normalOwned: normalDynamicOwned,
          shiftOwned: shiftDynamicOwned
        },
        name,
        normalTakeovers,
        normalTargets: targets,
        ok: true,
        protectedShiftOverride: protectedKey,
        shiftFixtureStartedLoadedAndProtected: true,
        shiftTakeovers
      });
    }

    // All five X controls. Every in-scope sleeper loads exactly once, every
    // out-of-scope sleeper stays unloaded, and a repeat release is a no-op.
    // release-tabs additionally uses the real Shift-click path on a deliberate
    // self/claimed ownership mix, covering the popup's bypass-cache modifier
    // without replacing any of the ordinary per-scope release cases.
    for (const [command, targets] of Object.entries(RELEASE_SPECS)) {
      const name = command;
      const inScope = new Set(targets);
      const layout = await buildScoped(nextPrefix(name));
      const shiftKey = command === 'release-tabs';
      let sourcesBefore;
      if (shiftKey) {
        const setupBaseline = counts(layout);

        // Create self markers on the left without touching the other scopes.
        await clickPopup(layout, 'discard-lefts', false);
        await waitFor(async () => {
          const snapshot = await compactSnapshot(layout);
          return ['p-left-far', 'p-left-near'].every(key =>
            snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
            snapshot.ownership[layout.tabs[key].id]?.source === 'self');
        }, `${command}: self-owned release fixtures`, 20000);

        // Physically take over one external sleeper while discarding the other
        // right-side tabs, then leave every other-window sleeper merely claimed.
        await externalDiscard(layout, ['p-right-mid']);
        await clickPopup(layout, 'discard-rights', false);
        await waitFor(async () => {
          const snapshot = await compactSnapshot(layout);
          return ['p-right-near', 'p-right-mid', 'p-right-far'].every(key =>
              snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
              snapshot.ownership[layout.tabs[key].id]?.source === 'self');
        }, `${command}: self-owned release fixtures`, 20000);
        await externalDiscard(layout, OTHER_BACKGROUND);

        const prepared = await compactSnapshot(layout);
        assertOwnershipKeys(prepared, layout, ALL_BACKGROUND, `${command} mixed-source setup`);
        sourcesBefore = Object.fromEntries(ALL_BACKGROUND.map(key => [key,
          prepared.ownership[layout.tabs[key].id]?.source]));
        assert.deepEqual(sourcesBefore, {
          'p-left-far': 'self',
          'p-left-near': 'self',
          'p-right-near': 'self',
          'p-right-mid': 'self',
          'p-right-far': 'self',
          'a-bg-1': 'claimed',
          'a-bg-2': 'claimed',
          'b-bg-1': 'claimed',
          'b-bg-2': 'claimed'
        }, `${command}: release fixture must contain the expected ownership sources`);
        for (const [key, source] of Object.entries(sourcesBefore)) {
          if (source === 'self') {
            assertSleepVisual(prepared.tabs[key], prepared.ownership[layout.tabs[key].id],
              `${command} setup ${key}`);
          }
        }
        const setupAfter = counts(layout);
        for (const key of Object.keys(layout.tabs)) {
          assert.equal(setupAfter[key], setupBaseline[key] + (key === 'p-right-mid' ? 1 : 0),
            `${command}: mixed-source preparation request delta for ${key}`);
        }
      }
      else {
        await externalDiscard(layout, ALL_BACKGROUND);
      }
      const availableBefore = await inspectReleaseAvailability(layout);
      assert.deepEqual(availableBefore, Object.fromEntries(Object.keys(RELEASE_SPECS)
        .map(key => [key, true])), `${command}: all release controls must begin enabled`);
      const baseline = counts(layout);
      await clickPopup(layout, command, shiftKey);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return targets.every(key => snapshot.tabs[key].discarded === false &&
          snapshot.tabs[key].status === 'complete' &&
          snapshot.ownership[layout.tabs[key].id] === undefined &&
          !snapshot.tabs[key].title?.startsWith('💤 ') &&
          /\/favicon\.svg(?:\?|$)/i.test(snapshot.tabs[key].favIconUrl || ''));
      }, `${command} targets to finish reloading`, 25000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ALL_BACKGROUND.filter(key => !inScope.has(key)), command);
      const requestAfter = counts(layout);
      for (const key of targets) {
        assert.equal(requestAfter[key], baseline[key] + 1, `${command} must reload ${key} exactly once`);
        assert.equal(after.tabs[key].discarded, false);
        assert.equal(after.tabs[key].status, 'complete');
        assert.equal(after.ownership[layout.tabs[key].id], undefined);
        assertReleasedVisual(after.tabs[key], `${command} released ${key}`);
      }
      for (const key of ALL_BACKGROUND.filter(key => !inScope.has(key))) {
        assert.equal(requestAfter[key], baseline[key], `${command} must not reload out-of-scope ${key}`);
        assert.equal(after.tabs[key].discarded, true, `${command} must keep out-of-scope ${key} asleep`);
        assert.equal(after.tabs[key].status, 'unloaded');
        assert.equal(after.ownership[layout.tabs[key].id]?.source, 'claimed');
      }
      for (const key of ['p-selected', 'a-active', 'b-active']) {
        assert.equal(after.tabs[key].discarded, false, `${command} must leave active ${key} loaded`);
        assert.equal(requestAfter[key], baseline[key]);
      }

      const availableAfter = await inspectReleaseAvailability(layout);
      assert.deepEqual(availableAfter, RELEASE_AVAILABILITY_AFTER[command],
        `${command}: popup release availability must match the live scopes`);
      const repeatBaseline = counts(layout);
      assert.equal(availableAfter[command], false,
        `${command}: its own control must disable once its scope is empty`);
      await sleep(500);
      assert.deepEqual(counts(layout), repeatBaseline,
        `${command} disabled repeat control must issue no document requests`);
      const repeatAfter = await compactSnapshot(layout);
      for (const key of targets) {
        assert.equal(repeatAfter.tabs[key].discarded, false,
          `${command}: disabled repeat must keep released ${key} loaded`);
        assert.equal(repeatAfter.tabs[key].status, 'complete');
        assert.equal(repeatAfter.ownership[layout.tabs[key].id], undefined,
          `${command}: disabled repeat must not recreate ownership for ${key}`);
        assert.deepEqual(assertReleasedVisual(repeatAfter.tabs[key], `${command} repeat ${key}`),
          assertReleasedVisual(after.tabs[key], `${command} final ${key}`),
        `${command}: disabled repeat must not mutate ${key}'s restored visual state`);
      }
      assertOwnershipKeys(repeatAfter, layout,
        ALL_BACKGROUND.filter(key => !inScope.has(key)), `${command} disabled repeat`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({
        availabilityAfter: availableAfter,
        bypassCache: shiftKey,
        name,
        ok: true,
        repeatPreventedByDisabledControl: true,
        released: targets,
        sourcesBefore
      });
    }

    await flushTelemetry();
    const replacementEvents = timeline.filter(event => event.event === 'tabs.onReplaced' &&
      Number.isInteger(event.addedId) && Number.isInteger(event.removedId));
    for (const event of replacementEvents) {
      assert.equal(resolveTabId(event.removedId), resolveTabId(event.addedId),
        `replacement ${event.removedId} -> ${event.addedId} must resolve to one current identity`);
      const lineage = lineageFor(event.removedId);
      assert.equal(lineage.has(event.removedId) && lineage.has(event.addedId), true,
        `replacement ${event.removedId} -> ${event.addedId} must retain both lineage IDs`);
    }
    scenarios.push({
      coverage: allowEdge ?
        (replacementEvents.length ? 'observed-and-asserted' : 'not-observed-by-this-edge-run') :
        'edge-only-observation-not-applicable',
      name: 'edge-replacement-lineage-observation',
      observed: replacementEvents.length,
      ok: true
    });

    await reset();
    await recordMemory('final-clean-profile');
    assertNoCrashes('complete matrix');
    writeReport(true);
  }
  catch (error) {
    runError = error;
    writeReport(false, error);
  }
  finally {
    const detach = await settleWithin(cdp.detach(), 3000);
    const close = await settleWithin(browser.close(), 5000);
    const processCleanup = await terminateBrowserProcess(browserProcess);
    const fixtureCleanup = await settleWithin(fixture.stop(), 5000);
    await sleep(750);
    const crashes = findCrashDumps(profile);
    const cleanup = {browser: close, cdp: detach, fixture: fixtureCleanup, process: processCleanup};
    if (!report) {
      writeReport(false, runError || Error('matrix stopped before producing a report'));
    }
    report.cleanup = cleanup;
    report.crashes = crashes;
    if (crashes.length && !runError) {
      runError = Error(`browser produced ${crashes.length} crash dump(s)`);
      report.error = {reasonCode: publicFailureReason(runError)};
      report.ok = false;
    }
    if ((!processCleanup.exited || fixtureCleanup.status !== 'fulfilled') && !runError) {
      runError = Error('isolated browser or fixture server did not clean up completely');
      report.error = {reasonCode: publicFailureReason(runError)};
      report.ok = false;
    }
    if (!retainProfile) {
      try {
        removeIsolatedProfile();
        cleanup.profile = {removed: true, retained: false};
      }
      catch (error) {
        cleanup.profile = {
          reasonCode: publicFailureReason(error),
          removed: false,
          retained: fs.existsSync(profile)
        };
        const cleanupError = Error('isolated browser profile cleanup failed');
        runError ||= cleanupError;
        report.error ||= {reasonCode: publicFailureReason(cleanupError)};
        report.ok = false;
      }
    }
    else {
      cleanup.profile = {explicit: true, removed: false, retained: true};
    }
    persistReport();
  }

  if (runError) {
    throw runError;
  }
  process.stdout.write(`${JSON.stringify({
    browser: report.browser,
    cleanup: report.cleanup,
    crashes: report.crashes,
    extension: report.extension,
    matrix: scenarios.map(scenario => ({name: scenario.name, ok: scenario.ok})),
    resultFile: path.basename(resultPath)
  }, null, 2)}\n`);
};

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ok: false, reasonCode: publicFailureReason(error)}));
    process.exitCode = 1;
  });
}

module.exports = {createEarlyFailureReport, nativeMenuDiagnosticsFromOutput, sanitizePopupReport};
