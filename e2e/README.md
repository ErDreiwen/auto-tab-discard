# Real-browser popup matrix

`popup-matrix.cjs` launches Chrome-for-Testing with a new temporary profile and the local `v3` directory as an unpacked extension. It never attaches to a personal Chrome or Edge profile and it never defaults to an installed browser executable.
The extension's shipped plugin defaults stay enabled, including the blank-helper keeper path.

The matrix clicks the real popup controls and verifies:

- all seven discard commands;
- a browser-generated `chrome.contextMenus.onClicked` entry: the harness temporarily exposes one uniquely named page
  item, opens the native context menu, selects that exact accessible name through Windows UI Automation constrained to
  the isolated browser process tree, and observes the event independently in the live worker before accepting the
  resulting `discard-tab` state;
- all five release controls and their enabled/disabled state;
- a real Shift+click release through the popup, including its forwarded bypass-cache modifier;
- release of one scope containing both `self` and `claimed` ownership markers;
- current-window, left, right, other-window, all-window, and native tab-group boundaries;
- normal physical takeover of every in-scope external discard for group/scoped commands with exactly one wake and one
  native discard;
- a fresh, independent fixture for every scoped Shift command, with an in-scope loaded
  `autoDiscardable: false` target proving the override is real rather than a post-normal self-owned no-op;
- repeat normal/Shift invocations leaving every previously self-owned sleeper asleep, preserving exactly one title
  prefix, and keeping the browser-exposed favicon value byte-stable; other-window/all-window repeats separately report
  newly rotated live keepers;
- the configured `💤` title prefix plus authoritative ownership-marker confirmation that favicon and complete visual
  preparation succeeded on ordinary self-discards and physical takeovers;
- `loading -> complete -> unloaded` ordering on a deliberately held response, plus instrumented proof that every
  injected stop script settles before the service worker invokes native `tabs.discard`;
- external-sleeper takeovers under both favicon-only and combined title/favicon settings;
- a restricted-scheme bulk scope containing real `file:`, `data:`, inline-PDF, browser-internal, and extension pages
  wherever the browser permits them. Every available tab ID must receive a terminal protected, handled, or unsupported
  disposition; rejected or substituted creations are reported as unavailable capabilities rather than claimed as passes;
- release snapshots proving ownership stays absent and the original title/favicon remain restored through the disabled
  repeat-control dwell, a final quiescence dwell, process-memory snapshots, and zero Crashpad dumps.

`discard-tab` is intentionally exercised as the real active, loaded popup command. Browsers wake an inactive discarded tab
when it is activated, and the popup can only target the active tab; therefore a claimed external sleeper cannot truthfully
be fed to a second `discard-tab` popup click without the test itself causing the wake. External-sleeper ownership transfer
is covered by the group and all five scoped commands instead, while the direct row records this limitation explicitly.

## Run

Install Playwright in the normal Node resolution path, or set `CODEX_NODE_MODULES`/`PLAYWRIGHT_PATH` to an existing Playwright runtime. Use a Chrome-for-Testing or Playwright Chromium executable that still supports unpacked-extension command-line flags.

```powershell
node e2e/popup-matrix.cjs --executable "C:\path\to\chrome-for-testing\chrome.exe"
```

The browser opens visible temporary windows while the matrix runs. The native-context-menu case is Windows-only and
uses process-tree-scoped Windows UI Automation to invoke its unique temporary `ZATD E2E Discard Tab` item by exact
accessible name. Its native menu remains visible during selection, so do not interact with the isolated test browser or
dismiss that menu while the case is active. Every run uses a unique profile under
`e2e/.profiles/` and deletes it after browser/process/crash verification, including after a failed assertion. Pass
`--retain-profile` only when an isolated failing profile is explicitly needed for local diagnosis. Reports remain under
`e2e/results/`. Both directories are ignored by Git.

The harness rejects `msedge.exe` unless `--allow-edge` is also passed. That opt-in still uses a fresh isolated profile,
disables Edge background networking and implicit Microsoft sign-in features, and never reads or reports account identity
data. It avoids accidentally launching Edge while it is the user's active browser.

In Edge mode, every observed `tabs.onReplaced` pair must resolve through one retained lineage. Edge does not reliably
replace a tab in every run, so the report distinguishes `observed-and-asserted` from
`not-observed-by-this-edge-run`; absence is recorded as a coverage result and is never presented as replacement proof.

```powershell
node e2e/popup-matrix.cjs --executable "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --allow-edge
```

