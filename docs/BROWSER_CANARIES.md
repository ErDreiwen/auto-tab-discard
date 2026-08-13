# Browser channel canaries

The browser-canary workflow independently builds the deterministic extension archive from fresh Linux and Windows
checkouts. Both builders attest their clean commit and Git tree, runner image, actual ZIP/XPI bytes, normalized extension
tree, complete path/size/content inventory, metadata, and version. `artifact-reproducibility-gate` rejects a missing
builder or any disagreement. The Linux result is the sole canonical artifact; that exact uploaded archive then runs in
five isolated Windows profiles: Chrome Stable, Chrome Beta, Edge Stable, Edge Beta, and the declared Chrome minimum.
Every browser record contains the observed browser version, canonical archive SHA-256, normalized extension-tree
SHA-256, runner image, installer provenance, and capabilities proved by the popup matrix.

The final `browser-canary-gate` consumes the cross-builder report and rejects it unless the canonical archive, tree,
inventory, and version equal the artifact referenced by all browser evidence. Windows' independent build is comparison
evidence, never a second untracked test or release candidate. A workflow definition or local unit run does not prove two
clean machines agreed; only the retained passing GitHub Actions attestations for a commit provide that evidence.

The manifest currently declares Chrome 102. The minimum job therefore uses Playwright 1.22.2's pinned Chromium
102.0.5005.40 engine rather than silently testing a modern browser. This older runner is confined to a disposable GitHub
Actions VM and a fresh extension profile. If that acquisition stops working, the canary stays red until the declared
minimum is deliberately raised or another reproducible Chrome-102 source is adopted.

Stable and Beta use `browser-actions/setup-chrome`; Edge Stable and Beta use `browser-actions/setup-edge`. The harness
continues to reject Edge unless its explicit `--allow-edge` isolation flag is supplied. No job attaches to an existing
browser profile.

Quarantines live in `.github/browser-canary-policy.json`. A quarantine is invalid unless it names one target, an owning
GitHub `@handle`, a real future `YYYY-MM-DD` expiry, a useful reason, and the exact failure kinds it accepts. Expired,
duplicate, blanket, or unowned quarantines fail policy loading. Missing evidence and artifact-hash disagreement cannot be
quarantined.

The scheduled run occurs weekly and the same gates also run for pushes and pull requests. Branch protection should
require both `artifact-reproducibility-gate` and `browser-canary-gate`. The latter is green only after all five target
records have been combined, checked against the canonical uploaded artifact, and bound to the passing cross-builder
attestation.
