# Auto Tab Discard reliability fork

This fork keeps the upstream extension's behavior and addresses Chromium failures reported against the `0.6.8.2` store build.

## Changes in 0.6.8.11

- Quiesce the one-time Shift takeover reload before calling `tabs.discard()`, apply the configured sleep-title prefix, and prevent Chromium from discarding a live navigation with a stale loading spinner or renderer behind.
- Retry the immediate `window.stop()` injection within a shared deadline and a small attempt cap while the awakened tab still reports `status: loading`; this covers renderer commits plus Chrome's known removed/not-ready/no-frame handoff errors without retrying permission or error-page failures.
- Fail a takeover instead of issuing native discard if the reload cannot leave the loading state inside the bounded takeover window.
- Require fresh inactive `discarded: true` / `status: unloaded` reads both before and after ownership finalization, so a callback clone cannot falsely tag a tab that the user woke concurrently.
- Add an isolated real-Chromium popup matrix covering all seven discard rows, all five release controls, exact group/window/left/right scopes, adoption, Shift takeover, repeat no-ops, slow-response quiescence, memory snapshots, and browser crash dumps.

## Changes in 0.6.8.10

- Adopt already-discarded tabs in place on a normal command, recording `source: adopted` without calling `tabs.reload()` or allocating the page back into memory.
- Make Shift the deliberate physical-upgrade path: one wake followed by one verified native discard changes `adopted` to `source: self`.
- Reclassify tabs that wake during adoption back into the loaded discard pipeline, wait for overlapping ownership attempts, and preserve ownership when a discarded tab moves between windows.
- Cover real Chromium group selection so normal group commands never touch, reload, or discard an out-of-group tab.

## Changes in 0.6.8.9

- Make fresh ownership takeover explicit-command only. Background discard events are tagged but never wake a tab, and startup resumes only a takeover that an earlier worker had already woken.
- Limit a requested takeover to one reload and one native discard attempt. Contention is recorded without alarms, delayed retries, or a reload fight with another extension.
- Remove the release feedback path that could reload a tab again when a competing extension re-discarded it.
- Keep genuine reload -> native discard -> verified `source: self` behavior for all seven popup discard commands.

## Changes in 0.6.8.8

- Replace bookkeeping-only `claimed` adoption with a genuine takeover: reload the external discard, wait for `discarded: false`, then issue a fresh native discard.
- Record `source: self` only after Chromium returns a strong successful discard result; bounded contention retries never relabel another extension's discard as self.
- Deduplicate and serialize takeovers from popup commands, new external discard events, and legacy/pre-existing `claimed` tabs at worker startup.
- Make all seven discard commands await their takeover work, while the five release controls cancel any pending takeover before waking a tab.
- Let a release bypass unrelated queued takeovers, and use persisted alarms to retry genuine contention after a Manifest V3 worker sleeps or restarts.

## Changes in 0.6.8.7

- Apply ownership explicitly to every popup discard scope: tab, tab group, current window, right, left, other windows, and all other tabs.
- Re-read and claim already-discarded targets inside the selected command scope; if a stale snapshot has woken, return it to the normal eligibility and tagged native-discard pipeline.
- Make every matching release control reload its discarded targets and clear ownership when Chromium reports `discarded: false`, without erasing a newer concurrent discard.
- Share and test the exact query, positional filtering, active-keeper, ownership, Shift-force, release, and X-control behavior used by the popup commands.

## Changes in 0.6.8.6

- Persist a per-tab ownership tag in `chrome.storage.session` before every native discard request.
- Distinguish confirmed extension discards (`self`) from untagged browser/extension discards adopted by this fork (`claimed`).
- Detect newly discarded, restored, and pre-existing discarded tabs and claim them without waking or reloading their pages.
- Clear ownership on release, navigation, tab closure, and tab replacement, with attempt tokens preventing late callbacks from restoring stale ownership.
- Serialize ownership writes so simultaneous bulk discards and tab lifecycle events cannot overwrite one another.

## Changes in 0.6.8.5

- Make **Discard Tab Group** use Chromium's native `groupId`, including group ID `0`.
- Restrict the command to tabs in the selected tab's window and group; highlighted tabs outside the group are never included.

## Changes in 0.6.8.4

- Keep popup message channels open until each discard or release command actually finishes, including on current Edge and Chrome MV3 service workers.
- Route clicks from nested popup elements to their command row, and keep the popup open with a visible error when a command fails.
- Await bulk-discard, keyboard-command, navigation, and release work instead of reporting success before the browser APIs complete.
- Bound favicon/title preparation so an unresponsive page cannot hold the discard queue forever.
- Initialize popup state only after the active tab is known, avoiding a race in the left/right release controls.

## Changes in 0.6.8.3

- Read the configured toolbar action from `chrome.storage` instead of `localStorage`, which is unavailable in a Manifest V3 service worker.
- Initialize preferences and per-worker setup whenever Chromium creates a fresh service worker, while keeping true browser-start actions scoped to browser startup.
- Preserve a valid recurring alarm across worker wakes instead of postponing it each time the worker starts or the alarm fires.
- Keep bulk discards within the configured concurrency limit until `tabs.discard` actually completes, with bounded error handling.
- Bound metadata injection time so one frozen tab cannot stall an entire bulk-discard run.
- Use the standard composed event path when detecting edited form controls inside shadow DOM.

## Test

Run `node --test tests/*.test.mjs` from a POSIX shell, or `node --test (Get-ChildItem tests/*.test.mjs)` from PowerShell. The `v3` directory has no build step and is the unpacked Chrome/Edge extension root.

See `e2e/README.md` for the isolated real-browser matrix.
