# Integrated diagnostics

Auto Tab Discard keeps a deep, structured action history on the local device.
The history is intended to reconstruct a difficult failure rather than merely
repeat its final counter. It records fixed, sanitized events for:

- popup control clicks, requests, responses, progress, retries, cancellation,
  diagnostic copy/download/clear, and Options opening;
- context-menu, toolbar, and keyboard command admission and completion;
- command scope, eligibility, metadata, keeper, ownership, native-discard,
  verification, marker, takeover, release, and finalization stages;
- automatic scans, alarms, startup/restart recovery, and reset boundaries;
- Options controls such as save, import/export, reset, permission changes, and
  the optional conflict scan.

Events in one action share an opaque correlation token. Every record also has
an ordered sequence number and an offset from the start of its browser session.
This makes worker restarts, retries, and long-running sessions visible without
storing tab or site identity.

The popup still shows the command's compact incident summary and can copy or
download that incident as `latest.log`. Options downloads the complete bounded
history as `auto-tab-discard-session-history.log`. History lines use ISO time,
session-relative `offset_ms`, a monotonic `seq`, severity, fixed event/source/
stage/outcome codes, and aggregate counts. A typical line resembles:

```text
[2030-01-02T03:04:05.000Z] [AutoTabDiscard/ERROR] session=ATDS-... offset_ms=9200 seq=117 event=ACTION_END source=popup command=discard-window phase=completion outcome=FAILED failed=47 skipped=19
```

## Privacy and limits

Diagnostic history is local and is never uploaded automatically. The journal
projects every entry through strict allowlists; it does not try to clean an
arbitrary console message after the fact. It never stores URLs, titles,
hostnames, site rules, tab/window/group identifiers, extension identifiers,
raw browser errors, stack traces, filesystem paths, filenames, setting values,
imported file contents, or the full user-agent string. Existing console output
is not copied into the journal because it can contain browsing data.

Durable history is bounded to 10,000 records, 64 browser sessions, 30 days, and
4 MiB. Pruning removes the oldest records/sessions first. A browser-session
identity is kept in `storage.session`, so MV3 service-worker suspension does not
start a false new session. A normal browser-session boundary creates a new
session. Private-window activity stays memory-only and is never merged into the
durable Options export. Clearing diagnostics removes retained records while
keeping the current session clock monotonic for later events; uninstalling or
clearing extension data removes the extension-owned state.

Diagnostic writes are best-effort and bounded so logging cannot gain authority
over a tab operation or hang the extension. A storage failure may therefore
leave a gap, but it cannot make a failed browser action appear successful.

## Extension-conflict check

Options has an optional **Check extension conflicts** control. It requests the
browser's `management` permission only from that explicit click, performs a
read-only scan, then reports aggregate signals: duplicate Auto Tab Discard
copies, other enabled discard/suspend managers, tab managers, external
placeholder tabs, and externally discarded sleepers. The scan never stores or
exports extension names, IDs, paths, permissions, URLs, or per-tab identity.
You can remove the optional access immediately from the same section.

The scan is evidence, not attribution. For example, external sleepers can be
caused by another extension or by the browser's own memory-saving feature. A
repeat test with the suspected component disabled is still needed to establish
causation.

## Reading common reason codes

- `eligibility / PROTECTION_RULE`: the tab matched a protection rule and was
  deliberately skipped.
- `eligibility / UNSUPPORTED_PAGE`: the browser does not allow the required
  operation for that page type.
- `keeper / NO_SAFE_KEEPER`: the active tab could not be changed safely; select
  or open another tab and retry.
- `verification / OWNERSHIP_UNKNOWN` or `SUSPENSION_UNKNOWN`: the browser did
  not expose enough trustworthy final state, so the extension failed closed.
- `release / POSTCONDITION_NOT_MET`: a release was requested but the browser
  still reported the tab as frozen.
- `scope-query / SCOPE_QUERY_FAILED`: the browser could not provide the exact
  command scope; no tabs are mutated on this path.
- `metadata-check / METADATA_CHECK_FAILED`: a protected-state or renderer
  metadata check could not finish safely.
- `native-discard / NATIVE_REJECTED`, `NATIVE_TIMEOUT`, or
  `NATIVE_POSTCONDITION_FAILED`: the native browser request was rejected,
  exceeded its strict bound, or returned without the required unloaded state.
- `takeover / TAKEOVER_FAILED`: a suspended-tab ownership takeover did not
  settle through its bounded recovery pipeline. Repeated takeover failures are
  a strong reason to run the conflict scan and check for duplicate installs.
- `ownership-resolution / OWNERSHIP_RESOLUTION_FAILED` or
  `ownership-finalization / OWNERSHIP_FINALIZATION_FAILED`: durable ownership
  could not be read or committed authoritatively.
- `release / RELEASE_FAILED`: the verified release pipeline did not reach a
  stable loaded state.
- `tab-operation / OPERATION_FAILED`: the browser operation failed or its final
  state could not be verified.

The log is evidence, not an instruction to weaken protections. Retry remains an
explicit user action and retains the original Shift/force modifier.
