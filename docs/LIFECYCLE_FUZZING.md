# Seeded lifecycle fuzzing

This gate has two deliberately different layers. `node scripts/run-lifecycle-fuzz.mjs` executes 10,000 deterministic
scenarios in a compact reference model. Each scenario uses a seeded mock Chrome event scheduler and interleaves
external and extension discards with tab-ID replacement, user activation, tab close, service-worker restart, storage
write/read outages, claim release, and delayed operation callbacks. The reference model explores many schedules
quickly; it is not presented as execution of the extension's production ownership or discard implementation.

The model checks four invariants after every generated or scheduled event:

1. **Active safety:** an active tab is never discarded, and a user activation cancels takeover work.
2. **Unique ownership:** a live sleeping tab has at most one matching lineage/generation claim; memory and durable claims
   cannot diverge when storage is available.
3. **Bounded operation:** takeover/recovery attempts, deadlines, and the pending event queue have hard limits.
4. **Cleanup:** closed/replaced lineages cannot leave owner records, operations, or expired aliases behind.

The Node test suite runs the full 10,000-scenario reference campaign on every change. To replay one numeric seed
exactly:

```powershell
node scripts/run-lifecycle-fuzz.mjs --seed 123456789 --steps 32
```

On failure the runner delta-minimizes the action list and writes both JSON and a ready-to-run command under
`build/fuzz-failures/`. Replay a persisted failure with:

```powershell
node scripts/run-lifecycle-fuzz.mjs --reproduce build/fuzz-failures/seed-123456789.json
```

The persisted file includes the initial tab count, scheduler seed, exact ordered actions, invariant name, failure
snapshot, original action count, and minimized action count. This makes a CI seed independently reproducible even if the
campaign's seed-generation order later changes. Delta minimization applies to this reference-model layer only.

## Production conformance campaign

`node scripts/production-lifecycle-conformance.mjs` is the smaller production-backed gate. Its Chrome adapter exposes
only browser APIs and events; the campaign imports and executes the real `command-scope.mjs`, `discard.mjs`, and
`ownership.mjs` public paths. It does not copy their state transitions into another model or enable a test-only
production bypass.

The default seed runs 24 deterministic schedules. Each schedule shuffles five production operations: a six-target
scoped ordinary discard through the configured four-job queue, replacement while native discard is pending, activation
while native discard is pending, close while native discard is pending, and a before- or after-apply session-storage
failure. A durable legacy ownership record is present before the modules load, so the same run also exercises real
worker-start migration and reconciliation. After every operation the gate checks active safety, unique live ownership
nonces and lineage, bounded production queues/maps/native calls, and cleanup against the authoritative live-tab set.

```powershell
node scripts/production-lifecycle-conformance.mjs
node scripts/production-lifecycle-conformance.mjs --seed 305441741 --scenarios 6
```

The JSON report names the production modules, exact seed and scenario count, event coverage, native-call count, and
maximum overlap. A failure reports its seed, scenario number, per-scenario seed, and action. Re-running those two CLI
arguments in a fresh Node process reproduces the same ordered production campaign; unlike the reference model, this
bounded gate does not claim automatic schedule minimization.