The script exits nonzero on the first failed invariant but still writes a sanitized JSON report with tab events,
ownership changes, HTTP request lifecycle, memory samples, and any crash-dump metadata. The report boundary keeps only
stable relative or redacted values and reason codes: it never persists local paths, OS process IDs, error stacks, or
captured stdout/stderr.

Chrome's extension/CDP APIs do not expose browser-chrome pixels such as Edge's native sleeping-tab badge. The matrix uses the authoritative tab state (`discarded: true`, `status: unloaded`) for that native condition and separately asserts the extension's visible `💤` title prefix.
Chromium can also keep `Tab.favIconUrl` set to the document's original favicon URL after an injected favicon is painted.
The matrix therefore treats `ownership.visual.favicon === true` and `ownership.visual.complete === true` as the
authoritative sleep-favicon result, asserts that the API-exposed value does not drift on repeats, and only requires the
original fixture favicon URL once a released document has reloaded and exposes it again.

## Edge frozen-tab smoke test

`edge-frozen-smoke.cjs` uses Node 24's built-in WebSocket client and a fresh Edge profile; it never connects to a
personal profile or attaches DevTools to either fixture tab. It runs two sequential frozen phases through
`edge://discards`: combined title/favicon and favicon-only. Each phase schedules a real one-shot `number.check` alarm,
independently observes exactly one `chrome.alarms.onAlarm` event, follows any Edge tab-ID replacement, and requires the
automatic path to call native discard exactly once with zero target activation, renderer scripting, reload/loading, focus
change, or document request. Because Edge's already-frozen renderer cannot accept a title/favicon write, the final
ownership record truthfully marks a physical-only discard with `complete`, `favicon`, `title`, and `repair` all false;
the requested title marker remains metadata only. Repeating the command is a strict browser no-op that retains the
visual-unavailable warning. Before Freeze, the fixture proves the target is hidden and unfocused and resets its bounded
page-event baseline; after Freeze the harness never scripts or debugger-attaches that renderer.

Edge's frozen-keeper group-helper case is delegated to this raw-CDP smoke rather than claimed by
`popup-matrix.cjs`. The explicit reason code is `playwright-debugger-prevents-native-freeze`: Playwright attaches to
the matrix fixture renderers, and Edge does not preserve its native Freeze state on those debugger-attached pages. The
raw smoke creates and freezes its fixture without attaching a debugger to that fixture, so only that harness may report
the frozen-keeper helper capability and direct physical conversion. Its default-plugin group phase anchors the real popup command to the active grouped root,
creates and commits exactly one blank helper as the safe keeper, and settles the loaded root, native-frozen child, and
externally discarded child. It also proves the frozen protected peer and outside highlighted/discarded peers remain
untouched. The native-frozen child is reported truthfully as physically discarded with its visual indicator unavailable.
After closing the fixture window, the harness invokes the production helper-registry cleanup path and requires that its
single committed helper record is reaped; it never erases the session key directly.

Every pass or failure writes `e2e/results/edge-frozen-smoke.json`. The sanitized result contains the tested extension's
relative file tree, canonical tree SHA-256, and manifest version, per-phase alarm evidence and fixture request counts, bounded boolean/count-only
pulse evidence, final and dwell ownership/title/favicon snapshots, activation/loading/focus summaries, and cleanup
evidence. It omits tab/window IDs,
profile paths, extension origins, fixture tokens, and loopback endpoints. Cleanup is part of the verdict: fixture shutdown, the exact Edge child exit (including the
forced-tree-kill path), crash scanning, and isolated-profile removal are asserted and cleanup failures make the run fail.
The file is replaced by the next Edge frozen smoke run.

```powershell
node e2e/edge-frozen-smoke.cjs --executable "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --allow-edge
```

## Chromium minimum compatibility smoke

`chromium-minimum-smoke.cjs` is the narrow gate for the manifest's declared Chrome minimum. A checked Windows
controller uses `STARTUPINFOEX` to create the pinned Chromium suspended and atomically associated with a
kill-on-close kernel Job, verifies that association, and only then resumes it;
Playwright 1.22.2 connects over CDP to that fresh profile and extracted release ZIP tree. It never evaluates inside
Playwright's old service-worker realm: Chromium 102 exposes the target there, but that realm does not provide the
extension `chrome` API. Instead the smoke observes the real `/worker/core.mjs` target through public Playwright APIs,
opens the packaged options page on the target's extension origin, validates runtime ID and manifest version there, and
sends a `storage` message whose two sentinels must return through the module worker.

