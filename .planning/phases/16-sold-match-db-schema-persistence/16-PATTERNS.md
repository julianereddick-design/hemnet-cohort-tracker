# Phase 16: Sold-match DB schema + persistence - Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 4 new/modified (1 migration, 1 persist store, 1 spend-tally module, fetcher wiring touchpoints)
**Analogs found:** 4 / 4 (all exact or strong role+data-flow matches; every analog verified present and excerpted from real source)

## File Classification

| New/Modified File (planner finalizes names) | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `migrate-sold-*.js` (sold tables DDL) | migration | batch / DDL | `migrate-spotcheck-phase13.js` | exact (multi-table CREATE IF NOT EXISTS + UNIQUE) |
| `lib/sold-store.js` (persist booli_sold / hemnet_sold / verdict upserts) | store / service | CRUD (upsert) | `lib/spotcheck-review-store.js` | exact (client-first exports, parameterized SQL, ON CONFLICT) |
| `lib/sold-spend.js` (DB-backed spend tally, file fallback) | utility / service | event-driven (atomic counter) | `lib/sold-transport.js` spend ceiling + `cron-wrapper.js` atomic UPDATE | role-match (file→DB swap behind interface) |
| `lib/sold-fetch-booli.js` / `lib/sold-fetch-hemnet.js` (wire persist step) | service (modified) | streaming (JSONL→DB persist) | existing JSONL append in same files | self (additive integration point) |

**Column source of truth (not an analog — the contract the schema must match):** `lib/sold-parse.js` — `parseBooliSoldCards` / `parseBooliSoldDetail` / `parseHemnetSaleCards`. Every snake_case key these emit maps 1:1 to a column. See "Column Contract" section below.

## Pattern Assignments

### `migrate-sold-*.js` (migration, batch/DDL)

**Analog:** `migrate-spotcheck-phase13.js` (exact: multiple `CREATE TABLE IF NOT EXISTS` in one script, `SERIAL` PK, `BIGINT` ids, `TIMESTAMPTZ`, `UNIQUE(...)` for idempotency). Secondary: `migrate-booli-listing-add-fields.js` and `migrate-cohort-pairs-soft-delete.js` for the read-back verify and `ADD COLUMN IF NOT EXISTS` idioms if any ALTER is needed.

**Boilerplate + connect pattern** (`migrate-spotcheck-phase13.js:1-6, 41-47`):
```javascript
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  // ... client.query(`CREATE TABLE IF NOT EXISTS ...`) ...
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

**Table DDL house style** (`migrate-spotcheck-phase13.js:7-22`) — copy exactly: `SERIAL PRIMARY KEY`, `BIGINT` for portal ids, `TEXT` for strings, `TIMESTAMPTZ ... DEFAULT NOW()` for audit stamps, trailing `UNIQUE(...)` for the dedup/upsert key:
```javascript
await client.query(`
  CREATE TABLE IF NOT EXISTS spotcheck_review (
    id             SERIAL PRIMARY KEY,
    pair_id        INTEGER NOT NULL,
    cohort_id      TEXT NOT NULL,
    channel        TEXT NOT NULL,
    ts             TEXT NOT NULL,
    vision_verdict TEXT,
    human_verdict  TEXT,
    reactor        TEXT,
    reason         TEXT,
    adjudicated_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pair_id, cohort_id)
  )
`);
console.log('Created table: spotcheck_review');
```

**Apply to the three sold tables** (per D-01 / D-05):
- `booli_sold` — `UNIQUE(booli_id)`, `booli_id BIGINT`. Stores deed transfers too (D-02) plus `is_title_transfer BOOLEAN` and `sold_in_advance BOOLEAN`.
- `hemnet_sold` — `UNIQUE(hemnet_slug)`, `hemnet_slug TEXT`.
- sold verdict table — `UNIQUE(booli_id)`, `matched_hemnet_slug TEXT NULL`, `verdict TEXT`, `match_method TEXT`, `evidence JSONB`, `segment TEXT`, `window_start DATE`, `window_end DATE`, `adjudicated_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT NOW()` (full shape in D-05).

**Optional read-back verify** (`migrate-booli-listing-add-fields.js:41-51`) — Phase-13 migrations omit it but the booli-listing migration queries `information_schema.columns` and prints each column; reasonable for a multi-table sold migration to confirm DDL applied.

**`'use strict'` header + run comment:** the two additive migrations open with a `// migrate-... // Run manually: node migrate-...js` block and `'use strict'`; `migrate-spotcheck-phase13.js` does not. Either is house style; prefer the documented-header form for a new substantive migration.

