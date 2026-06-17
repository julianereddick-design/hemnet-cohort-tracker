---
phase: 16-sold-match-db-schema-persistence
reviewed: 2026-06-17T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - migrate-sold-phase16.js
  - lib/sold-store.js
  - scripts/persist-sold.js
  - lib/sold-spend.js
  - lib/sold-transport.js
  - scripts/verf-sold-transport-load.js
findings:
  critical: 0
  warning: 5
  info: 5
  total: 10
status: issues_found
---

# Phase 16: Code Review Report

**Reviewed:** 2026-06-17
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed the Phase 16 sold-match schema + persistence layer: a re-runnable schema
migration (`migrate-sold-phase16.js`), client-first parameterized upserts
(`lib/sold-store.js`), a JSONL→DB persist driver (`scripts/persist-sold.js`), a
pluggable atomic spend counter (`lib/sold-spend.js`), its wiring into the transport
module (`lib/sold-transport.js`), and a load probe (`scripts/verf-sold-transport-load.js`).

**SQL injection:** Clean. Every query in scope uses `$1,$2,...` placeholders, including
the `ANY($1::text[])` read-back. No string interpolation reaches any SQL statement. The
project's ban on SQL string-interpolation is respected throughout.

**Spend-counter atomicity:** The DB backend's core invariant — `UPDATE ... WHERE calls < $2
RETURNING calls` as a single statement — is correct and genuinely closes the read-modify-write
race (CR-01). However there are two correctness gaps around it: a per-call seed flag that
silently desyncs from the DB, and an unguarded `max=0` / negative-ceiling case.

**Key concerns** are connection-leak and atomicity edge cases rather than injection: the
migration and persist driver both leak their DB client on any thrown error before
`client.end()`, and the `max=0` ceiling case lets the DB backend permanently throw while
silently incrementing past the cap is prevented but `remaining()` math can go odd. None are
blockers, but several should be fixed before Phase 17 builds drivers on top of this plumbing.

## Warnings

### WR-01: Migration leaks the DB client on any query error (no try/finally)

**File:** `migrate-sold-phase16.js:15-145`
**Issue:** `run()` calls `client.connect()` and only reaches `await client.end()` (line 144)
if every `CREATE TABLE` and the read-back succeed. If any `client.query(...)` throws (DDL
permission error, transient network drop, lock timeout), the function rejects, the top-level
`.catch` logs and `process.exit(1)` — but `client.end()` is never called. On a short-lived
migration the process exits anyway so the socket dies with it, so the practical impact is
low; the defect is the pattern: it diverges from the connect→try→finally(end) discipline that
`scripts/persist-sold.js` itself uses, and if this `run()` is ever imported and called
in-process (as persist-sold's `run` is exported and reused), the leak becomes real.
**Fix:** Wrap the body in try/finally so the client is always released:
```js
async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS booli_sold ( ... )`);
    // ... remaining queries + read-back ...
  } finally {
    await client.end();
  }
}
```

### WR-02: DB spend backend desyncs `seeded` flag across instances — a fresh tally never re-seeds an already-seeded key, but a never-seeded key with a pre-existing row is fine; the real bug is `seeded` is per-instance, so a process that seeds via one tally and creates a second tally re-issues the seed needlessly, and more importantly `ensureSeed` swallows nothing but is gated only by an in-memory boolean

