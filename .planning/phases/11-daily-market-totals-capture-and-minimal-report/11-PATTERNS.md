# Phase 11: Daily market-totals capture + minimal report — Pattern Map

**Mapped:** 2026-05-27
**Files analyzed:** 5 (2 new, 3 modified — incl. 1 conditional)
**Analogs found:** 5/5 — all new code has a direct, in-repo analog

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `market-totals-daily.js` (NEW) | cron-wrapped scraper + DDL bootstrap + upsert | request-response → CRUD | `sfpl-region-snapshot.js` | exact (daily cron, inline DDL, multi-source `Promise.all`, idempotent UPSERT, `validate()` row-count check) |
| `market-totals-weekly-report.js` (NEW) | reporting consumer (DB read → Slack direct send) | CRUD-read → request-response (Slack) | `weekly-view-report.js` | exact (Mon-morning script, direct `sendSlack`, `SLACK_WEBHOOK_URL` env read, NOT cron-wrapped) |
| `weekly-view-report.js` (POTENTIALLY MODIFIED — only if planner embeds the consumer here instead of new file) | reporting consumer | CRUD-read → request-response | self | n/a (embed-in-place option) |
| `deploy-instructions.md` (MODIFIED) | docs / cron registry | n/a | self (lines 43-66 + 76-81) | n/a |
| `.planning/ROADMAP.md` (MODIFIED) | docs | n/a | self (Phase 11 SC-1/SC-2 + out-of-scope) | n/a |

**Operator preference (D-04):** "Recommend a new `market-totals-weekly-report.js` (clean separation; one concern per script). Embedding in `weekly-view-report.js` is also acceptable but pulls market-totals concerns into the cohort report; reject if it adds a market-totals DB query path to the cohort report."

---

## Pattern Assignments

### `market-totals-daily.js` (NEW; controller-style cron job, request-response → CRUD)

**Analog:** `sfpl-region-snapshot.js` (the daily cron-wrapped multi-source aggregator with inline DDL — locked by CONTEXT.md `<canonical_refs>` line 126).