---

### `lib/sold-store.js` (store, CRUD upsert)

**Analog:** `lib/spotcheck-review-store.js` (exact). Every export takes a connected pg `Client` as the first arg, no module-level DB connection, parameterized `$1,$2,…` only, `ON CONFLICT ... DO UPDATE` upserts, and a `--smoke` self-test using a mock client.

**Module contract / header** (`lib/spotcheck-review-store.js:7-18`):
```javascript
// Every exported function takes a connected pg Client as its first argument.
// ... No top-level DB connection is opened here.
// All queries use parameterised $1,$2,... placeholders — no string interpolation.
'use strict';
```

**Upsert pattern — adapt DO NOTHING → DO UPDATE** (`lib/spotcheck-review-store.js:21-28` shows the client-first + ON CONFLICT shape; D-01 requires `DO UPDATE` so re-fetch refreshes enriched fields):
```javascript
async function upsertReviewMessage(client, { pairId, cohortId, channel, ts, visionVerdict }) {
  await client.query(
    `INSERT INTO spotcheck_review (pair_id, cohort_id, channel, ts, vision_verdict)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (pair_id, cohort_id) DO NOTHING`,
    [pairId, cohortId, channel, ts, visionVerdict ?? null]
  );
}
```
For sold, the planner writes e.g. `upsertBooliSold(client, row)` → `INSERT INTO booli_sold (...) VALUES ($1..$N) ON CONFLICT (booli_id) DO UPDATE SET col = EXCLUDED.col, ...`; `upsertHemnetSold(client, row)` ON CONFLICT (hemnet_slug); `upsertSoldVerdict(client, row)` ON CONFLICT (booli_id). Use `EXCLUDED.<col>` in the DO UPDATE SET to pull the new values. Null-coalesce every optional field with `?? null` exactly as the analog does (parsers can emit `null` for any field).