**File:** `lib/sold-spend.js:36-49`
**Issue:** `seeded` is a closure-local boolean set to `true` after the first `reserveCall()`.
It is never reset and never reflects actual DB state. Two concrete problems: (1) The seed
`INSERT ... ON CONFLICT DO NOTHING` is harmless to repeat, but the flag means the very first
`reserveCall()` on a tally always pays a round-trip even when the row already exists — minor.
(2) More importantly, if `reserveCall()`'s seed INSERT succeeds but the subsequent UPDATE
throws (connection drop), `seeded` is already `true`; a retry on the *same* tally instance
skips re-seeding — which is correct since the row exists — but if the seed INSERT itself
throws, `seeded` stays `false` and the next call retries it, which is also correct. The flag
is therefore not a data-loss bug, but it couples correctness to a fragile in-memory flag that
will silently break the moment seeding logic grows (e.g. per-window keys). Document or remove.
**Fix:** Prefer making seed idempotent without the flag — fold it into a single CTE, or seed
once at driver startup rather than lazily per first call:
```js
// Option A: seed eagerly once at construction (driver guarantees a connected client):
//   await client.query(`INSERT INTO sold_spend (spend_key, calls) VALUES ($1,0)
//                        ON CONFLICT (spend_key) DO NOTHING`, [spendKey]);
// then reserveCall() is a single UPDATE with no per-call branch.
```

### WR-03: DB ceiling backend cannot distinguish "ceiling hit" from "key not seeded yet" — and `max <= 0` makes the UPDATE match zero rows forever, throwing CeilingError on the very first call

**File:** `lib/sold-spend.js:48-60`
**Issue:** `reserveCall()` throws `CeilingError` whenever the `UPDATE ... WHERE spend_key=$1
AND calls < $2` returns zero rows. Zero rows occurs in TWO distinct situations: (a) the row
exists and `calls >= max` (the intended ceiling), OR (b) `max <= 0`, in which case `calls < $2`
is false even at `calls = 0`, so the first call throws "ceiling reached: 0/0" despite no
calls having been made. `max` comes from `parseInt(process.env.MAX_OXY_CALLS || '4000', 10)`
(line 98) — if `MAX_OXY_CALLS` is set to `0`, an empty string, or a non-numeric value,
`parseInt` yields `0` or `NaN`. With `NaN`, `calls < NaN` is always false → every fetch throws
CeilingError and the pipeline silently stalls with a misleading "ceiling reached: NaN/NaN"
message. The file backend has the analogous `s.liveCalls >= max` issue (line 82), but at least
`NaN` there also blocks all fetches identically.
**Fix:** Validate `max` is a positive integer at factory time and fail loud on bad config,
mirroring the Phase-15 WR-05 fix (commit a5a25b2 rejected NaN/non-positive numeric flags):
```js
const max = opts.max != null ? opts.max : parseInt(process.env.MAX_OXY_CALLS || '4000', 10);
if (!Number.isInteger(max) || max <= 0) {
  throw new Error(`sold-spend: max must be a positive integer, got ${max}`);
}
```

### WR-04: `persist-sold.js` reads entire JSONL into memory and parses every line eagerly — one malformed line aborts the whole pass with a bare `JSON.parse` SyntaxError and no line context

**File:** `scripts/persist-sold.js:23-25, 43-46`
**Issue:** `readJsonl` does `split('\n').filter(Boolean).map(l => JSON.parse(l))`. A single
corrupt line (a partial append from an interrupted fetcher write — a documented resume cache,
per the header) throws `SyntaxError: Unexpected token ...` with no indication of which line or
file failed, and aborts persistence of every preceding *and* following valid record (the map
runs before any upsert). Because the upsert loop only starts after the full array is built,
the partial-progress count printed at the end (`persisted: booli=N`) is never reached on a bad
file — the operator sees only a raw stack trace. The fetcher's own `readJsonl`
(`lib/sold-transport.js:172-177`) wraps parsing in try/catch and returns `[]` on failure; this
driver does not share that resilience.
**Fix:** Parse per-line with a guarded loop that reports the offending line and either skips or
fails loudly with context:
```js
function readJsonl(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    try { out.push(JSON.parse(l)); }
    catch (e) { throw new Error(`${file}:${i + 1} malformed JSONL: ${e.message}`); }
  }
  return out;
}
```

### WR-05: `persist-sold.js` upserts every record in a single implicit transaction-less loop with no per-record error isolation — one bad row aborts the run mid-stream after partial writes

**File:** `scripts/persist-sold.js:42-47`
**Issue:** The booli/hemnet loops `await upsertBooliSold(client, rec)` with no per-record
try/catch. If any single record violates a constraint or hits a type-coercion error at the DB
(e.g. a `sold_date` string Postgres cannot cast to DATE, or a `booli_id` that is `undefined`
because a hand-edited JSONL line lacks it — `upsertBooliSold` binds `row.booli_id` raw at
`lib/sold-store.js:56` with no `?? null`, so an absent id sends `undefined` → pg error), the
whole `run()` rejects in the middle of the file. The `finally` closes the client cleanly, but
the operator gets `booli=<partial>` worth of committed rows and no record of which line failed
or where to resume. Upserts are idempotent (DB-03) so a re-run is safe, but the failure is
opaque.
**Fix:** Wrap each record so a single bad row is logged with its index and skipped (or
counted), letting the rest of the file persist:
```js
for (const [i, rec] of readJsonl(args.booli).entries()) {
  try { await upsertBooliSold(client, rec); booli++; }
  catch (e) { console.error(`booli line ${i + 1} skipped: ${e.message}`); }
}
```
Also consider asserting `rec.booli_id != null` before the upsert so the error message names
the cause rather than surfacing a generic pg bind error.

## Info

### IN-01: `created_at`/`updated_at` are never refreshed on the migration re-run path, but `ON CONFLICT DO UPDATE` bumps `updated_at=NOW()` while leaving `created_at` — confirm intent on rows that pre-date a column add

**File:** `lib/sold-store.js:54, 87`
**Issue:** Both upserts set `updated_at=NOW()` on conflict and never touch `created_at` — correct
and intentional. Noting only that there is no migration path here for *adding* columns to an
existing `booli_sold`/`hemnet_sold` (the DDL is `CREATE TABLE IF NOT EXISTS` only). If a future
phase adds a column, this migration will silently no-op on an existing table and the new column
will be absent, with no error. That is a known limitation of the `IF NOT EXISTS`-only idiom, not
a Phase 16 defect.
**Fix:** None required this phase; flag for Phase 17 if the schema evolves — add explicit
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` blocks rather than relying on table creation.

