# Browser channel canaries

The browser-canary workflow independently builds the deterministic Chromium ZIP and Firefox XPI from fresh Linux and
Windows checkouts. Both builders attest their clean commit and Git tree, runner image, both actual archive byte streams,
both normalized extension trees, both complete path/size/content inventories, metadata, and version.
`artifact-reproducibility-gate` rejects a missing builder or any disagreement in either browser target. The Linux result
is the sole canonical artifact pair. Its Chromium ZIP tree runs in five isolated Windows profiles: Chrome Stable, Chrome
Beta, Edge Stable, Edge Beta, and the declared Chrome minimum. Stable/Beta Chromium channels run the full popup matrix;
the minimum channel runs a dedicated compatibility smoke in the exact old public Playwright page realm. Its Firefox XPI
runs two separate gates: an exact Firefox 140 minimum startup/install probe and the Firefox Stable WebDriver BiDi discard
smoke. Every browser record contains its explicit artifact family, observed browser version, matching archive SHA-256,
matching normalized extension-tree SHA-256, runner image, installer provenance, and target-specific capabilities.

The final `browser-canary-gate` consumes the cross-builder report and rejects it unless both canonical archives, trees,
inventories, and the shared version equal the appropriate artifact referenced by all seven browser records. Chrome or Edge
evidence cannot satisfy the Firefox binding, and Firefox evidence cannot satisfy a Chromium binding. Windows' independent
build is comparison evidence, never a second untracked test or release candidate. A workflow definition or local unit run
does not prove two clean machines agreed; only the retained passing GitHub Actions attestations for a commit provide that
evidence.

The manifest currently declares Chrome 102. The minimum job therefore uses Playwright 1.22.2's pinned Chromium
102.0.5005.40 engine rather than silently testing a modern browser. Its dedicated smoke requires that exact full version,
the exact Playwright 1.22.2 driver, the packaged module service-worker target, an options page on the same extension origin with the expected runtime ID and
manifest version, and a real `storage` message/response round trip through the worker. It also binds the extracted ZIP
tree digest and requires zero crashes, exact process exit, and profile removal. This older runner is confined to a
disposable GitHub Actions VM and a fresh extension profile. The smoke uses a short opaque profile name and rejects a
profile root whose managed-storage LevelDB path would reach legacy Windows `MAX_PATH`, which Chromium 102 otherwise
surfaces as a hanging `storage.managed` callback. If acquisition stops working, the canary stays red until the
declared minimum is deliberately raised or another reproducible Chrome-102 source is adopted.

The manifest also declares Firefox 140.0. The minimum job uses the fully pinned `browser-actions/setup-firefox` action,
then reads `--version` from the returned executable and rejects anything other than exactly 140.0. It temporarily installs
the canonical XPI itself with WebDriver BiDi's `archivePath` input on a Windows 2022 runner. A checked controller uses
`STARTUPINFOEX` to create the suspended browser atomically associated with a kill-on-close kernel Job before its first
instruction; the gate requires zero active Job
processes and controller exit, without PID-only termination. Firefox 140 still exposes its CDP compatibility
endpoint, so the minimum-only probe uses its ordinary new-tab target to open the installed extension controller. From
that same-origin page it resolves the real `/firefox/background.html` with `runtime.getBackgroundPage`, verifies the
compatibility/core module order, calls the core runtime message handler, and observes the initialized badge color. It
does not request WebDriver system access or use `moz:scope`. The report binds both the XPI byte hash
and its extracted normalized tree. Crash evidence includes isolated minidumps/events plus bounded before/after snapshots
of the canonical Windows crash-report and pending-ping stores; it cannot pass unless those remain clean, the Job is empty,
and its isolated profile is deleted. Firefox Stable retains the broader BiDi discard behavior suite and the same direct
external-crash and exact-Job cleanup gates.

Stable and Beta use `browser-actions/setup-chrome`; Edge Stable and Beta use `browser-actions/setup-edge`; Firefox 140
uses `browser-actions/setup-firefox`; Firefox Stable uses the binary maintained on the GitHub-hosted Windows runner image
and records its observed version. The
harness continues to reject Edge unless its explicit `--allow-edge` isolation flag is supplied. Every run creates and
removes a disposable profile; no job attaches to an existing browser profile.

Quarantines live in `.github/browser-canary-policy.json`. A quarantine is invalid unless it names one target, an owning
GitHub `@handle`, a real future `YYYY-MM-DD` expiry, a useful reason, and the exact failure kinds it accepts. Expired,
duplicate, blanket, or unowned quarantines fail policy loading. Missing evidence and artifact-hash disagreement cannot be
quarantined.

The scheduled run occurs weekly and the same gates also run for pushes and pull requests. Branch protection should
require both `artifact-reproducibility-gate` and `browser-canary-gate`. The latter is green only after all seven target
records have been combined, checked against the correct member of the canonical uploaded artifact pair, and bound to the
passing cross-builder attestation. The protected-tag signer consumes that gate and signs both distinct subjects together.
