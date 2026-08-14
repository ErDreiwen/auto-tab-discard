# Reliability issue matrix

This is the repository-local index for the exact 25 current and 35 potential reliability issues maintained in GitHub. Each issue has 4–7 independently checkable subissues. GitHub remains the status authority; this file makes count, scope, and review coverage auditable from a source checkout.

- Repository: `ErDreiwen/auto-tab-discard`
- Last fully validated branch baseline: `hardened/0.6.9.1-reliability` at `0dcf3fac4638f2fdcd98fea8674cf5143576648a`
- Baseline workflow: [Browser channel canaries run 31807745155](https://github.com/ErDreiwen/auto-tab-discard/actions/runs/31807745155)
- Baseline result: reproducible Linux/Windows packages, seven browser lanes, and aggregate browser gate all passed
- Audited: 2026-08-14

## Current issues (25)

### C01 — Secure the external discard API control plane

GitHub: [#4](https://github.com/ErDreiwen/auto-tab-discard/issues/4) · Checklist: 5/5

- [x] Remove the external API unless explicitly enabled, or enforce an extension-ID allowlist.
- [x] Validate method, query fields, and `forced` through a strict schema.
- [x] Route authorized calls through the same ownership, takeover, and safety pipeline as UI commands.
- [x] Return per-tab settled outcomes instead of input IDs.
- [x] Add hostile-sender, malformed-request, and authorized-integration tests.

### C02 — Enforce protection rules before normal sleeper takeovers

GitHub: [#3](https://github.com/ErDreiwen/auto-tab-discard/issues/3) · Checklist: 7/7

- [x] Apply URL, pin, and `autoDiscardable` protections before waking a suspended target.
- [x] Define conservative behavior when renderer-only metadata is unavailable.
- [x] Centralize an explicit Shift/force bypass policy.
- [x] Return protected sleepers separately from successful takeovers.
- [x] Test every protection against discarded and Edge-frozen targets.
- [x] Overlay managed policy after local preferences, including canonical plugin aliases.
- [x] Persist Firefox session protections across worker restarts, tab replacement, and closure pruning.

### C03 — Stop reporting failed loaded discards as successful commands

GitHub: [#2](https://github.com/ErDreiwen/auto-tab-discard/issues/2) · Checklist: 5/5

- [x] Make `discard` return a structured settled outcome.
- [x] Aggregate direct, Shift, and normal-check outcomes.
- [x] Reject a command when all intended targets fail.
- [x] Report partial success with concise per-tab reasons.
- [x] Add false-return tests for all seven discard commands.

### C04 — Add a live settlement fence to ordinary native discards

GitHub: [#1](https://github.com/ErDreiwen/auto-tab-discard/issues/1) · Checklist: 5/5

- [x] Reuse the bounded unloaded-state fence for ordinary discards.
- [x] Require inactive, `discarded:true`, and `status:"unloaded"`.
- [x] Run final self-ownership confirmation before success.
- [x] Follow Edge tab-ID replacement during settlement.
- [x] Test callback success followed by immediate activation/wake.

### C05 — Separate repairable visual gaps from Edge physical-only ownership

GitHub: [#5](https://github.com/ErDreiwen/auto-tab-discard/issues/5) · Checklist: 5/5

- [x] Persist title, favicon, repairability, and overall visual completeness independently from physical ownership.
- [x] Schedule exactly one bounded repair takeover for an ordinary incomplete self marker or later title loss.
- [x] Record an already-frozen direct discard as self-owned `physicalOnly` with `repair:false`.
- [x] Make a repeat command on physical-only ownership a strict no-op with `TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE`.
- [x] Cover preparation failure, title loss, physical-only first success, and repeat stability without a reload loop.

### C06 — Route automatic Edge-frozen tabs through zero-wake direct native ownership

GitHub: [#7](https://github.com/ErDreiwen/auto-tab-discard/issues/7) · Checklist: 6/6

- [x] Classify frozen tabs before renderer metadata collection.
- [x] Fail closed when form, media, picture-in-picture, notification, or readiness protections cannot be verified while frozen.
- [x] Persist a direct-native intent before issuing the single native discard.
- [x] Follow replacement lineage and require a stable authoritative unloaded state before claiming ownership.
- [x] Record requested visuals as explicitly unavailable instead of waking the renderer.
- [x] Exercise combined and favicon-only settings through a real `number.check` Edge alarm.

### C07 — Release Edge-frozen and discarded tabs with one verified reload

GitHub: [#9](https://github.com/ErDreiwen/auto-tab-discard/issues/9) · Checklist: 6/6

- [x] Include both `discarded:true` and inactive `frozen:true` tabs in release availability.
- [x] Union matching in-flight takeover jobs that ordinary discarded queries omit.
- [x] Cancel and fence ownership work before reading the authoritative live target.
- [x] Reload each releasable target exactly once with `bypassCache:false` by default, then require two stable loaded reads.
- [x] Invalidate only the same ownership generation and preserve out-of-scope or concurrently rediscarded tabs.
- [x] Capture all five release scopes against real Edge frozen/discarded targets, including replacement and pending-intent cases.

### C08 — Discard inactive group children when no keeper exists

GitHub: [#8](https://github.com/ErDreiwen/auto-tab-discard/issues/8) · Checklist: 6/6

- [x] Split blocked active targets from independently eligible inactive candidates.
- [x] Discard eligible inactive children even without a keeper.
- [x] Preserve the active root and report an explicit partial result.
- [x] Make every entry point inspect the returned blocked status.
- [x] Add loaded, frozen, external, and mixed no-keeper group tests.
- [x] Bound and validate recursive Tree Style Tab descendants so sidebar commands always settle.

### C09 — Cancel takeover reloads without leaving a spinner or RAM load

GitHub: [#6](https://github.com/ErDreiwen/auto-tab-discard/issues/6) · Checklist: 5/5

- [x] Track whether each takeover initiated a reload.
- [x] On cancellation, stop or deliberately complete that navigation.
- [x] Wait for a stable nonloading state before cancellation resolves.
- [x] Preserve release intent so the job cannot rediscard.
- [x] Add a slow-response cancellation test with request and dwell assertions.

### C10 — Harden release inputs, staging, and output-path containment

GitHub: [#10](https://github.com/ErDreiwen/auto-tab-discard/issues/10) · Checklist: 5/5

- [x] Bind strict release bytes to the recorded immutable Git tree and reject mutable or aliased inputs.
- [x] Reject symlink, junction, nonregular, repository-escape, and unverified recursive-delete paths.
- [x] Validate final output and source non-overlap before any filesystem mutation.
- [x] Stage the complete artifact set and reject linked, multiply linked, or partial final targets.
- [x] Cover Windows and POSIX traversal, case, ADS, hardlink, junction-swap, and mutation races.

Historical resolution: the original Edge-frozen activation-pulse complaint remains covered by the direct-native zero-activation browser gates; this current slot now tracks the release-path defects found during the integrated diagnostic build.

### C11 — Cancel and fence in-flight takeovers before release

GitHub: [#11](https://github.com/ErDreiwen/auto-tab-discard/issues/11) · Checklist: 7/7

- [x] Compute release availability from both live suspension state and the public takeover-job snapshot.
- [x] Acquire a synchronous per-tab release reservation before cancellation, live reads, or reload.
- [x] Re-cancel under that reservation rather than trusting a stale caller hint.
- [x] Preserve durable `direct-native-pending` intent and fail closed while its native result remains ambiguous.
- [x] Follow replacement lineage without admitting unrelated active tabs or clearing a newer ownership attempt.
- [x] Capture real Edge cancellation at queued, native-pending, replacement, and settled boundaries.
- [x] Revalidate explicit normal-window and privacy scope for every live native boundary and attachment.

### C12 — Replace the global takeover queue with safe bounded scheduling

GitHub: [#12](https://github.com/ErDreiwen/auto-tab-discard/issues/12) · Checklist: 5/5

- [x] Add a bounded-concurrency scheduler.
- [x] Serialize only activation pulses sharing a window/focus domain.
- [x] Run independent discarded-tab takeovers concurrently where safe.
- [x] Add progress and priority cancellation.
- [x] Benchmark 25- and 100-target mixed batches.

### C13 — Prevent timed-out preparation scripts from mutating tabs later

GitHub: [#14](https://github.com/ErDreiwen/auto-tab-discard/issues/14) · Checklist: 5/5

- [x] Give preparation attempts generation tokens.
- [x] Make stale script results no-op.
- [x] Install listeners only while the attempt owns the tab.
- [x] Clean listeners on timeout and lifecycle changes.
- [x] Test late script resolution after discard and navigation.

### C14 — Reconcile ambiguous and timed-out native discard outcomes

GitHub: [#13](https://github.com/ErDreiwen/auto-tab-discard/issues/13) · Checklist: 5/5

- [x] Reconcile ambiguous outcomes from authoritative live state.
- [x] Keep the nonce fence until settlement or safe abandonment.
- [x] Separate external races from missing callback payloads.
- [x] Prevent late native completion from becoming claimed ownership.
- [x] Test undefined results and completion after both timeout fences.

### C15 — Fail closed on unknown ownership instead of destructive takeover

GitHub: [#15](https://github.com/ErDreiwen/auto-tab-discard/issues/15) · Checklist: 5/5

- [x] Add an explicit `unknown-ownership` classification.
- [x] Never wake unknown targets under a normal command.
- [x] Permit forced retry only after a fresh successful read.
- [x] Surface retryable classification failures.
- [x] Test storage failures for self-owned and external sleepers.

### C16 — Handle or explicitly report non-HTTP tabs in bulk scopes

GitHub: [#17](https://github.com/ErDreiwen/auto-tab-discard/issues/17) · Checklist: 5/5

- [x] Query geometric scope broadly before capability classification.
- [x] Use native discard where renderer scripting is unavailable.
- [x] Define an indicator fallback for restricted pages.
- [x] Return explicit unsupported/protected outcomes.
- [x] Test file, extension, PDF, data, and internal pages in Edge and Chrome.

### C17 — Honor marker settings when available and report Edge visual unavailability

GitHub: [#16](https://github.com/ErDreiwen/auto-tab-discard/issues/16) · Checklist: 6/6

- [x] Share one title/favicon preparation and completeness model across ordinary and renderer-available takeover paths.
- [x] Carry title marker, favicon, delay, rollback, and generation settings through bounded preparation.
- [x] Persist title and favicon outcomes separately.
- [x] Record already-frozen targets as physical-only with requested visuals unavailable and no repair attempt.
- [x] Return localized first-success and repeat visual-unavailable popup outcomes.
- [x] Cover renderer-available combined/favicon-only marking and real Edge physical-only combined/favicon-only alarms.

### C18 — Surface context-menu, toolbar, and keyboard command failures

GitHub: [#18](https://github.com/ErDreiwen/auto-tab-discard/issues/18) · Checklist: 7/7

- [x] Wrap every entry point in a shared command runner.
- [x] Notify or badge non-popup failures.
- [x] Include command name and concise target reasons.
- [x] Preserve tab API failures and malformed responses through fail-closed popup state instead of empty success.
- [x] Inject failures through context menu, shortcut, and toolbar tests.
- [x] Normalize the legacy `click.discard` action value to the canonical discard command.
- [x] Bridge private Firefox popup tab operations through a validated runtime-message contract.

### C19 — Make the default blank plugin use the core keeper predicate

GitHub: [#19](https://github.com/ErDreiwen/auto-tab-discard/issues/19) · Checklist: 6/6

- [x] Reuse the core keeper predicate.
- [x] Exclude frozen, unloaded, highlighted, in-progress, and target-group tabs identically.
- [x] Revalidate after asynchronous plugin work.
- [x] Run real-browser matrices with defaults enabled.
- [x] Add a group fixture with only frozen outside candidates.
- [x] Keep every visible and managed plugin preference in exact parity with a real loader implementation.

### C20 — Make blank helper tabs transactional and recoverable

GitHub: [#20](https://github.com/ErDreiwen/auto-tab-discard/issues/20) · Checklist: 5/5

- [x] Track helper IDs per command transaction.
- [x] Create helpers only where an active target truly needs replacement.
- [x] Roll back helpers on failure/cancellation.
- [x] Clean orphaned helpers after worker restart.
- [x] Test failure, cancellation, and zero-target commands with defaults.

### C21 — Route every release plugin through ownership cancellation

GitHub: [#23](https://github.com/ErDreiwen/auto-tab-discard/issues/23) · Checklist: 5/5

- [x] Route release features through the shared release executor.
- [x] Cancel matching takeover first.
- [x] Resolve Edge replacement lineage before waking.
- [x] Await stable loaded state and ownership cleanup.
- [x] Add concurrent takeover tests for every release plugin.

### C22 — Make automatic metadata scans bounded and single-flight

GitHub: [#21](https://github.com/ErDreiwen/auto-tab-discard/issues/21) · Checklist: 5/5

- [x] Add a single-flight automatic scan scheduler.
- [x] Fetch metadata with bounded concurrency.
- [x] Supersede stale scans after relevant changes.
- [x] Enforce a total deadline with explicit skipped results.
- [x] Add 100-tab slow/hung timing and memory tests.

### C23 — Cover common unsaved-form edits and prevented submissions

GitHub: [#25](https://github.com/ErDreiwen/auto-tab-discard/issues/25) · Checklist: 5/5

- [x] Track input, change, beforeinput, paste, and contenteditable mutations.
- [x] Cover controls changed without alphanumeric keydown.
- [x] Clear dirty state only after genuine submit/navigation/reset.
- [x] Handle dynamic controls and shadow DOM.
- [x] Add browser tests for each edit and prevented submit.

### C24 — Prune ownership ID maps after close and replacement churn

GitHub: [#22](https://github.com/ErDreiwen/auto-tab-discard/issues/22) · Checklist: 5/5

- [x] Delete current generation state on logical-tab removal.
- [x] Remove predecessor generation state after safe migration.
- [x] Clean every transient map during reconciliation.
- [x] Keep cleanup safe under persistence failure.
- [x] Add thousands-of-tabs churn tests with map-size assertions.

### C25 — Clear session ownership and active jobs during settings reset

GitHub: [#24](https://github.com/ErDreiwen/auto-tab-discard/issues/24) · Checklist: 5/5

- [x] Clear the ownership session key during reset.
- [x] Cancel active jobs before clearing.
- [x] Reconcile live tabs after reset/reload.
- [x] Define visual title/favicon repair semantics.
- [x] Test self, claimed, pending, and replacement states.


## Potential issues (35)

### P01 — Guard Edge suspension-state contract drift without waking unknown tabs

GitHub: [#27](https://github.com/ErDreiwen/auto-tab-discard/issues/27) · Checklist: 5/5

- [x] Centralize frozen capability as absent, false, transitional, true, or unknown.
- [x] Centralize suspension classification for loaded, active, frozen, discarded, and unknown states.
- [x] Fail closed for malformed or transitional unknown state without ownership, scripting, wake, or discard.
- [x] Preserve direct-native intent across both-false transitions and replacement IDs.
- [x] Cover all supported and drifted combinations and the real Edge direct-discard transition.

### P02 — Superseded: remove activation-event ordering from Edge takeover correctness

GitHub: [#28](https://github.com/ErDreiwen/auto-tab-discard/issues/28) · Checklist: 5/5

- [x] Remove target activation callbacks and events from frozen-takeover progress.
- [x] Re-read live active/frozen state immediately before the native operation.
- [x] Follow replacement-aware tab lineage through native settlement.
- [x] Reconcile duplicate, late, or missing native state observations idempotently.
- [x] Prove the real Edge path completes with zero activation events.

### P03 — Harden ownership against lifecycle replacement reordering

GitHub: [#26](https://github.com/ErDreiwen/auto-tab-discard/issues/26) · Checklist: 4/4

- [x] Define one logical-tab transition model for ownership and discard jobs.
- [x] Make migration idempotent under duplicate/reversed events.
- [x] Handle collisions when source and destination both contain state.
- [x] Test every predecessor callback in multi-hop chains.

### P04 — Normalize future native-discard result shapes

GitHub: [#29](https://github.com/ErDreiwen/auto-tab-discard/issues/29) · Checklist: 4/4

- [x] Normalize callback and Promise variants in one adapter.
- [x] Treat live postcondition as authoritative while retaining result provenance.
- [x] Version settlement invariants by browser family.
- [x] Bound new intermediate states without weakening active-tab safety.

### P05 — Replace English scripting-error matching with robust taxonomy

GitHub: [#30](https://github.com/ErDreiwen/auto-tab-discard/issues/30) · Checklist: 4/4

- [x] Prefer structured browser error codes.
- [x] Fall back to post-error tab/frame state.
- [x] Maintain a sanitized cross-version error corpus.
- [x] Explicitly classify permission, close, policy, and transient cases.

Evidence scope: the [versioned retained corpus](../tests/fixtures/browser-error-corpus.v1.json)
contains sanitized scripting-rejection observations from passing Chrome
151.0.7922.34 and Chrome 152.0.7977.42 reports. Other taxonomy and localized
inputs are labeled synthetic contract or adversarial vectors. The exact Chrome
102, Edge 151, and Firefox 153 reports captured no scripting-error message, so
they are recorded as coverage gaps and are not claimed as message provenance.

### P06 — Revalidate tab-group membership at execution time

GitHub: [#31](https://github.com/ErDreiwen/auto-tab-discard/issues/31) · Checklist: 4/4

- [x] Capture selected tab/window/group identity as a scope token.
- [x] Re-query membership immediately before keeper activation.
- [x] Abort or recompute when selected identity changes.
- [x] Inject move/regroup/ungroup races during queued work.

### P07 — Define command scopes for Edge Workspaces and new window types

GitHub: [#34](https://github.com/ErDreiwen/auto-tab-discard/issues/34) · Checklist: 4/4

- [x] Specify scope for normal, popup, app, incognito, and workspace windows.
- [x] Resolve selected window explicitly and filter an allowed set.
- [x] Add an incognito/non-normal window policy.
- [x] Build multi-window fixtures for hidden, minimized, app, and workspace-like contexts.

### P08 — Keep Edge-frozen takeover independent of keeper changes

GitHub: [#32](https://github.com/ErDreiwen/auto-tab-discard/issues/32) · Checklist: 5/5

- [x] Make inactive frozen takeover independent of keeper selection, activation, closure, movement, or replacement.
- [x] Keep active-root blank-helper handling isolated from frozen-child ownership.
- [x] Never select or wake frozen outside candidates as keepers.
- [x] Follow the frozen child's replacement lineage independently of helper identity.
- [x] Pass the real Edge active-group/default-helper scenario with frozen inside and outside targets.

### P09 — Treat tab-query errors as failures, not empty success

GitHub: [#33](https://github.com/ErDreiwen/auto-tab-discard/issues/33) · Checklist: 4/4

- [x] Normalize query callbacks/Promises and reject on lastError.
- [x] Attach command/scope context to errors.
- [x] Retry only known transient idempotent failures.
- [x] Return final errors through command responses.

### P10 — Await authoritative release completion

GitHub: [#35](https://github.com/ErDreiwen/auto-tab-discard/issues/35) · Checklist: 4/4

- [x] Normalize reload callback/Promise and lastError.
- [x] Await a bounded fresh `discarded:false` postcondition.
- [x] Separate API acceptance from wake completion.
- [x] Return per-tab release outcomes.

### P11 — Resume safely after MV3 eviction during direct native Edge discard

GitHub: [#36](https://github.com/ErDreiwen/auto-tab-discard/issues/36) · Checklist: 6/6

- [x] Persist `direct-native-pending` before invoking the native discard.
- [x] Carry the pending attempt across replacement, attach, and both-false transitional observations.
- [x] Treat ambiguity as an indefinite physical fence rather than expiring into an automatic retry.
- [x] Make startup reconciliation idempotent and prohibit a second script, reload, or native discard.
- [x] Make release fail closed until the persisted native boundary is authoritative.
- [x] Force real Edge service-worker termination before invocation, during native wait, and across replacement settlement.

### P12 — Persist resumable ordinary-discard queue intent

GitHub: [#37](https://github.com/ErDreiwen/auto-tab-discard/issues/37) · Checklist: 4/4

- [x] Give queued jobs stable IDs and persist only resumable intent.
- [x] Revalidate live eligibility before resuming.
- [x] Clear expired in-progress records at startup.
- [x] Distinguish completed, resumed, cancelled, and lost outcomes.

### P13 — Version and harden ownership persistence lifecycle

GitHub: [#38](https://github.com/ErDreiwen/auto-tab-discard/issues/38) · Checklist: 4/4

- [x] Introduce a versioned marker/phase envelope.
- [x] Recover session loss without a broad wake sweep.
- [x] Expire malformed and future-version records.
- [x] Migrate between session and local fallback without duplication.

### P14 — Bound ownership storage write amplification

GitHub: [#39](https://github.com/ErDreiwen/auto-tab-discard/issues/39) · Checklist: 4/4

- [x] Measure bytes and queue latency per mutation.
- [x] Use per-tab records or journaled deltas.
- [x] Coalesce adjacent updates while preserving order.
- [x] Recover quota failures without blocking native discard.

### P15 — Bound replacement-lineage retention

GitHub: [#40](https://github.com/ErDreiwen/auto-tab-discard/issues/40) · Checklist: 4/4

- [x] Reference-count lineage from attempts, jobs, markers, and callbacks.
- [x] Prune predecessors after all related work settles.
- [x] Periodically reconcile aliases against live tabs.
- [x] Expose privacy-safe test diagnostics for map size.

### P16 — Eliminate cross-window takeover head-of-line blocking

GitHub: [#41](https://github.com/ErDreiwen/auto-tab-discard/issues/41) · Checklist: 4/4

- [x] Schedule by window/focus domain.
- [x] Preserve single-flight per logical tab.
- [x] Give cancellation priority over unstarted work.
- [x] Apply independent global CPU/network limits.

### P17 — Bound metadata scan latency in very large sessions

GitHub: [#42](https://github.com/ErDreiwen/auto-tab-discard/issues/42) · Checklist: 4/4

- [x] Add a configurable small concurrency pool.
- [x] Enforce a total check deadline.
- [x] Ignore stale results after a newer check begins.
- [x] Preserve oldest-tab ordering despite out-of-order metadata.

### P18 — Limit all-frame injection cost on iframe-heavy pages

GitHub: [#43](https://github.com/ErDreiwen/auto-tab-discard/issues/43) · Checklist: 5/5

- [x] Separate top-frame data from aggregate frame requirements.
- [x] Inject subframes only for form/media protection.
- [x] Cap/batch worker-facing results and tolerate frame churn after browser injection.
- [x] Benchmark a 1,000-frame fixture and prove an over-cap page starts one top-frame script and zero subframe scripts.
- [x] Cap physical script starts before browser injection without adding a required warned permission or degrading every framed page to fail-closed.

The production worker contains no `allFrames` scripting target. Full cross-origin coverage uses `webNavigation.getAllFrames` only after the user enables the declared optional `webNavigation` permission from the localized Options disclosure; it is not a required install/update permission. Enumeration records are immediately reduced to sorted ephemeral frame/document identities, with URLs discarded. An identity-capable first snapshot must exactly bind the top metadata result and every probe result, and a second snapshot must reproduce every identity before watcher work. Duplicate, malformed, mixed, missing, or changed identities fail closed; a granted Chrome 102-style snapshot with no document identities stays protected without starting a subframe script. At most 64 subframes are probed in batches of eight and at most 32 first-time form watchers are injected per scan in batches of eight. Every first watcher pass remains protected until a later probe observes the installed sentinel. The end-to-end physical ceiling therefore remains 97 script starts per collection: one top metadata script, 64 subframe probes, and 32 watcher starts. Missing/inexact results, document replacement, permission churn, frame-set churn, and watcher overflow/failure all remain protected.

Without the optional grant, frameless pages still use one top script. Framed pages use one additional top-targeted script that walks at most 64 same-origin child frames and bounded controls/media per frame. Accessible small trees retain real form/media/Picture-in-Picture protection instead of becoming blanket failures; inaccessible cross-origin branches, churn, and oversized trees fail closed. Its same-origin fallback retains at most 64 standard-control baselines per frame, caps each retained value at 2,048 characters and their per-frame total at 16,384 characters, prunes detached controls, recognizes edit reversals, and preserves value-free uncertainty records for late rich/PDF editors. The warm-up scan remains protected. No URLs or frame/document identities are persisted, logged, or exported; granted-mode identities exist only for the duration of one collection. The 1,000-frame regression proves one physical top start and zero subframe starts, while the 64-frame boundary regression accounts for the exact 97-start maximum. Primary references: [Chrome scripting targets](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-InjectionTarget), [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#method-getAllFrames), and [Chrome permission warnings](https://developer.chrome.com/docs/extensions/reference/permissions-list#webNavigation).

### P19 — Coalesce alarm catch-up after sleep and throttling

GitHub: [#45](https://github.com/ErDreiwen/auto-tab-discard/issues/45) · Checklist: 4/4

- [x] Persist last-started and last-completed timestamps.
- [x] Coalesce missed periods into one catch-up.
- [x] Share a single-flight guard across all triggers.
- [x] Back off after repeated API/browser failures.

### P20 — Authenticate and constrain external discard integrations

GitHub: [#44](https://github.com/ErDreiwen/auto-tab-discard/issues/44) · Checklist: 4/4

- [x] Require explicit trusted-sender pairing or allowlisting.
- [x] Validate only documented query fields.
- [x] Deny forced bypass to untrusted/legacy callers.
- [x] Rate-limit batches and return bounded nonsensitive results.

### P21 — Enforce an all-sites permission budget

GitHub: [#46](https://github.com/ErDreiwen/auto-tab-discard/issues/46) · Checklist: 4/4

- [x] Document why every host/API permission is required.
- [x] Explicitly exclude unsupported schemes/contexts.
- [x] Evaluate optional permissions or narrower registration.
- [x] Gate manifest privilege growth in review/CI.

### P22 — Redact sensitive data from diagnostics and backups

GitHub: [#50](https://github.com/ErDreiwen/auto-tab-discard/issues/50) · Checklist: 7/7

- [x] Redact URLs, titles, queries, and identity-bearing paths.
- [x] Exclude transient/internal keys from exports.
- [x] Provide a sanitized support bundle separate from raw reports.
- [x] Add secret-canary tests for every shareable artifact.
- [x] Persist only fixed command, stage, reason, count, duration, and browser-family fields in a bounded journal.
- [x] Offer the same sanitized Minecraft-style `latest.log` from popup and Options without automatic upload.
- [x] Keep private incidents memory-only and bound storage failures so diagnostics can never block commands.

### P23 — Validate and atomically import settings

GitHub: [#47](https://github.com/ErDreiwen/auto-tab-discard/issues/47) · Checklist: 4/4

- [x] Use a settings-appropriate file-size limit.
- [x] Validate keys/types/ranges/regex/plugins against a versioned schema.
- [x] Stage imports with an automatic rollback snapshot.
- [x] Strip internal keys and report errors without reload.

### P24 — Bound user-supplied regular expression complexity

GitHub: [#48](https://github.com/ErDreiwen/auto-tab-discard/issues/48) · Checklist: 4/4

- [x] Limit expression and tested-input length.
- [x] Reject dangerous constructs conservatively.
- [x] Compile validated rules once per preference revision.
- [x] Surface rejected rules without evaluating them.

### P25 — Remove private tab metadata from blank-helper URLs

GitHub: [#49](https://github.com/ErDreiwen/auto-tab-discard/issues/49) · Checklist: 4/4

- [x] Transfer metadata through nonce-keyed session storage.
- [x] Expire/delete it immediately after read.
- [x] Remove opener linkage unless required.
- [x] Replace history with a query-free extension URL.

### P26 — Minimize install, update, and uninstall navigation metadata

GitHub: [#51](https://github.com/ErDreiwen/auto-tab-discard/issues/51) · Checklist: 4/4

- [x] Minimize parameters to nonunique necessities.
- [x] Add a control disabling feedback navigation.
- [x] Pin allowed HTTPS origins.
- [x] Document every outbound lifecycle navigation.

### P27 — Make the popup fully keyboard and screen-reader operable

GitHub: [#53](https://github.com/ErDreiwen/auto-tab-discard/issues/53) · Checklist: 4/4

- [x] Use native buttons/menuitems with accessible names.
- [x] Implement Enter/Space and predictable navigation.
- [x] Express release disabled state semantically and visually.
- [x] Add WCAG-compliant focus styling.

### P28 — Show progress, partial failure, and cancellation for long commands

GitHub: [#52](https://github.com/ErDreiwen/auto-tab-discard/issues/52) · Checklist: 4/4

- [x] Disable conflicting controls and show completed/total progress.
- [x] Wire cancellation to queued/running tokens.
- [x] Return per-tab success/skipped/failed summaries.
- [x] Preserve a short result when popup closes mid-command.

### P29 — Make title markers reversible and content-safe

GitHub: [#54](https://github.com/ErDreiwen/auto-tab-discard/issues/54) · Checklist: 4/4

- [x] Normalize length, whitespace, Unicode, and duplicates.
- [x] Preserve original title for rollback/diagnostics.
- [x] Define behavior for concurrent page title updates.
- [x] Verify unmarked restoration after release.

### P30 — Guarantee zero activation and renderer side effects for Edge-frozen takeover

GitHub: [#55](https://github.com/ErDreiwen/auto-tab-discard/issues/55) · Checklist: 6/6

- [x] Remove target activation and keeper restoration from frozen takeover.
- [x] Prohibit scripting, messaging, reload, and stop-loading operations on the frozen target.
- [x] Monitor target activation, browser focus, loading, visibility, media, and fixture requests.
- [x] Persist physical-only self ownership and expose localized visual-unavailable outcomes.
- [x] Make repeat discard a zero-event strict no-op.
- [x] Exercise combined and favicon-only automatic alarms followed by a stable dwell.

### P31 — Localize command progress and failure feedback

GitHub: [#56](https://github.com/ErDreiwen/auto-tab-discard/issues/56) · Checklist: 4/4

- [x] Map internal error codes to localized messages.
- [x] Validate locale key/placeholder parity.
- [x] Add appropriate `aria-live` status regions.
- [x] Run pseudo-localized long/RTL layout tests.

### P32 — Add Chrome and Edge browser-channel canaries

GitHub: [#57](https://github.com/ErDreiwen/auto-tab-discard/issues/57) · Checklist: 5/5

- [x] Schedule isolated Chrome Stable/Beta and Edge Stable/Beta matrices.
- [x] Test the declared minimum Chrome version and fail on a mismatched observed major.
- [x] Record browser version, artifact/tree hashes, runner identity, and required capabilities.
- [x] Require an owner, future expiry, reason, and narrow failure kinds for every quarantine.
- [x] Complete the hosted five-target matrix against one canonical release artifact with no unowned quarantine.

### P33 — Fuzz the tab lifecycle state machine

GitHub: [#59](https://github.com/ErDreiwen/auto-tab-discard/issues/59) · Checklist: 4/4

- [x] Define active safety, unique ownership, bounded operation, and cleanup invariants for both the reference model and production conformance gate.
- [x] Build a seeded mocked Chrome event scheduler for broad exploration plus a bounded adapter that executes the real command-scope, discard, and ownership public paths.
- [x] Generate storage failure, replacement, user activation, close, and restart points; run all five against production APIs in a deterministic 24-schedule gate.
- [x] Minimize and persist failing reference-model seeds; report exact seed/scenario/action coordinates and verify isolated-process replay for production failures.

### P34 — Build deterministic extension artifacts with provenance

GitHub: [#58](https://github.com/ErDreiwen/auto-tab-discard/issues/58) · Checklist: 5/6

- [x] Add one deterministic packaging command and inclusion manifest.
- [x] Emit inventory, tree hash, ZIP/XPI hashes, version, commit, release-note and policy digests, and hashed test references.
- [x] Reject dirty trees, forbidden files, nested roots, missing resources, and identity/version/archive-name mismatch.
- [x] Make the strict gate extract the ZIP and run browser smokes only against that extracted artifact with exact tree-digest checks.
- [x] Obtain byte-identical release outputs from clean hosted Linux and Windows builders for the release commit.
- [ ] Run every required browser gate against that exact canonical artifact and bind the retained reports into the final attestation.

### P35 — Gate real upgrades and store-policy compatibility

GitHub: [#60](https://github.com/ErDreiwen/auto-tab-discard/issues/60) · Checklist: 5/6

- [x] Maintain every supported prior settings and ownership format as executable fixtures.
- [x] Implement and require extracted-artifact update, worker restart, browser restart, rollback, and reload-storm checks.
- [x] Run the upgrade/rollback harness against the final candidate artifact on Chrome and Edge and retain both reports.
- [x] Run Chrome/Edge manifest, identity, permission, and package-policy lint.
- [x] Bind normalized migration and permission-change notes into protected-tag provenance and reject missing or invalid trust evidence.
- [ ] Produce the hosted protected-tag attestation for the final ZIP/XPI and independently verify the retained bundle with the reviewed policy-pinned trusted root.


## Mechanical contract

- Current identifiers are exactly `C01`–`C25`.
- Potential identifiers are exactly `P01`–`P35`.
- Every issue contains 4–7 checklist items.
- No issue is silently removed when superseded; its GitHub record explains the reconciliation.
- A checked box records implemented evidence, but closure still requires the issue's verification gate and applicable release evidence.