### IN-02: Migration read-back verifies table *names* exist but not their *columns* — a stale table from an earlier divergent schema passes the check

**File:** `migrate-sold-phase16.js:136-142`
**Issue:** The read-back asserts the four table names are present in `information_schema.tables`.
If a table already existed with a different (older) column set, `CREATE TABLE IF NOT EXISTS`
no-ops and the read-back still reports "Tables present: booli_sold, ..." giving false confidence
that the *current* contract is applied. Low risk on a greenfield sold schema (this is the first
migration creating them), but the read-back's reassurance is weaker than it reads.
**Fix:** Optional — query `information_schema.columns` for a representative new column
(e.g. `sold_spend.spend_key`) to confirm the live shape, not just table existence.

### IN-03: `WR-02`'s `seeded` flag and the sync/async spent-count duality leave two sources of truth for the live-call count

**File:** `lib/sold-transport.js:73-80`
**Issue:** `spentCalls()`/`remainingCalls()` (sync) read `_spend.json` directly, while
`spentCallsAsync()`/`remainingCallsAsync()` delegate to `_tally`. After `setSpendClient(client)`
switches `_tally` to the DB backend, the sync readers still report the *file* counter, which is
now stale/unused on the DB path. The header comment (lines 67-72) acknowledges this and states
the sync drain guard "stays correct on the file path (current behavior)" — but a Phase 17 caller
that wires the DB client and then calls the sync `remainingCalls()` (e.g. the documented
`sold-fetch-hemnet.js:151 remainingCalls() <= 40` guard) will read the wrong counter. This is a
latent foot-gun handed to Phase 17, deliberately deferred but worth flagging prominently.
**Fix:** None this phase (the contract is explicitly Phase-17 work); ensure Phase 17 migrates the
sync drain guards to the async variants when the DB backend is active, or the file counter is
kept in sync.

### IN-04: `procStats()` reports `spent`/`remaining` from the file counter even on the DB backend

**File:** `lib/sold-transport.js:156`
**Issue:** `procStats()` calls the sync `spentCalls()`/`remainingCalls()`, so any logging or
summary built on `procStats()` will under-report spend once the DB tally is active (the file
counter stops advancing). Same root cause as IN-03; flagged separately because reporting/metrics
consumers are an easy place for the discrepancy to mislead an operator reading run output.
**Fix:** Make `procStats()` async and source from `_tally`, or annotate the returned object so
consumers know which backend produced the numbers.

### IN-05: `persist-sold.js --smoke` asserts arg parsing but never exercises `readJsonl` or the upsert binding — the highest-risk code paths (malformed JSONL, missing booli_id) are untested

**File:** `scripts/persist-sold.js:57-66`
**Issue:** The smoke test confirms `upsertBooliSold`/`upsertHemnetSold` are functions and that
`parseArgs` maps flags — useful but shallow. It does not cover `readJsonl` (the WR-04 failure
mode) or a record missing `booli_id` (the WR-05 bind error). The `lib/sold-store.js` smoke suite
is thorough with a mock client; this driver's is not.
**Fix:** Add a smoke case that feeds `readJsonl` a temp file with one valid and one malformed
line and asserts the chosen behavior (skip-with-log or fail-with-line-context per WR-04).

---

_Reviewed: 2026-06-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
