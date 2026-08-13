# Edge direct-native release and restart race gate

`edge-direct-native-races.cjs` loads the requested extension tree unchanged in a disposable Edge profile. It exercises
all five release commands through the genuine popup-message path against mixed Edge-frozen and native-discarded or
replacement targets. Each in-scope target must receive one explicit release request, become stably loaded, and remain
inactive; each out-of-scope sleeper must remain unchanged.

The same run exercises public popup cancellation while a takeover is queued, before native invocation, while the native
result is pending, and after physical replacement has settled. Raw CDP attaches only to the extension driver, disposable
`edge://discards` controls, and the service worker; it never attaches to a fixture renderer. Debugger commands are limited
to source-derived breakpoints and MV3 service-worker termination before invocation, immediately after invocation, or
after replacement settlement. Auto-attach instruments each restarted worker before it resumes, so the report can count entries to the single
`tabs.discard` call site and reject a duplicate native call. Restart must preserve an ambiguous
`direct-native-pending` fence or reconcile an unloaded successor as `physical-only`; explicit release then fails closed
or performs one verified reload.

Every pass or failure replaces `e2e/results/edge-direct-native-races.json`. The sanitized report contains the canonical
tree digest/version, phase counts and state evidence, request deltas, and cleanup facts. Exact child exit, zero crash
artifacts, fixture shutdown, and isolated-profile removal are verdict requirements.

```powershell
node e2e/edge-direct-native-races.cjs --executable "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --allow-edge
```

The strict release gate runs this harness only against its extracted preliminary artifact and writes the result beneath
the gate evidence directory. It accepts exactly the five named release scopes, four named cancellation phases, and three
named worker-termination boundaries, and independently requires the report's canonical tree digest to equal the archive
inventory. Exact isolated-child exit, zero crash artifacts, fixture shutdown, and profile removal are also gate
requirements. A standalone or earlier source-tree report is never reused as release evidence.