**Pattern A — top-level imports + DDL block** (`sfpl-region-snapshot.js:1`, `:16-29`):
```javascript
// sfpl-region-snapshot.js:1
const { runJob } = require('./cron-wrapper');

// sfpl-region-snapshot.js:16-25 — inline CREATE TABLE IF NOT EXISTS
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS sfpl_region_daily (
    snapshot_date   DATE    NOT NULL,
    region          TEXT    NOT NULL,
    age_bucket      TEXT    NOT NULL,
    booli_pm_count  INTEGER NOT NULL DEFAULT 0,
    hemnet_fs_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (snapshot_date, region, age_bucket)
  )
`;
```

**Planner pastes this DDL adapted from CONTEXT.md D-06 (table is `market_totals`, columns differ — but the *form* is identical: const string, ran at top of `main()`).** Phase 11 also needs `lib/scrape-http.js` imports because this job does live HTTP, unlike `sfpl-region-snapshot.js` (which is DB-only). The HTTP-import excerpt is in Pattern E below.

**Pattern B — `main(client, log)` signature + Promise.all over independent sources** (`sfpl-region-snapshot.js:65-73`):
```javascript
async function main(client, log) {
  await client.query(CREATE_TABLE);
  await client.query(ADD_BOOLI_FS_COL);

  const [booliRes, booliFs, hemnetRes] = await Promise.all([
    client.query(BOOLI_QUERY),
    client.query(BOOLI_FS_QUERY),
    client.query(HEMNET_QUERY),
  ]);
  // ... aggregate ...
}
```

**Adaptation for Phase 11:** swap the three internal `client.query(...)` for three HTTP fetches:
```javascript
const [hemnetRes, booliTillSaluRes, booliKommandeRes] = await Promise.all([
  getWithRetry('https://www.hemnet.se/bostader',                       { logger: log }),
  getWithRetry('https://www.booli.se/sok/till-salu?upcomingSale=0',    { logger: log }),
  getWithRetry('https://www.booli.se/sok/till-salu?upcomingSale=1',    { logger: log }),
]);
```
This collapses Hemnet (1 fetch, both segments) + Booli (2 fetches, one per segment) into the locked 3-fetch budget in CONTEXT.md D-01.

**Pattern C — `runJob` invocation at bottom of file with sync `validate()`** (`sfpl-region-snapshot.js:134-143`):
```javascript
runJob({
  scriptName: 'sfpl-region-snapshot',
  main,
  validate: (summary) => {
    if (summary.rowCount !== 18) {
      return `Expected 18 rows upserted, got ${summary.rowCount}`;
    }
    return null;
  },
});
```

**Adaptation for Phase 11 — sync validate(); per CONTEXT.md D-03 the conditions are:**
1. `rowsWritten !== 4` → warn (mirrors the rowCount check above)
2. `fetched_at` older than 1h before NOW (defensive — should never fire if same-run insert)

**GOTCHA — DO NOT add the following validate() warnings (Plan 10-02 lesson):**
- ❌ `oxylabsFallbackRate > 0.30` — explicitly stripped from Jobs A/C/D in Plan 10-02 (a)/(b) (commit f7b22bc series). For market-totals this rate will be ~100% (Cloudflare-protected top-level search pages — same as Booli view data per `[[project-hemnet-flipped-to-oxylabs]]`). The rate stays in `resultSummary` as a reporting field only, never as a warn trigger.

**Pattern D — idempotent INSERT … ON CONFLICT** (`sfpl-region-snapshot.js:103-108`):
```javascript
const UPSERT = `
  INSERT INTO sfpl_region_daily (snapshot_date, region, age_bucket, booli_pm_count, hemnet_fs_count, booli_fs_count)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (snapshot_date, region, age_bucket)
  DO UPDATE SET booli_pm_count = EXCLUDED.booli_pm_count, hemnet_fs_count = EXCLUDED.hemnet_fs_count, booli_fs_count = EXCLUDED.booli_fs_count
`;
```

**Adaptation for Phase 11** (per CONTEXT.md D-06):
```javascript
const UPSERT = `
  INSERT INTO market_totals (day, site, segment, total, fetched_at, source_url)
  VALUES ($1, $2, $3, $4, NOW(), $5)
  ON CONFLICT (day, site, segment)
  DO UPDATE SET total = EXCLUDED.total, fetched_at = EXCLUDED.fetched_at, source_url = EXCLUDED.source_url
`;
```

**Pattern E — `getWithRetry(url, opts)` call site (real-world Booli + Hemnet examples).** Source signature: `lib/scrape-http.js:290` — `async function getWithRetry(targetUrl, opts = {})`. Note the call shape: **second arg is an `opts` object with `logger` key, NOT a bare `log` function** — multiple sibling jobs pass `{ logger: log }`.

- Booli search call (`lib/booli-fetch.js:261-273`) — closest analog for a top-level search-page fetch + `__APOLLO_STATE__` walk:
```javascript
// lib/booli-fetch.js:265-280 — Booli top-level search → Apollo state
const targetUrl = `https://www.booli.se/sok/till-salu?areaIds=${areaId}&page=${page}`;
const res = await getWithRetry(targetUrl, opts);
if (res.status === 404) { /* ... */ }
const data = extractNextData(res.html);
const apolloState =
  data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
if (!apolloState) {
  throw new Error(`booli-fetch: no __APOLLO_STATE__ in search for areaId=${areaId} page=${page}`);
}
```

- Hemnet search call (`lib/hemnet-fetch.js:172-190`) — identical shape, different URL:
```javascript
// lib/hemnet-fetch.js:176-189
const targetUrl = `https://www.hemnet.se/bostader?location_ids[]=${locationId}&sort=${sort}&page=${page}`;
const res = await getWithRetry(targetUrl, opts);
if (res.status === 404) { /* ... */ }
const data = extractNextData(res.html);
const apolloState =
  data && data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__;
