# Seeded lifecycle fuzzing

`node scripts/run-lifecycle-fuzz.mjs` executes 10,000 deterministic scenarios by default. Each scenario uses a seeded
mock Chrome event scheduler and interleaves external and extension discards with tab-ID replacement, user activation,
tab close, service-worker restart, storage write/read outages, claim release, and delayed operation callbacks.

The model checks four invariants after every generated or scheduled event:

1. **Active safety:** an active tab is never discarded, and a user activation cancels takeover work.
2. **Unique ownership:** a live sleeping tab has at most one matching lineage/generation claim; memory and durable claims
   cannot diverge when storage is available.
3. **Bounded operation:** takeover/recovery attempts, deadlines, and the pending event queue have hard limits.
4. **Cleanup:** closed/replaced lineages cannot leave owner records, operations, or expired aliases behind.

The Node test suite runs the full 10,000-scenario campaign on every change. To replay one numeric seed exactly:

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
campaign's seed-generation order later changes.
