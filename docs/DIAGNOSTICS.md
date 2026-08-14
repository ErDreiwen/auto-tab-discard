# Integrated diagnostics

Bulk popup commands write a small, structured diagnostic incident. When an
action is not fully successful, expand **Diagnostics** in the popup to see the
fixed failure groups, copy the report, or download `latest.log`. The Options
page offers the same log as `auto-tab-discard-latest.log` plus a **Clear
diagnostic history** control.

The text log intentionally resembles a conventional application `latest.log`:
each line has an ISO timestamp, severity, component, incident ID, and fixed
key/value fields. Outcome lines include a stable stage and reason code, for
example:

```text
[2030-01-02T03:04:05.000Z] [AutoTabDiscard/ERROR] incident=ATD-... stage=eligibility reason=UNSUPPORTED_PAGE code=TAB_UNSUPPORTED count=47
```

The incident ID lets a screenshot, copied log, and support bundle refer to the
same command without exposing the affected tabs.

## Privacy and limits

Diagnostic history is local and is never uploaded automatically. The journal
uses an allowlist rather than attempting to clean arbitrary debug output. It
does **not** store URLs, page titles, hostnames, site rules, tab/window/group
identifiers, raw browser errors, stack traces, filesystem paths, or the full
user-agent string. Existing console debugging is not copied into the journal
because it can contain browsing data.

The journal keeps at most 12 incidents for seven days and is capped at 256 KiB.
Old incidents are removed as whole records. Incognito/private-window commands
are not written to durable storage. Clearing diagnostic history removes only
the diagnostic journal.

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
  settle through its bounded recovery pipeline.
- `ownership-resolution / OWNERSHIP_RESOLUTION_FAILED` or
  `ownership-finalization / OWNERSHIP_FINALIZATION_FAILED`: durable ownership
  could not be read or committed authoritatively.
- `release / RELEASE_FAILED`: the verified release pipeline did not reach a
  stable loaded state.
- `tab-operation / OPERATION_FAILED`: the browser operation failed or its final
  state could not be verified. Retain the incident ID and sanitized log when
  reporting this case.

The log is evidence, not an instruction to weaken protections. Retry is kept as
an explicit user action and preserves the original Shift/force modifier.