if (!apolloState) {
  throw new Error(`hemnet-fetch: no __APOLLO_STATE__ in search for location_id=${locationId} page=${page}`);
}
```

- Worker-level call-site shape from a top-level script (`booli-targeted-discovery.js:394`, `:486`):
```javascript
// booli-targeted-discovery.js:486
searchResult = await fetchBooliSearch(countyDef.areaId, { page, logger: log });
// booli-targeted-discovery.js:394
detail = await fetchBooliDetail(card.url, { logger: log });
```
And on the Hemnet side (`hemnet-targeted-refresh.js:118`):
```javascript
result = await fetchDetail(id, { logger: log });
```

**Phase 11 deviates** from these analogs in one way: `market-totals-daily.js` does NOT need a `lib/market-totals-fetch.js` wrapper. Both Booli and Hemnet expose the totals on the top-level search page's `__APOLLO_STATE__.ROOT_QUERY` directly — a 10-line walk inside `main()` is enough. No new library file; call `getWithRetry` + `extractNextData` directly. Imports:
```javascript
const { getWithRetry, extractNextData } = require('./lib/scrape-http');
```

**Pattern F — JSON-path walk into `__APOLLO_STATE__.ROOT_QUERY` (LOCKED per CONTEXT.md D-01).** The probe script (`scripts/probe-total-listings.js`, 2026-05-27) established these as the canonical paths. They are NOT re-validated by Phase 11 — D-02 inline smoke probe checks key-presence + numeric only.

For Hemnet (`https://www.hemnet.se/bostader` — 1 fetch yields both segments):
```javascript
const data = extractNextData(res.html);
const apollo = data?.props?.pageProps?.__APOLLO_STATE__;
if (!apollo) throw new Error('hemnet: no __APOLLO_STATE__');

const root = apollo.ROOT_QUERY;
// ROOT_QUERY keys are stringified call signatures — find the right one:
//   searchForSaleListings({...}) → .total       → till_salu
//   searchUpcomingListings({...}) → .total       → kommande
let tillSalu, kommande;
for (const k of Object.keys(root)) {
  if (k.startsWith('searchForSaleListings')) tillSalu = root[k]?.total;
  if (k.startsWith('searchUpcomingListings')) kommande = root[k]?.total;
}
```
> **Note for planner:** the probe output in `verf-totals/hemnet-next-data.json` (gitignored, operator-local) shows the exact key spelling — the planner may want a smoke `node -e` to dump keys before writing code if there's any doubt. CONTEXT.md says "Do NOT re-run as a Phase 11 gate; the paths are locked." So treat the walk above as canonical and let the D-02 smoke check guard schema drift.

For Booli (2 fetches, one per segment):
```javascript
// Same walk, different key prefix — searchForSale → totalCount
const tillSaluTotal = (() => {
  const root = apolloTillSalu.ROOT_QUERY;
  for (const k of Object.keys(root)) {
    if (k.startsWith('searchForSale')) return root[k]?.totalCount;
  }
})();
// Same for upcomingSale=1 → kommandeTotal
```
> **Walking via `Object.keys` + `startsWith`** is the right approach because Apollo serializes the call args into the key (e.g. `searchForSaleListings({"input":{"locations":[]}})`) — exact string matching is brittle to argument-shape changes; prefix-match is stable. This is the same pattern `lib/hemnet-fetch.js:194-204` already uses for `totalPages`:
```javascript
// lib/hemnet-fetch.js:196-204 — prefix-match Apollo ROOT_QUERY scan
const root = apolloState.ROOT_QUERY;
if (root && typeof root === 'object') {
  for (const key of Object.keys(root)) {
    const v = root[key];
    if (v && typeof v === 'object' && typeof v.totalPages === 'number') {
      totalPages = v.totalPages;
      break;
    }
  }
}
```

**Pattern G — inline pre-flight smoke-probe (D-02).** No existing analog — invent inline. Suggested shape (planner can lift verbatim):
```javascript
function assertNumericTotal(label, n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || Number.isNaN(n)) {
    throw new Error(
      `JSON path missing for ${label}: expected positive number, got ${n === undefined ? 'undefined' : JSON.stringify(n)}`
    );
  }
}
assertNumericTotal('hemnet.till_salu', tillSaluHemnet);
assertNumericTotal('hemnet.kommande',  kommandeHemnet);
assertNumericTotal('booli.till_salu',  tillSaluBooli);
assertNumericTotal('booli.kommande',   kommandeBooli);
```
Throws bubble up through `cron-wrapper.runJob`, which marks the row `status='failure'` and (because `SLACK_WEBHOOK_URL` is set) pages on the cron-wrapper webhook (`cron-wrapper.js:155-161`).

