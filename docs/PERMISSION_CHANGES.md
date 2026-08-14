# Permission and store-policy report for 0.6.9.2

Baseline: upstream 0.6.9.1 Manifest V3 permission snapshot in `tests/fixtures/release/manifest-permissions-0.6.9.1.json`.

## Permission change report

- Added extension permissions: none.
- Removed extension permissions: none.
- Current extension permissions: `alarms`, `contextMenus`, `idle`, `notifications`, `scripting`, `storage`.
- Added optional extension permissions: `webNavigation`.
- Removed optional extension permissions: none.
- Current optional extension permissions: `webNavigation`.
- Added host permissions: none.
- Removed host permissions: none.
- Current host permissions: `*://*/*`.
- Added optional host permissions: none.
- Removed optional host permissions: none.
- Current optional host permissions: none.

`tests/manifest-policy.test.mjs` derives all four required/optional API/host reports from the current manifest and the checked-in baseline. It also checks the declared name/version, Manifest V3, separate required and optional permission allowlists, local background code, forbidden update/signing keys, and Firefox's explicit `data_collection_permissions.required: ["none"]` declaration.

## Why each privilege exists

| Privilege | Required use | Boundary |
| --- | --- | --- |
| `alarms` | Periodic automatic-discard checks and bounded retry/catch-up. | Named extension alarms only; no remote scheduling. |
| `contextMenus` | The explicit tab/page/action discard commands. | User-invoked entries; restricted schemes are classified before mutation. |
| `idle` | Optional idle-time protection chosen in settings. | Reads browser idle state only. |
| `notifications` | Optional local failure/status notification. | No notification content is sent off-device. |
| `scripting` | Read local protection signals and apply the sleep title/favicon marker. | Marker work is top-frame-only. Protection probes target no more than 64 enumerated subframes and 32 bounded watcher starts; production contains no `allFrames` scripting target. |
| `storage` | Preferences, bounded recovery intent, and ownership markers. | Private versioned records; diagnostics strip IDs, URLs, and secrets. |
| `webNavigation` (optional) | Enumerate ephemeral frame/document identities so every subframe within the physical cap can be targeted exactly. | Requested only from the disclosed Options button. It is never requested by the worker or popup; returned URLs and identities are discarded after each collection and never stored or logged. |
| `*://*/*` | Protect forms/media and mark user-requested discards on ordinary web pages. | HTTP(S)/FTP-style web pages only. Browser-internal, extension, file, data, and unsupported schemes fail closed or use a native physical-only fallback. |

The host grant remains required because protection checks and marker preparation must run on arbitrary sites selected by the user or automatic policy. Optional host permission would make automatic checks nondeterministic and could discard a page merely because permission to inspect its protection state had not been granted. The extension therefore keeps the declared all-sites grant but couples it to static privilege-diff CI, top-frame document-start injection, bounded worker-facing subframe results and watcher batches, strict unsupported-scheme handling, and no content-to-network path.

`webNavigation` is optional, not required. Chrome documents its warning as “Read your browsing history,” so Options explains that wording before a direct user click synchronously calls `permissions.request`. Users can remove the grant from the same section. Adding the optional declaration does not add a required install/update warning, and a denied or absent grant never causes a partial-clean decision: one top-targeted fallback checks at most 64 same-origin descendants, while cross-origin, churned, oversized, late rich/PDF-editor, and retained-value-limit branches stay protected. Ordinary controls use reversible baselines capped at 64 entries, 2,048 characters per retained value, and 16,384 retained characters per frame; detached controls are pruned, and uncertain rich/PDF records retain no page content.

With the grant, `getAllFrames` output is immediately projected to sorted ephemeral frame/document identity pairs; URLs never enter retained state. The first snapshot must bind the top metadata result and every targeted probe to the exact document, and the second snapshot must reproduce every top/subframe identity before watcher work begins. Duplicate, malformed, mixed, missing, or changed identities; more than 64 subframes; API failure; missing probe results; and watcher churn all fail closed. Browsers such as Chrome 102 that do not expose document identities remain supported: the optional permission is off by default so the bounded no-grant fallback remains useful, while a granted identity-less scan stays protected after its single top-frame start. At the 64-frame boundary, the maximum remains exactly 97 physical script starts per metadata collection (one top metadata start, 64 probes, and 32 watcher starts). A 1,000-subframe enumeration starts no subframe script.

The content scripts inspect only boolean/local state needed for protection (dirty form, media/PiP, notification state) and communicate solely through `chrome.runtime` to this extension. They contain no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, dynamic remote import, or external-extension message target. A static privacy test enforces that boundary.

## Submission blockers

`docs/release-policy.json` now pins the fork-owned product name, GitHub homepage, and Gecko ID and rejects a regression to the upstream identity. Documentation may cite upstream listings only when they are explicitly labelled as references. This identity policy is separate from the unchanged required permission budget and the disclosed optional frame-enumeration grant.

The bare SHA-256 recorded for these notes remains a reproducibility digest, not a signature by itself. The protected-tag workflow is configured to bind the normalized in-archive digest into a signed custom in-toto release predicate after the cross-builder and browser gates, and the strict verifier independently recomputes that binding. Its complete action dependency chain uses immutable full-SHA pins, and its custom trusted root must match the reviewed SHA-256 pinned in release policy. The actual hosted attestation run is still pending. This GitHub provenance signature is also distinct from browser-store signing: the generated XPI remains unsigned AMO input until Mozilla signs it.