**Transactional multi-statement pattern** (`lib/spotcheck-review-store.js:55-75`) — if a persist needs >1 statement (e.g. batch insert + verdict in one unit, or D-02 "insert booli_sold but skip verdict for title transfers" as one txn), copy the BEGIN/try/COMMIT/catch-ROLLBACK-rethrow frame:
```javascript
await client.query('BEGIN');
try {
  await client.query(`INSERT INTO ... VALUES ($1,...)`, [...]);
  await client.query(`UPDATE ... SET ... WHERE ...`, [...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

**`--smoke` self-test with mock client** (`lib/spotcheck-review-store.js:91-196`) — every lib module in this repo ships an inline `node lib/<mod>.js --smoke` test. Mock the client to capture SQL strings and assert the ON CONFLICT clause / call ordering without a DB or network. `lib/sold-parse.js:173-415` is the other reference for the smoke harness shape (`check(name, fn)` counter, `process.exit(fail === 0 ? 0 : 1)`).

**D-02 gate (title transfers excluded from verdict table):** the persist layer must mirror the Phase-15 detail-scope gate — write `booli_sold` rows for `is_title_transfer = true` but never call `upsertSoldVerdict` for them. The `isTitleTransfer` predicate already exists at `lib/sold-config.js:33-36`; reuse it, do not re-implement.

---

### `lib/sold-spend.js` (utility, atomic counter — DB with file fallback)

**Analog (current behavior being replaced):** `lib/sold-transport.js:54-102` — the file-based ceiling.

**File-based tally as-is (the fallback to retain)** (`lib/sold-transport.js:50-62, 90-102`):
```javascript
class CeilingError extends Error {
  constructor(msg) { super(msg); this.code = 'OXY_CEILING'; }
}
function loadSpend() {
  try { return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8')); }
  catch (_) { return { liveCalls: 0 }; }
}
function saveSpend(s) { fs.writeFileSync(SPEND_FILE, JSON.stringify(s)); }
// inside cachedFetch:
const spend = loadSpend();
if (spend.liveCalls >= MAX_OXY_CALLS) {
  throw new CeilingError(`Oxylabs ceiling reached: ${spend.liveCalls}/${MAX_OXY_CALLS} live calls — refusing new fetch`);
}
spend.liveCalls += 1;   // <-- CR-01: non-atomic read-modify-write; races under concurrency
saveSpend(spend);
```
This `load → check → ++ → save` is exactly the CR-01 race the harden-spend-ceiling todo flags (`.planning/todos/pending/harden-spend-ceiling-concurrency.md:21-25`). D-03 closes it by moving the increment to the DB.

**Analog for the DB atomic-increment path:** `cron-wrapper.js` — the repo's existing pattern for atomic single-statement counter/state mutation with `INSERT ... RETURNING` and `UPDATE ... SET`:
```javascript
// cron-wrapper.js:119-121 — INSERT ... RETURNING id
const logRes = await client.query(
  `INSERT INTO cron_job_log (script_name, started_at, status) VALUES ($1, NOW(), 'running') RETURNING id`,
  [scriptName]
);
// cron-wrapper.js:147-148 — UPDATE ... SET ... RETURNING-style mutation
await client.query(
  `UPDATE cron_job_log SET finished_at = NOW(), duration_ms = $1, status = $2, ... WHERE id = $5`,
  [...]
);
```
For the DB-backed ceiling, the single atomic statement (per D-03) is:
```sql
UPDATE sold_spend SET calls = calls + 1 WHERE id = $1 AND calls < $2 RETURNING calls
```
A zero-row result means the ceiling was hit (the `calls < $2` guard makes the check-and-increment atomic in one statement — no read-then-write window). Seed the row with `INSERT ... ON CONFLICT DO NOTHING` on first use.

**Pluggable-interface requirement (D-03):** expose one interface (e.g. `{ reserveCall(), spent(), remaining() }`) with two implementations — DB-backed (takes a client) and file-backed (the retained `loadSpend/saveSpend`). `lib/sold-transport.js` must still load and run with **no DB** (offline recon / smoke / verf-soldspike dumps), so the selection is: client present → DB tally, else → file tally. Keep `CeilingError` (`code: 'OXY_CEILING'`) as the thrown type either way so existing catch sites are unchanged. Ship a `--smoke` test (mock client returning `{rows:[]}` to simulate ceiling-hit; in-memory file path for the fallback).

---

### `lib/sold-fetch-booli.js` / `lib/sold-fetch-hemnet.js` (modified — wire persist)

**Integration point, not a new pattern.** The fetchers already append JSONL (`lib/sold-fetch-booli.js:32-34, 281, 312` — `appendJsonl(seedFile, record)`). Per D-04, JSONL stays as the raw landing/resume cache; a persist step upserts JSONL → DB. The planner decides whether persist is called inline per-record or as a separate `persist-sold.js` pass that reads JSONL via `readJsonl` (`lib/sold-transport.js:158-163`) and calls the `lib/sold-store.js` upserts. Either way: do NOT rip out the JSONL append (loses cheap idempotent resume).

## Shared Patterns

### DB client construction
**Source:** `db.js:4-16` — `createClient()`
**Apply to:** the migration script and any persist driver/wrapper that opens its own connection (the store/spend modules do NOT — they receive the client).
```javascript
function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}
```

### Client-first, no module-level connection
**Source:** `lib/spotcheck-review-store.js:7-9, 21` (export signatures `fn(client, {...})`)
**Apply to:** every persist export in `lib/sold-store.js` and the DB-backed `lib/sold-spend.js` path. Keeps offline smoke/recon paths DB-free.

### Parameterized SQL only
**Source:** `lib/spotcheck-review-store.js:11` + every query in that file and `cron-wrapper.js`
**Apply to:** all SQL in this phase. `$1,$2,…` placeholders, never string interpolation. Phase-13 security convention.

### Idempotent DDL + upsert (DB-03)
**Source:** `migrate-spotcheck-phase13.js` (`CREATE TABLE IF NOT EXISTS` + `UNIQUE(...)`), `migrate-*-add-fields.js` (`ADD COLUMN IF NOT EXISTS`), `lib/spotcheck-review-store.js:25` (`ON CONFLICT ... DO ...`)
**Apply to:** migration (re-runnable) and all three persist upserts (one row per sold record, no duplicates — D-01).

### Inline `--smoke` self-test
**Source:** `lib/spotcheck-review-store.js:91-196`, `lib/sold-parse.js:173-415`
**Apply to:** `lib/sold-store.js` and `lib/sold-spend.js`. Mock client captures SQL / returns canned rows; `node lib/<mod>.js --smoke` exits non-zero on any failure. No DB, no network.

## Column Contract (booli_sold / hemnet_sold → from `lib/sold-parse.js`)

Not an analog — the authoritative field→column map. Snake_case keys map 1:1; types per house style (BIGINT ids, TEXT strings, NUMERIC/INTEGER prices/areas, DATE sold dates, BOOLEAN flags, TIMESTAMPTZ audit).

**`booli_sold`** — union of `parseBooliSoldCards` (`lib/sold-parse.js:65-81`) and `parseBooliSoldDetail` (`lib/sold-parse.js:94-113`):
`booli_id` (BIGINT, **UNIQUE key**), `residence_url`, `residence_id`, `street_address`, `object_type`, `sold_price` (NUMERIC), `sold_date` (DATE), `sold_price_type`, `is_title_transfer` (BOOLEAN, D-02), `municipality`, `descriptive_area`, `living_area` (NUMERIC), `additional_area`, `plot_area`, `rooms` (NUMERIC), `floor`, `lat`, `long`, `rent` (NUMERIC), `operating_cost`, `construction_year` (INTEGER), `agent_id`, `agency_id`, `tenure_form`, `sold_in_advance` (BOOLEAN NULL — detail-only, D-04 recon).

**`hemnet_sold`** — `parseHemnetSaleCards` (`lib/sold-parse.js:137-156`):
`card_id`, `listing_id` (BIGINT), `slug` (TEXT → maps to **`hemnet_slug`** UNIQUE key per D-01), `detail_url`, `street_address`, `sold_at` (epoch INTEGER, or DATE), `sold_at_label`, `asking_price` (NUMERIC), `final_price` (NUMERIC), `living_area`, `rooms`, `fee` (NUMERIC), `housing_form`, `location_description`, `broker_name`, `broker_agency`, `lat`, `long`.

> Naming note (D-01): the parser emits `slug`; the table key is `hemnet_slug`. Planner maps `slug` → `hemnet_slug` in the upsert.

**sold verdict table** — designed in D-05, not parser-derived. Populated in Phase 17 from `adjudicatePair`; this phase only creates the table + `upsertSoldVerdict` plumbing.

## No Analog Found

None. Every file maps to a verified in-repo analog. The one genuinely new construct — the DB-backed atomic spend counter — composes two existing patterns (`cron-wrapper.js` atomic `UPDATE ... SET ... RETURNING` + `lib/sold-transport.js` `CeilingError`/file fallback) rather than introducing a net-new idiom.

## Metadata

**Analog search scope:** repo root (`migrate-*.js`, `db.js`, `cron-wrapper.js`), `lib/` (sold-* modules, `spotcheck-review-store.js`), `.planning/todos/pending/`.
**Files scanned (read or grepped):** `db.js`, `migrate-spotcheck-phase13.js`, `migrate-booli-listing-add-fields.js`, `migrate-cohort-pairs-soft-delete.js`, `lib/spotcheck-review-store.js`, `lib/sold-parse.js`, `lib/sold-transport.js`, `lib/sold-config.js`, `lib/sold-fetch-booli.js` (targeted), `cron-wrapper.js` (targeted), `harden-spend-ceiling-concurrency.md`.
**Pattern extraction date:** 2026-06-17