**Pattern H — `resultSummary` shape (per CONTEXT.md D-07).** Cron-wrapper persists it to `cron_job_log.result_summary` as JSON (`cron-wrapper.js:147-148`). Suggested:
```javascript
return {
  rowsWritten: 4,
  perRow: [
    { site: 'hemnet', segment: 'till_salu', total: tillSaluHemnet, fetchMs: hemnetFetchMs, viaOxylabs: true },
    { site: 'hemnet', segment: 'kommande',  total: kommandeHemnet,  fetchMs: hemnetFetchMs, viaOxylabs: true },
    { site: 'booli',  segment: 'till_salu', total: tillSaluBooli,   fetchMs: booliTillSaluFetchMs, viaOxylabs: true },
    { site: 'booli',  segment: 'kommande',  total: kommandeBooli,   fetchMs: booliKommandeFetchMs, viaOxylabs: true },
  ],
  hemnetFetchMs,
  booliTillSaluFetchMs,
  booliKommandeFetchMs,
  oxylabsFallbackRate, // reporting field ONLY — not a warn trigger (Plan 10-02 lesson)
};
```
Pull `oxylabsFallbackRate` from `lib/scrape-http.getOxylabsStats()`. The weekly consumer does NOT read this — it queries `market_totals` directly (cohesion).

**Gotchas inherited from the analog stack:**
- ✅ Signal-handler recovery (SIGHUP/SIGTERM/SIGINT → `status='killed'`) is already in `cron-wrapper.js:96-109` from Plan 10-01. Free.
- ✅ Slack alerting on failure/warning is already in `cron-wrapper.js:155-161`. Daily job is silent on success; weekly consumer is the only success-path Slack surface. Do NOT add a direct Slack call inside `main()` (Pool & Flow legacy pattern being retired in 10-05).
- ✅ `cron-wrapper.js:116` already sets `statement_timeout = '120000'` — fine for this job (3 HTTP fetches + 4 UPSERTs).
- ⚠️ Daily job is **silent on success** by design. No Slack call from inside `market-totals-daily.js`. The weekly consumer is the only success-path Slack surface.

---

### `market-totals-weekly-report.js` (NEW — primary option per D-04; reporting consumer, CRUD-read → Slack)

**Analog:** `weekly-view-report.js` (locked by CONTEXT.md `<canonical_refs>` line 129).

**Pattern A — module-level imports + inline `sendSlack` helper** (`weekly-view-report.js:1-30`) — **the verbatim template** for the Slack send:
```javascript
require('dotenv').config();
const { execSync } = require('child_process');     // OMIT — Phase 11 weekly consumer has no shellouts
const https = require('https');
const { createClient } = require('./db');

// weekly-view-report.js:9-30 — paste this helper VERBATIM into market-totals-weekly-report.js
async function sendSlack(webhookUrl, message) {
  const payload = JSON.stringify({ text: message });
  const parsed = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Slack ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(payload);
    req.end();
  });
}
```

