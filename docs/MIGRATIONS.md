# Upgrade and migration contract

Release 0.6.9.2 treats the existing local preference object as an in-place contract. The executable fixtures under `tests/fixtures/migrations/` cover supported 0.5.0 preference values, 0.6.9.1 preference values, and ownership records written by earlier reliability-fork workers. The tests read those preferences through the current storage adapter and reconcile the ownership records through the current ownership module.

The ownership contract intentionally accepts old `owned` records without a `visual` field, preserves self/claimed ownership for still-discarded tabs, converts an orphaned `pending` record to a safe claimed record, resumes an orphaned explicit `takeover-waking` request as queued work, and removes ownership from a loaded tab.

These fixtures remain unit-level compatibility evidence. The strict release
gate additionally runs `e2e/upgrade-rollback-smoke.cjs` against the extracted
release tree in both Chrome and Edge. It installs an isolated 0.6.9.1 baseline,
seeds legacy settings plus self/claimed/pending ownership, replaces the same
unpacked installation with the candidate tree, restarts the service worker and
browser, then rolls the installation back. Every phase requires the three
physical sleepers to issue no request during the extension update or worker
restart and requires settings to survive. Chrome and Edge clear `storage.session` during
an unpacked developer-mode reload, so the real update gate requires all three
sleepers to be reconstructed conservatively as `claimed` and never guesses
`self`; the executable unit fixtures separately prove in-memory legacy-schema
migration when the old session record is available. A full browser session
restore is allowed at most one browser-originated document load per tab; the
gate then holds a three-second dwell, requires the count to remain stable, and
requires rollback to preserve both those states and counts. This distinguishes
normal browser restoration from an extension wake/re-discard storm. A release
may cite upgrade proof only when those artifact-bound browser reports pass.