The report binds the normalized extracted-tree SHA-256, exact browser version, and exact Playwright driver version. The
short opaque profile name keeps Chromium 102's Windows managed-storage LevelDB path below legacy `MAX_PATH`; an
overlong caller-supplied profile root is rejected before launch. Its packaged managed schema also deliberately omits the
top-level `additionalProperties` keyword, which Chromium 102 cannot parse without hanging before DevTools; explicit
policy catalog parity and the settings transaction validator retain fail-closed coverage for supported and unknown keys.
A pass additionally requires no crash dumps, a CDP PID
matching the controller-created browser handle, an explicit CDP `Browser.close` request with no forced Job termination,
kernel Job `ACTIVE_PROCESS_ZERO`, controller exit, and only then deletion
of the isolated profile. This is intentionally a compatibility proof; current Chrome and Edge channels continue to run the full
popup matrix.

```powershell
node e2e/chromium-minimum-smoke.cjs `
  --executable "C:\path\to\playwright-1.22.2\chromium\chrome.exe" `
  --expected-version 102.0.5005.40 `
  --expected-playwright-version 1.22.2 `
  --extension "C:\path\to\the-extracted-chromium-zip"
```

## Firefox WebDriver BiDi smoke test

`firefox-bidi-smoke.cjs` launches the requested Firefox executable headlessly with a unique disposable profile and
connects directly through Node 24's built-in WebSocket and raw WebDriver BiDi. It installs the local `v3` directory temporarily with
`webExtension.install`, opens the installed extension's popup in Firefox's documented isolated chrome scope, and runs
both `discard-tab` and the scoped `discard-window` popup-message paths. It checks Firefox's authoritative
`discarded: true` state (Firefox documents `Tab.status` as only `loading` or `complete`), the
sleep-title marker whenever Firefox exposes the title, one initial fixture request per document, a stable no-wake dwell,
no extra navigation start (even an aborted request), no post-settlement loading/activation/undiscard transition, and zero
crash artifacts.

Firefox blocks a normal content context from navigating to `moz-extension://`. The full Stable suite therefore starts only its
fresh test process with `--remote-allow-system-access`, uses `browsingContext.getTree` with `moz:scope: "chrome"` for the
single operation that opens the temporary extension controller, and never points automation at a personal profile. The
checked Windows controller uses `STARTUPINFOEX` to create Firefox suspended and atomically associated with a
non-breakaway kill-on-close kernel Job, verifies that association, and resumes it only after ownership exists. Every
protocol operation is time-bounded; cleanup requires zero active
Job processes and controller exit, verifies the profile remains beneath `e2e/.profiles/`, and retains it when exact exit
cannot be proved. A sanitized JSON
report is always written beneath `e2e/results/`.

```powershell
node e2e/firefox-bidi-smoke.cjs --executable "C:\Program Files\Mozilla Firefox\firefox.exe"
```

The declared-minimum lane uses the same lifecycle and fail-closed cleanup but a deliberately narrower compatibility
mode. It requires the exact XPI and Firefox version, installs that archive temporarily with BiDi `archivePath`, and uses
Firefox 140's ordinary CDP new-tab endpoint to open the installed extension controller. The controller resolves the real
`/firefox/background.html` with `runtime.getBackgroundPage`; the gate requires the compatibility module before the core
module, a successful core runtime-message round trip, and the startup-initialized badge color.
This lane never enables system access and never sends `moz:scope`; its report records the XPI SHA-256 and normalized
extracted-tree SHA-256 before asserting crash-free process exit and profile removal. Minimum mode is Windows-only. It
keeps crash reporting non-reporting, scans isolated minidumps/events, and diffs bounded content snapshots of the
canonical Windows ApplicationData `Crash Reports` and `Pending Pings` stores. The kernel Job captures every descendant
from Firefox's first instruction without PID-based termination.

```powershell
node e2e/firefox-bidi-smoke.cjs --minimum-startup-only --expected-version 140.0 `
  --archive "C:\path\to\auto-tab-discard-canary.xpi" `
  --extension "C:\path\to\the-extracted-xpi" `
  --executable "C:\path\to\Firefox-140\firefox.exe"
```

Pass `--headed` only when visually diagnosing the isolated run. The protocol choices follow Mozilla's
[raw BiDi connection guide](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection), the
[W3C WebExtension install command](https://w3c.github.io/webdriver-bidi/#command-webExtension-install), and Mozilla's
[system-access security guidance](https://firefox-source-docs.mozilla.org/remote/Security.html#system-access).