**Pattern B — `run()` entry + DB read** (`weekly-view-report.js:32-51`) — the shape to mirror, but with `market_totals` queries instead of `cohort_pairs`/`cohort_daily_views`:
```javascript
async function run() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== Market Supply Pulse — ${today} ===\n`);

  const client = createClient();
  await client.connect();

  // Phase 11 needs 4 rows: hemnet & booli × {today, today-7} for till_salu only
  // (D-04: Kommande captured but not surfaced in v1 consumer)
  const res = await client.query(`
    SELECT site, segment, day, total
    FROM market_totals
    WHERE segment = 'till_salu'
      AND day IN (CURRENT_DATE, CURRENT_DATE - INTERVAL '7 days')
    ORDER BY site, day
  `);

  await client.end();
  // ... shape rows into hemnetThis / hemnetPrior / booliThis / booliPrior ...
}
```

**Pattern C — Slack invocation block at end of `run()`** (`weekly-view-report.js:94-121`):
```javascript
const webhookUrl = process.env.SLACK_WEBHOOK_URL;
// ... build `message` string (multi-line) ...
if (webhookUrl) {
  try {
    await sendSlack(webhookUrl, message);
    console.log('Slack notification sent');
  } catch (err) {
    console.error(`Slack failed: ${err.message}`);
  }
} else {
  console.log('Skipping Slack (SLACK_WEBHOOK_URL not set)');
}
```

**Adapted message body** — paste the LOCKED format from CONTEXT.md D-04 verbatim:
```
Market supply pulse — Till salu, week of 2026-05-25
Hemnet:           50,769 →  51,289   (+520, +1.0%)
Booli:            60,560 →  60,924   (+364, +0.6%)
Booli − Hemnet:    9,791 →   9,635   (-156)
```
Use ``` ``` Slack code-block fences (Slack renders monospace, preserving column alignment). Number formatting: `n.toLocaleString('en-US')` yields comma-separated thousands ("50,769") — per D-04 operator preference. Right-pad/space-align in JS, then wrap in the triple-backtick fence.

**Pattern D — script termination** (`weekly-view-report.js:126-129`) — bare `.catch(err => process.exit(1))`. Phase 11 weekly consumer follows the same pattern. **Note:** unlike `market-totals-daily.js`, the weekly consumer is **NOT** wrapped in `cron-wrapper.runJob` — `weekly-view-report.js` itself isn't (it just calls `run()` at module load). Reporting consumers don't go through `cron_job_log`; they are fire-and-forget.

**Pattern E — missing-data handling for D-04 ("?" rendering).** No existing analog — invent. Suggested:
```javascript
function renderDelta(curr, prior) {
  if (curr == null || prior == null) return '?';
  const abs = curr - prior;
  const pct = prior === 0 ? '?' : `${(abs / prior * 100).toFixed(1)}%`;
  const sign = abs >= 0 ? '+' : '';
  return `${sign}${abs.toLocaleString('en-US')}, ${sign}${pct}`;
}
```
Per D-04: missing prior-week row → render `?`, log at WARN, do NOT crash.

**Gotchas:**
- ⚠️ This script reads `SLACK_WEBHOOK_URL` directly (line `weekly-view-report.js:94`), same as the analog. Same env var used by `cron-wrapper.js:156`. No new env var needed.
- ⚠️ First valid run is ≥ 7 days after Phase 11 cron deploy (D-04). Earlier runs will hit the "?" path on all rows. Operator-aware; not a defect.
- ✅ NOT wrapped in `runJob` — no `cron_job_log` row, no failure-path Slack alert. If the script crashes, the only signal is `/var/log/hemnet/market-totals-weekly-report.log` going silent. Operator is OK with this trade-off (mirrors `weekly-view-report.js`).

---

### `weekly-view-report.js` (POTENTIALLY MODIFIED — embed-in-place alternative to a new file)

**Per CONTEXT.md D-04:** "Embedding in `weekly-view-report.js` is also acceptable but pulls market-totals concerns into the cohort report; reject if it adds a market-totals DB query path to the cohort report."

**If the planner picks this option** (operator-defaulted to NEW file, but acceptable fallback), the changes are:
1. Add a new top-level helper `async function fetchMarketTotalsBlock(client, today)` that returns the formatted text block.
2. Call it after the cohort logic (~ line 75, after `if (exportedCohorts.length === 0) ...`) — re-use the same `client` connection, but query `market_totals` table.
3. Concatenate its output onto the `message` array (lines 104-110).
4. **Risk to flag in plan:** adds a 2nd DB query path to a previously single-concern script. CONTEXT.md operator preference is to REJECT this option if the embed adds a market-totals DB query path — which it inherently must. **Planner should default to the new-file option.**

---

### `deploy-instructions.md` (MODIFIED — crontab registry)

**Current crontab inventory** (`deploy-instructions.md:43-66` for Phase 9 block; `:72-82` for supplementary fan-out). Read this section before drafting the edit. Concrete current state:

```cron
# === v1.0 preserved jobs (D-08) — invocation pattern corrected per the runJob-direct-require contract above ===
0 6 * * 1   cd /opt/hemnet-cohort-tracker && node cohort-create.js              >> /var/log/hemnet/cohort-create.log 2>&1
0 8 * * *   cd /opt/hemnet-cohort-tracker && node sfpl-region-snapshot.js       >> /var/log/hemnet/sfpl.log 2>&1
```
… and the Mon-morning fan-out at `deploy-instructions.md:76-81`:
```cron
# Weekly reporting fan-out — Mondays 09:00 UTC and shortly after.
0 9 * * 1   cd /opt/hemnet-cohort-tracker && node listing-gap-monitor.js
0 9 * * 1   cd /opt/hemnet-cohort-tracker && node flow-monitor.js
15 9 * * 1  cd /opt/hemnet-cohort-tracker && node pool-flow-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node generate-pool-flow-charts.js
```

**Two new crontab lines Phase 11 adds:**

```cron
# Phase 11 (v2.2): Daily market-totals capture — Hemnet + Booli nationwide listing totals.
30 8 * * *  cd /opt/hemnet-cohort-tracker && node market-totals-daily.js        >> /var/log/hemnet/market-totals.log 2>&1

