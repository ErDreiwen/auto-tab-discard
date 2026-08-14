# Auto Tab Discard
A browser extension which uses the native tab discarding method (`chrome.tabs.discard`) to automatically reduce memory usage of inactive tabs. This extension is more efficient and should be less buggy compared to the alternatives extensions that use DOM replacement method.

## Reliability fork

This repository branch hardens external-discard ownership, bulk command scoping, reload quiescence, visible sleep markers, Manifest V3 restart recovery, and Firefox compatibility. See [FORK_NOTES.md](FORK_NOTES.md) for the versioned behavior changes.

Release 0.6.9.2 has passed its isolated Chrome 151 popup matrix and Firefox 153 WebDriver BiDi smoke. Edge 151.0.4129.72 passed the 19-scenario popup matrix and the current-tree direct-native matrix covering all five release scopes, four cancellation boundaries, and three worker-loss boundaries. The redesigned native-frozen smoke requires a direct physical discard with zero activation, scripting, loading, or document requests and a truthful visual-unavailable record. The final Chromium and Firefox artifact trees must each pass their browser-specific gates before release.

Run the single release gate from a clean repository root, supplying isolated browser executables:

```sh
node scripts/release-gate.mjs --chrome-executable PATH --edge-executable PATH --firefox-executable PATH
```

The gate runs the full Node suite, migration fixtures, manifest/store-policy lint, deterministic browser-specific packaging, safe extraction/inventory comparison, and the existing browser harnesses against the matching extracted artifact. It records the Git commit and tree, each target archive/tree/inventory digest, release-note digest, permission report, and hashed test-evidence references. Without a valid protected-tag attestation it still retains a reproducible candidate and reports `candidateReady`, but remains blocked for release. It fails on a dirty or transitional Git worktree, nested source root, forbidden files, identity/version/archive-name drift, missing evidence, a tested-tree mismatch, or missing/invalid signed release provenance.

The generated ZIP/XPI contains this README and the MPL-2.0 license. The strict
gate requires real extracted-artifact update, worker/browser restart, and
rollback runs in Chrome and Edge; fixture coverage alone is never described as
browser-upgrade proof. See [docs/RELEASE_PACKAGING.md](docs/RELEASE_PACKAGING.md)
for artifact, provenance, blockers, and signing details.

### Fork identity and signing

This fork uses its own name, GitHub homepage, and Gecko ID (`{b3b398c4-27bc-46b6-9447-f07deec6aeba}`), distinct from upstream. A protected-tag GitHub Actions job is configured to attest the exact ZIP/XPI pair and normalized release-note/policy/evidence bindings after the two-machine and browser-channel gates. The complete producer/signing action chain uses immutable full-SHA pins, and offline verification accepts only the reviewed policy-pinned trusted-root snapshot; an actual hosted signing run is still pending. This provenance attestation is separate from Mozilla distribution signing: the generated XPI remains unsigned AMO submission input and is not normally installable until Mozilla signs it. The links below are retained solely as clearly labelled upstream references, not as fork listings.

All install/update/uninstall navigation is disabled by default, strictly
allowlisted, and documented in [docs/LIFECYCLE_NAVIGATION.md](docs/LIFECYCLE_NAVIGATION.md).

Bulk-command failures now produce a bounded, local, privacy-safe incident
journal with grouped reason codes and a downloadable `latest.log`. See
[docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) for the popup controls, log format,
retention limits, and excluded browsing data.

The full reliability backlog is mirrored in
[docs/RELIABILITY_ISSUE_MATRIX.md](docs/RELIABILITY_ISSUE_MATRIX.md): exactly 25
current issues and 35 forward risks, each with 4–7 independently verifiable
subissues and a link to its GitHub tracking record.

The iframe-heavy P18 item still has one explicit browser-bound gap: result
retention is capped, but `scripting.executeScript({allFrames: true})` starts
before that cap can apply. This release does not add the warned
`webNavigation` permission or regress every framed page to fail-closed merely
to overstate that boundary. The retained stress evidence and permission
decision are documented in [docs/PERMISSION_CHANGES.md](docs/PERMISSION_CHANGES.md).

### Preview

[![IMAGE ALT TEXT HERE](https://img.youtube.com/vi/S0rHU38OnTE/0.jpg)](https://www.youtube.com/watch?v=S0rHU38OnTE)

### Links

The following are the upstream project's published listings; they are not separate fork releases.

  * Homepage: https://webextension.org/listing/tab-discard.html
  * Privacy Policy: https://webextension.org/privacy-policy/extension/tab-discard.html
  * Chrome: https://chrome.google.com/webstore/detail/auto-tab-discard/jhnleheckmknfcgijgkadoemagpecfol
  * Edge: https://microsoftedge.microsoft.com/addons/detail/auto-tab-discard/nfkkljlcjnkngcmdpcammanncbhkndfe
  * Firefox: https://addons.mozilla.org/firefox/addon/auto-tab-discard/
  * Opera: https://addons.opera.com/en/extensions/details/auto-tab-discard/
  * Product Review: https://webextension.org/blog/2022/04/17/auto-tab-discard-extension.html
  * Preview: https://www.youtube.com/watch?v=S0rHU38OnTE
