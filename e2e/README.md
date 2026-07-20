# Real-browser popup matrix

`popup-matrix.cjs` launches Chrome-for-Testing with a new temporary profile and the local `v3` directory as an unpacked extension. It never attaches to a personal Chrome or Edge profile and it never defaults to an installed browser executable.

The matrix clicks the real popup controls and verifies:

- all seven discard commands;
- all five release controls and their enabled/disabled state;
- a real Shift+click release through the popup, including its forwarded bypass-cache modifier;
- release of one scope containing `self`, `adopted`, and `claimed` ownership markers;
- current-window, left, right, other-window, all-window, and native tab-group boundaries;
- normal in-place adoption of an existing discard with no reload;
- Shift takeover of an adopted discard with exactly one wake and one native discard;
- the configured `💤` title prefix on ordinary self-discards and physical takeovers;
- `loading -> complete -> unloaded` ordering on a deliberately held response, plus instrumented proof that every
  injected stop script settles before the service worker invokes native `tabs.discard`;
- repeat-command no-ops, a final quiescence dwell, process-memory snapshots, and zero Crashpad dumps.

## Run

Install Playwright in the normal Node resolution path, or set `CODEX_NODE_MODULES`/`PLAYWRIGHT_PATH` to an existing Playwright runtime. Use a Chrome-for-Testing or Playwright Chromium executable that still supports unpacked-extension command-line flags.

```powershell
node e2e/popup-matrix.cjs --executable "C:\path\to\chrome-for-testing\chrome.exe"
```

The browser opens visible temporary windows while the matrix runs. Every run uses a unique profile under
`e2e/.profiles/`; successful runs delete it after browser/process/crash verification, while failed runs retain it for
diagnosis. Reports remain under `e2e/results/`. Both directories are ignored by Git.

The harness rejects `msedge.exe` unless `--allow-edge` is also passed. That opt-in still uses a fresh isolated profile, but avoids accidentally launching Edge while it is the user's active browser.

The script exits nonzero on the first failed invariant but still writes a full JSON report with tab events, ownership changes, HTTP request lifecycle, memory samples, and any crash-dump metadata.

Chrome's extension/CDP APIs do not expose browser-chrome pixels such as Edge's native sleeping-tab badge. The matrix uses the authoritative tab state (`discarded: true`, `status: unloaded`) for that native condition and separately asserts the extension's visible `💤` title prefix.
