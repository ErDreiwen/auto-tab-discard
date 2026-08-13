# External control-plane smoke test

`external-api-smoke.cjs` is the real-browser acceptance gate for the extension-to-extension discard API. It launches an
explicit Chrome-for-Testing or Chromium executable with a new profile and exactly two unpacked extensions:

- the target artifact passed with `--extension` (the repository's `v3` tree by default); and
- a temporary controller extension generated inside that run's isolated directory.

It never attaches to an existing Chrome or Edge process or profile. Microsoft Edge is deliberately rejected by this
harness so the second-extension gate remains independent of the Edge and popup suites.

## Coverage

Before the controller is trusted, hostile query/forced fields, malformed IDs, an oversized batch, an active tab, and a
real incognito tab must all receive the same fixed `UNAUTHORIZED` response. For each request, the harness compares the
complete fixture state, target-tab lifecycle events, and HTTP request counters to prove zero tab mutation or reload.

The harness then explicitly writes only the generated controller ID to `external.trusted-ids`. Extra query/forced
fields, malformed IDs, and a 26-tab batch must still fail the strict schema without mutation. One valid request names an
eligible tab, a loaded `autoDiscardable: false` tab, an active tab, and an inactive incognito tab. The eligible tab alone
must become an extension-owned discard; the other three must remain unchanged and receive exact sanitized per-tab
outcomes in request order.

The result is replaced at `e2e/results/external-api-smoke.json`. It records the target manifest version and tree SHA-256,
fixed scenario labels/outcomes, fixture request counts, and cleanup assertions. It omits extension IDs, tab/window IDs,
extension origins, fixture URLs/tokens, executable and profile paths, and raw browser diagnostics.

The strict release gate also runs this smoke with its supplied Chrome executable against the digest-named tree extracted
from the generated ZIP. A pass is recorded as `chrome-external-api-smoke` evidence only when the report passes and its
extension tree SHA-256 exactly matches that artifact; missing Chrome execution, a failed report, or a digest mismatch
blocks final provenance packaging.

## Run

Install Playwright in the normal Node resolution path, or set `CODEX_NODE_MODULES`/`PLAYWRIGHT_PATH` to an existing
Playwright runtime. Pass an explicit browser; there is no installed-browser default.

```powershell
node e2e/external-api-smoke.cjs --executable "C:\path\to\chrome-for-testing\chrome.exe"
```

To test an extracted release artifact instead of the working tree:

```powershell
node e2e/external-api-smoke.cjs `
  --executable "C:\path\to\chrome-for-testing\chrome.exe" `
  --extension "C:\path\to\extracted-artifact"
```

Pass `--headed` only for isolated diagnosis. Every run creates a uniquely named child beneath `e2e/.profiles/`, enables
incognito access only for the temporary target installation, asserts shutdown of the exact launched Chrome child (with
an exact-PID process-tree fallback), scans for crash artifacts, and removes only that verified child directory. Cleanup
failures make the smoke fail and are included in the sanitized result.

This document describes how to run the gate; it is not evidence that a real-browser run occurred. Preserve the JSON
result from the release environment as the execution evidence.