# Phase 11 (v2.2): Weekly market-supply Slack pulse — Mondays 09:30 UTC, after weekly-view-report.
30 9 * * 1  cd /opt/hemnet-cohort-tracker && node market-totals-weekly-report.js >> /var/log/hemnet/market-totals-weekly.log 2>&1
```

**Pattern source:** every existing cron line in `deploy-instructions.md:45-65, 74-81` follows the same shape: `<schedule> cd /opt/hemnet-cohort-tracker && node <script>.js [args] >> /var/log/hemnet/<name>.log 2>&1`. The new lines must conform.

**Cron slot rationale (D-05):**
- **08:30 UTC daily** — clear of all existing slots: `cohort-create` Mon 06:00, `cron-health-slack` daily 03:00, `sfpl-region-snapshot` daily 08:00, Job A/D parallel every-2-days 14:00, cohort-track every-2-days 22:00, Job C Sun 22:00, Job B Mon 03:00, Mon fan-out 09:00-09:30. 30-min buffer after `sfpl-region-snapshot` 08:00 is generous (`sfpl` is DB-only and finishes in seconds — see `sfpl-region-snapshot.js` no HTTP).
- **Mon 09:30 UTC weekly** — chains AFTER `weekly-view-report.js` (also 09:30). Note: deploy-instructions.md:80 has `weekly-view-report.js` at 09:30; D-05 says "after the Mon 09:00 UTC droplet fan-out". To literally chain *after* `weekly-view-report.js` the planner could move to `35 9 * * 1` or `40 9 * * 1` — both lines firing at 09:30 will race. **Operator-decision point flagged for the planner.** Per the project memory `[[project-deploy-process]]`, deploy is `git pull` on droplet, so concurrent log writes to separate files is fine.

**Verify-before-edit pattern** (already documented at `deploy-instructions.md:86-93`):
```bash
ssh root@<droplet>
mkdir -p /var/log/hemnet
crontab -l > /tmp/crontab-backup-$(date +%s).txt
diff /tmp/crontab-backup-$(date +%s).txt deploy-instructions.md
crontab -e
# paste the block above; save
crontab -l   # verify
```
The Phase 11 plan should reference this block, not duplicate it.

---

### `.planning/ROADMAP.md` (MODIFIED — per CONTEXT.md `<roadmap_updates_needed>`)

Three locked edits (CONTEXT.md lines 189-197):

1. **SC-1** (ROADMAP line 162) — replace:
   > `writes 6 rows/day (Hemnet × 3 segments + Booli × 3 segments) on success`

   with:
   > `writes 4 rows/day (Hemnet × 2 segments + Booli × 2 segments) on success — Till salu + Kommande only; Sold dropped during discuss`

2. **SC-2** (ROADMAP line 162) — drop the `or unexpected delta` clause. Final wording:
   > `warns to Slack on JSON-path-break or fetch failure`

3. **Out-of-scope** (ROADMAP line 173) — append to the existing out-of-scope list:
   > `Sold totals — operator-deferred during Phase 11 discuss; JSON paths known but reserved for a future plan`

No code excerpt analog needed — these are documentation-only line edits. Planner should treat as a single `Edit`-tool task at start of plan-phase (or via `/gsd-phase edit 11`).

---

## Shared Patterns

### Pattern: `lib/scrape-http.js` import + call signature

**Source:** `lib/scrape-http.js:290, :404-409` (public surface):
```javascript
async function getWithRetry(targetUrl, opts = {})  // returns { status, html }
function extractNextData(html)                       // returns parsed JSON
function getOxylabsStats()                           // returns { oxylabsCallCount, oxylabsFailureCount, directSuccessCount, oxylabsFallbackRate }
function resetOxylabsStats()
```

**Apply to:** `market-totals-daily.js` only. Call shape (matches every existing call site in `lib/booli-fetch.js:266`, `lib/hemnet-fetch.js:155, :177, :227`, and worker call sites in `booli-targeted-discovery.js:394, :486` and `hemnet-targeted-refresh.js:118`):
```javascript
const { getWithRetry, extractNextData, getOxylabsStats } = require('./lib/scrape-http');
const res = await getWithRetry(url, { logger: log });
const data = extractNextData(res.html);
```

> **DO NOT re-implement the Oxylabs POST inline.** That pattern lives in `scripts/probe-total-listings.js` for ad-hoc probes (lines 43-93) — it is NOT a production analog. CONTEXT.md D-07: "Do NOT re-implement the Oxylabs POST inline like `scripts/probe-total-listings.js` did."

### Pattern: `cron-wrapper.runJob` contract

**Source:** `cron-wrapper.js:57-170` (public surface):
- Called as `runJob({ scriptName, main, validate })`
- `main(client, log)` — receives connected pg.Client + tagged logger; returns `resultSummary` (any JSON-serializable value)
- `validate(resultSummary)` — sync; return a string → warning; return null/undefined → success
- Catches throws → marks row `status='failure'`, sets `error_message` to `err.message`
- Persists `resultSummary` to `cron_job_log.result_summary` as JSON (`cron-wrapper.js:147-148`)
- Fires Slack via `SLACK_WEBHOOK_URL` on `failure` or `warning` (`cron-wrapper.js:155-161`)
- SIGHUP/SIGTERM/SIGINT → `status='killed'` (Plan 10-01 hardening, `cron-wrapper.js:96-109`)

**Apply to:** `market-totals-daily.js` only. The weekly consumer follows the `weekly-view-report.js` no-wrapper pattern.

### Pattern: Slack send (direct, from reporting consumers only)

**Source:** `weekly-view-report.js:9-30` (verbatim template — see Pattern A in the weekly-consumer section above).

**Apply to:** `market-totals-weekly-report.js` only. NEVER in `market-totals-daily.js` (CONTEXT.md `<code_context>` "Patterns NOT to Apply" line 162: "Do NOT add a Pool & Flow-style direct-to-Slack reporting call from inside the daily job — that's the legacy pattern being retired in Plan 10-05").

### Pattern: `db.js` createClient (weekly consumer only)

**Source:** `db.js:4-14`:
```javascript
const { createClient } = require('./db');
// usage:
const client = createClient();
await client.connect();
// ... queries ...
await client.end();
```
Apply to: `market-totals-weekly-report.js`. (The daily job's pg.Client is provided by `cron-wrapper.runJob`.)

---

## No Analog Found

Files / sub-features with **no existing in-repo analog**, where the planner should invent and inline (no other reference exists):

| Sub-feature | Where it lives | Reason |
|-------------|----------------|--------|
| Inline JSON-path smoke probe (D-02) | `market-totals-daily.js` `main()` top | No other cron job validates Apollo state shape inline — sibling jobs throw on missing `__APOLLO_STATE__` but don't do per-key numeric checks. Pattern G above is a suggested inline implementation; planner should paste it. |
| WoW delta math + "?" missing-data rendering (D-04) | `market-totals-weekly-report.js` | No existing report does week-over-week math against the same table. Pattern E above is a suggested inline implementation. |
| `market_totals` table schema | `market-totals-daily.js` inline DDL | New table — no prior schema to copy. CONTEXT.md D-06 locks the DDL verbatim; planner pastes it. |

---

## Metadata

**Analog search scope:** all top-level `*.js` cron jobs (`cohort-create.js`, `cohort-track.js`, `sfpl-region-snapshot.js`, `hemnet-targeted-refresh.js`, `hemnet-targeted-match.js`, `booli-targeted-discovery.js`, `booli-targeted-refresh.js`, `weekly-view-report.js`), `lib/scrape-http.js` + `lib/booli-fetch.js` + `lib/hemnet-fetch.js` (HTTP transport), `cron-wrapper.js` + `db.js` (infrastructure), `scripts/probe-total-listings.js` (empirical reference for JSON paths), `deploy-instructions.md` (crontab registry).

**Files read** (line ranges examined, non-overlapping):
- `sfpl-region-snapshot.js` (1-143) — full file, 143 lines
- `cron-wrapper.js` (1-172) — full file
- `lib/scrape-http.js` (1-410) — full file
- `weekly-view-report.js` (1-130) — full file
- `scripts/probe-total-listings.js` (1-228) — full file
- `deploy-instructions.md` (1-268) — full file
- `lib/booli-fetch.js` (250-330) — public surface + module exports
- `lib/hemnet-fetch.js` (140-250) — public surface
- `db.js` (1-17) — full file
- `.planning/phases/11-daily-market-totals-capture-and-minimal-report/11-CONTEXT.md` (1-203) — full file
- `.planning/ROADMAP.md` (1-196) — full file
- `.planning/STATE.md` (1-55) — full file

**Pattern extraction date:** 2026-05-27
