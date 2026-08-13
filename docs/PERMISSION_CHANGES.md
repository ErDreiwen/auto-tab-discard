# Permission and store-policy report for 0.6.9.2

Baseline: upstream 0.6.9.1 Manifest V3 permission snapshot in `tests/fixtures/release/manifest-permissions-0.6.9.1.json`.

## Permission change report

- Added extension permissions: none.
- Removed extension permissions: none.
- Current extension permissions: `alarms`, `contextMenus`, `idle`, `notifications`, `scripting`, `storage`.
- Added host permissions: none.
- Removed host permissions: none.
- Current host permissions: `*://*/*`.

`tests/manifest-policy.test.mjs` derives this report from the current manifest and the checked-in baseline. It also checks the declared name/version, Manifest V3, the permission allowlist, local background code, forbidden update/signing keys, and Firefox's explicit `data_collection_permissions.required: ["none"]` declaration.

## Why each privilege exists

| Privilege | Required use | Boundary |
| --- | --- | --- |
| `alarms` | Periodic automatic-discard checks and bounded retry/catch-up. | Named extension alarms only; no remote scheduling. |
| `contextMenus` | The explicit tab/page/action discard commands. | User-invoked entries; restricted schemes are classified before mutation. |
| `idle` | Optional idle-time protection chosen in settings. | Reads browser idle state only. |
| `notifications` | Optional local failure/status notification. | No notification content is sent off-device. |
| `scripting` | Read local protection signals and apply the sleep title/favicon marker. | Top frame by default; bounded subframe probes only when form/media guards require them. |
| `storage` | Preferences, bounded recovery intent, and ownership markers. | Private versioned records; diagnostics strip IDs, URLs, and secrets. |
| `*://*/*` | Protect forms/media and mark user-requested discards on ordinary web pages. | HTTP(S)/FTP-style web pages only. Browser-internal, extension, file, data, and unsupported schemes fail closed or use a native physical-only fallback. |

The host grant remains required because protection checks and marker preparation must run on arbitrary sites selected by the user or automatic policy. Optional host permission would make automatic checks nondeterministic and could discard a page merely because permission to inspect its protection state had not been granted. The extension therefore keeps the declared all-sites grant but couples it to static privilege-diff CI, top-frame document-start injection, bounded on-demand subframe work, strict unsupported-scheme handling, and no content-to-network path.

The content scripts inspect only boolean/local state needed for protection (dirty form, media/PiP, notification state) and communicate solely through `chrome.runtime` to this extension. They contain no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, dynamic remote import, or external-extension message target. A static privacy test enforces that boundary.

## Submission blockers

`docs/release-policy.json` now pins the fork-owned product name, GitHub homepage, and Gecko ID and rejects a regression to the upstream identity. Documentation may cite upstream listings only when they are explicitly labelled as references. This identity policy is separate from the unchanged permission budget.

The bare SHA-256 recorded for these notes remains a reproducibility digest, not a signature by itself. The protected-tag workflow is configured to bind the normalized in-archive digest into a signed custom in-toto release predicate after the cross-builder and browser gates, and the strict verifier independently recomputes that binding. Its complete action dependency chain uses immutable full-SHA pins, and its custom trusted root must match the reviewed SHA-256 pinned in release policy. The actual hosted attestation run is still pending. This GitHub provenance signature is also distinct from browser-store signing: the generated XPI remains unsigned AMO input until Mozilla signs it.
