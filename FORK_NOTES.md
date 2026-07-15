# Auto Tab Discard reliability fork

This fork keeps the upstream extension's behavior and addresses Chromium failures reported against the `0.6.8.2` store build.

## Changes in 0.6.8.3

- Read the configured toolbar action from `chrome.storage` instead of `localStorage`, which is unavailable in a Manifest V3 service worker.
- Initialize preferences and per-worker setup whenever Chromium creates a fresh service worker, while keeping true browser-start actions scoped to browser startup.
- Preserve a valid recurring alarm across worker wakes instead of postponing it each time the worker starts or the alarm fires.
- Keep bulk discards within the configured concurrency limit until `tabs.discard` actually completes, with bounded error handling.
- Bound metadata injection time so one frozen tab cannot stall an entire bulk-discard run.
- Use the standard composed event path when detecting edited form controls inside shadow DOM.

## Test

Run `node --test "tests/*.test.mjs"` from the repository root. The `v3` directory has no build step and is the unpacked Chrome/Edge extension root.
