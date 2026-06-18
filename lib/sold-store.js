// lib/sold-store.js
//
// Persist layer for the Phase 16 sold-match schema (DB-02). Client-first upsert
// functions for the three sold-side tables created by migrate-sold-phase16.js:
//   - booli_sold  (UNIQUE booli_id)    via upsertBooliSold
//   - hemnet_sold (UNIQUE hemnet_slug) via upsertHemnetSold
//   - sold_match  (UNIQUE booli_id)    via upsertSoldVerdict (+ D-02 gate)
//
// Every exported function takes a connected pg Client as its first argument.
// No top-level DB connection is opened here (keeps the offline --smoke DB-free).
// All queries use parameterised $1,$2,... placeholders — no string interpolation.
//
// Idempotency (DB-03): every upsert is INSERT ... ON CONFLICT (<stable_key>) DO
// UPDATE SET col = EXCLUDED.col, so re-running the persist pass refreshes enriched
// fields and yields zero duplicate rows (one row per sold record — D-01).
//
// Usage:
//   const { upsertBooliSold, upsertHemnetSold, upsertSoldVerdict,
//           persistVerdictForRecord } = require('./lib/sold-store');
//   node lib/sold-store.js --smoke

'use strict';

const { isTitleTransfer } = require('./sold-config');

// upsertBooliSold: one row per booli_id (D-01). 28 data columns in the fixed order
// of the migrate-sold-phase16.js DDL. ON CONFLICT (booli_id) DO UPDATE refreshes
// every enriched column from EXCLUDED + bumps updated_at, so a re-fetch (e.g. a
// detail-enriched pass over a card-only row) converges without duplicating (DB-03).
// booli_id is the only required value; every optional field is null-coalesced.
async function upsertBooliSold(client, row) {
  await client.query(
    `INSERT INTO booli_sold (
       booli_id, residence_url, residence_id, street_address, object_type, sold_price,
       sold_date, sold_price_type, is_title_transfer, municipality, descriptive_area,
       living_area, additional_area, plot_area, rooms, floor, lat, long, rent,
       operating_cost, construction_year, agent_id, agency_id, tenure_form,
       sold_in_advance, segment, family, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28)
     ON CONFLICT (booli_id) DO UPDATE SET
       residence_url=EXCLUDED.residence_url, residence_id=EXCLUDED.residence_id,
       street_address=EXCLUDED.street_address, object_type=EXCLUDED.object_type,
       sold_price=EXCLUDED.sold_price, sold_date=EXCLUDED.sold_date,
       sold_price_type=EXCLUDED.sold_price_type, is_title_transfer=EXCLUDED.is_title_transfer,
       municipality=EXCLUDED.municipality, descriptive_area=EXCLUDED.descriptive_area,
       living_area=EXCLUDED.living_area, additional_area=EXCLUDED.additional_area,
       plot_area=EXCLUDED.plot_area, rooms=EXCLUDED.rooms, floor=EXCLUDED.floor,
       lat=EXCLUDED.lat, long=EXCLUDED.long, rent=EXCLUDED.rent,
       operating_cost=EXCLUDED.operating_cost, construction_year=EXCLUDED.construction_year,
       agent_id=EXCLUDED.agent_id, agency_id=EXCLUDED.agency_id,
       tenure_form=EXCLUDED.tenure_form, sold_in_advance=EXCLUDED.sold_in_advance,
       segment=EXCLUDED.segment, family=EXCLUDED.family, scraped_at=EXCLUDED.scraped_at,
       updated_at=NOW()`,
    [
      row.booli_id, row.residence_url ?? null, row.residence_id ?? null,
      row.street_address ?? null, row.object_type ?? null, row.sold_price ?? null,
      row.sold_date ?? null, row.sold_price_type ?? null, row.is_title_transfer ?? null,
      row.municipality ?? null, row.descriptive_area ?? null, row.living_area ?? null,
      row.additional_area ?? null, row.plot_area ?? null, row.rooms ?? null,
      row.floor ?? null, row.lat ?? null, row.long ?? null, row.rent ?? null,
      row.operating_cost ?? null, row.construction_year ?? null, row.agent_id ?? null,
      row.agency_id ?? null, row.tenure_form ?? null, row.sold_in_advance ?? null,
      row.segment ?? null, row.family ?? null, row.scraped_at ?? null,
    ]
  );
}

// upsertHemnetSold: one row per hemnet_slug. The parser emits `slug`; the column is
// `hemnet_slug` (D-01 rename). 18 columns in the DDL fixed order. ON CONFLICT
// (hemnet_slug) DO UPDATE refreshes every column from EXCLUDED + updated_at.
async function upsertHemnetSold(client, row) {
  await client.query(
    `INSERT INTO hemnet_sold (
       hemnet_slug, card_id, listing_id, detail_url, street_address, sold_at,
       sold_at_label, asking_price, final_price, living_area, rooms, fee,
       housing_form, location_description, broker_name, broker_agency, lat, long)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (hemnet_slug) DO UPDATE SET
       card_id=EXCLUDED.card_id, listing_id=EXCLUDED.listing_id,
       detail_url=EXCLUDED.detail_url, street_address=EXCLUDED.street_address,
       sold_at=EXCLUDED.sold_at, sold_at_label=EXCLUDED.sold_at_label,
       asking_price=EXCLUDED.asking_price, final_price=EXCLUDED.final_price,
       living_area=EXCLUDED.living_area, rooms=EXCLUDED.rooms, fee=EXCLUDED.fee,
       housing_form=EXCLUDED.housing_form, location_description=EXCLUDED.location_description,
       broker_name=EXCLUDED.broker_name, broker_agency=EXCLUDED.broker_agency,
       lat=EXCLUDED.lat, long=EXCLUDED.long, updated_at=NOW()`,
    [
      row.slug ?? null, row.card_id ?? null, row.listing_id ?? null,
      row.detail_url ?? null, row.street_address ?? null, row.sold_at ?? null,
      row.sold_at_label ?? null, row.asking_price ?? null, row.final_price ?? null,
      row.living_area ?? null, row.rooms ?? null, row.fee ?? null,
      row.housing_form ?? null, row.location_description ?? null, row.broker_name ?? null,
      row.broker_agency ?? null, row.lat ?? null, row.long ?? null,
    ]
  );
}

// upsertSoldVerdict: one row per booli_id in sold_match (D-05 columns). Ships now as
// plumbing — Phase 17 fills `verdict` via adjudicatePair; sold_match stays empty this
// phase. ON CONFLICT (booli_id) DO UPDATE so re-adjudicating an overlapping window
// upserts, never duplicates. evidence is bound as a JSON string for the JSONB column
// (object in → JSON.stringify), never concatenated (T-16-05). matched_hemnet_slug
// accepts null (the booli_only / uncertain outcome is first-class — the spike's ~36%
// genuine-non-Hemnet finding, not an error).
async function upsertSoldVerdict(client, row) {
  await client.query(
    `INSERT INTO sold_match (
       booli_id, matched_hemnet_slug, verdict, match_method, evidence, segment,
       window_start, window_end, adjudicated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (booli_id) DO UPDATE SET
       matched_hemnet_slug=EXCLUDED.matched_hemnet_slug, verdict=EXCLUDED.verdict,
       match_method=EXCLUDED.match_method, evidence=EXCLUDED.evidence,
       segment=EXCLUDED.segment, window_start=EXCLUDED.window_start,
       window_end=EXCLUDED.window_end, adjudicated_at=EXCLUDED.adjudicated_at`,
    [
      row.booli_id, row.matched_hemnet_slug ?? null, row.verdict ?? null,
      row.match_method ?? null,
      row.evidence == null ? null : JSON.stringify(row.evidence),
      row.segment ?? null, row.window_start ?? null, row.window_end ?? null,
      row.adjudicated_at ?? null,
    ]
  );
}

// persistVerdictForRecord: the D-02 gate. Title transfers (deed transfers) are stored
// in booli_sold but NEVER enter the match table. Mirror the Phase-15 detail-scope gate:
// prefer the already-parsed boolean on the record, fall back to the config predicate
// for a record that only carries sold_price_type. Phase 17 fills `verdict`; this phase
// only ships the gate + plumbing — do NOT wire adjudicatePair here.
async function persistVerdictForRecord(client, record, verdict) {
  const isTransfer = record.is_title_transfer != null
    ? record.is_title_transfer
    : isTitleTransfer(record.sold_price_type);
  if (isTransfer) return false;            // D-02: deed transfers never enter the match table
  await upsertSoldVerdict(client, { booli_id: record.booli_id, ...verdict });
  return true;
}

// ---------------------------------------------------------------
// Phase-18 re-check scheduling helpers (RECHECK-01/02/03).
//
// These write/read the three nullable TIMESTAMPTZ columns added to sold_match by
// migrate-sold-recheck-phase18.js (first_unmatched_at, recheck_until, next_recheck_at).
// They are pure parameterized SQL primitives: the drain loop (Plan 04) computes WHEN to
// enroll / advance / settle / clear from an injected clock and passes pre-computed
// timestamps in. The store imports NO clock and NO config window — it only persists.
// Every value is bound via $1,$2,... — no string interpolation (T-18-05).
// ---------------------------------------------------------------

// enrollRecheck — RECHECK-01. Stamp scheduling state on a booli_only row that has
// none yet. Idempotent via `AND first_unmatched_at IS NULL`: a second enroll for an
// already-enrolled row updates zero rows. Timestamps are pre-computed by the caller
// (Plan 04's injected clock) and passed as ISO strings / Date — the store does NOT
// import the clock or the config window.
async function enrollRecheck(client, booliId, sched) {
  const r = await client.query(
    `UPDATE sold_match
        SET first_unmatched_at = $2, recheck_until = $3, next_recheck_at = $4
      WHERE booli_id = $1 AND verdict = 'booli_only' AND first_unmatched_at IS NULL`,
    [booliId, sched.firstUnmatchedAt, sched.recheckUntil, sched.nextRecheckAt]
  );
  return r.rowCount;
}

// advanceRecheck — RECHECK-02. Push next_recheck_at forward after a re-check that did
// NOT match (still booli_only, still in window). Verdict left unchanged.
async function advanceRecheck(client, booliId, nextRecheckAt) {
  const r = await client.query(
    `UPDATE sold_match SET next_recheck_at = $2
      WHERE booli_id = $1 AND verdict = 'booli_only'`,
    [booliId, nextRecheckAt]
  );
  return r.rowCount;
}

// settleNonHemnet — RECHECK-03. Terminal settle past recheck_until: verdict becomes
// 'genuine_non_hemnet' and next_recheck_at is NULLed so the row exits the due set and
// is never re-searched (no further Oxylabs spend). recheck_until/first_unmatched_at
// retained for audit. Guarded `AND verdict='booli_only'` so an already-settled or
// late-matched row is never clobbered (T-18-06).
async function settleNonHemnet(client, booliId, opts) {
  const r = await client.query(
    `UPDATE sold_match
        SET verdict = 'genuine_non_hemnet', next_recheck_at = NULL, adjudicated_at = $2
      WHERE booli_id = $1 AND verdict = 'booli_only'`,
    [booliId, (opts && opts.adjudicatedAt) || null]
  );
  return r.rowCount;
}

// clearRecheck — RECHECK-02 cleanup. When a re-check moves the verdict OFF the
// actionable 'booli_only' state (late 'matched', or an ambiguous 'uncertain' that
// routes to human review), clear the SCHEDULING state so the row leaves the drain queue.
// Verdict itself is set by the matchOne persist; this only nulls the scheduling columns.
// Guarded `AND verdict <> 'booli_only'` (WR-03) so a still-active booli_only row can never
// be accidentally dropped from the queue by a stray caller — clear only fires once the
// verdict has already moved off booli_only.
//
// IMPORTANT — `first_unmatched_at` is DELIBERATELY PRESERVED (not nulled). It is a
// HISTORICAL fact (this row was unmatched on the first scrape, then resolved later) and
// is the marker Phase-20 reporting uses to decompose a sold-cohort into first-scrape
// matches vs late-added (re-check-recovered) matches:
//   first-scrape matched = verdict 'matched' AND first_unmatched_at IS NULL
//   late-added matched   = verdict 'matched' AND first_unmatched_at IS NOT NULL
// Nulling it here erased that signal and made the "re-check-resolved-late" count read 0
// in production (the offline smoke masked it with a fixture that hand-set the column).
// Only the scheduling columns (recheck_until, next_recheck_at) take the row out of the
// due queue, so nulling those alone is sufficient. Re-enrollment is not a risk: enroll is
// guarded on `verdict = 'booli_only'`, and a matched/uncertain row never returns there.
async function clearRecheck(client, booliId) {
  const r = await client.query(
    `UPDATE sold_match
        SET recheck_until = NULL, next_recheck_at = NULL
      WHERE booli_id = $1 AND verdict <> 'booli_only'`,
    [booliId]
  );
  return r.rowCount;
}

// fetchDueRecheck — RECHECK-02. The "due for re-check" query. Returns booli_only rows
// that are enrolled, due (next_recheck_at <= now), and still in window (recheck_until
// >= now). Excludes terminal 'genuine_non_hemnet', plus 'matched'/'uncertain', by the
// verdict='booli_only' filter; excludes un-enrolled rows by first_unmatched_at IS NOT
// NULL. Rows PAST recheck_until are deliberately NOT returned here (Plan 04 settles
// them via a separate fetch). `now` is supplied by the caller's injected clock (SC-5).
// segment/limit are bound as $n params (the only string-built fragment is the integer
// placeholder index $${params.length}, never a value — T-18-05).
async function fetchDueRecheck(client, opts) {
  const o = opts || {};
  const params = [o.now];
  let sql =
    `SELECT booli_id, segment, verdict, first_unmatched_at, recheck_until, next_recheck_at,
            matched_hemnet_slug, evidence
       FROM sold_match
      WHERE verdict = 'booli_only'
        AND first_unmatched_at IS NOT NULL
        AND next_recheck_at <= $1
        AND recheck_until   >= $1`;
  if (o.segment != null) { params.push(o.segment); sql += ` AND segment = $${params.length}`; }
  sql += ` ORDER BY next_recheck_at ASC`;
  if (o.limit != null) { params.push(o.limit); sql += ` LIMIT $${params.length}`; }
  const r = await client.query(sql, params);
  return r.rows;
}

module.exports = {
  upsertBooliSold, upsertHemnetSold, upsertSoldVerdict, persistVerdictForRecord,
  enrollRecheck, advanceRecheck, settleNonHemnet, clearRecheck, fetchDueRecheck,
};

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/sold-store.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // Mock client capturing every (sql, params) pair. Returns `rowsToReturn` (default
  // empty) so the fetchDueRecheck SELECT test can assert seeded-row passthrough.
  function mockClient() {
    const calls = [];
    return {
      calls,
      rowsToReturn: [],
      query: async function (sql, params) { calls.push({ sql, params }); return { rows: this.rowsToReturn || [] }; },
    };
  }

  (async () => {
    // 1. exports: all four functions are typeof 'function'.
    check('exports: upsertBooliSold', () => assert.strictEqual(typeof upsertBooliSold, 'function'));
    check('exports: upsertHemnetSold', () => assert.strictEqual(typeof upsertHemnetSold, 'function'));
    check('exports: upsertSoldVerdict', () => assert.strictEqual(typeof upsertSoldVerdict, 'function'));
    check('exports: persistVerdictForRecord', () => assert.strictEqual(typeof persistVerdictForRecord, 'function'));

    // 2. upsertBooliSold sends ON CONFLICT (booli_id) DO UPDATE.
    await checkAsync('upsertBooliSold: ON CONFLICT (booli_id) DO UPDATE', async () => {
      const c = mockClient();
      await upsertBooliSold(c, { booli_id: 1 });
      assert.ok(c.calls[0].sql.includes('INSERT INTO booli_sold'), 'should INSERT INTO booli_sold');
      assert.ok(c.calls[0].sql.includes('ON CONFLICT (booli_id) DO UPDATE'),
        `SQL should contain ON CONFLICT (booli_id) DO UPDATE, got: ${c.calls[0].sql}`);
    });

    // 3. upsertHemnetSold sends ON CONFLICT (hemnet_slug) DO UPDATE.
    await checkAsync('upsertHemnetSold: ON CONFLICT (hemnet_slug) DO UPDATE', async () => {
      const c = mockClient();
      await upsertHemnetSold(c, { slug: 'abc-123' });
      assert.ok(c.calls[0].sql.includes('INSERT INTO hemnet_sold'), 'should INSERT INTO hemnet_sold');
      assert.ok(c.calls[0].sql.includes('ON CONFLICT (hemnet_slug) DO UPDATE'),
        `SQL should contain ON CONFLICT (hemnet_slug) DO UPDATE, got: ${c.calls[0].sql}`);
      // parser slug → $1 hemnet_slug
      assert.strictEqual(c.calls[0].params[0], 'abc-123', 'slug should map to $1 (hemnet_slug)');
    });

    // 4. upsertSoldVerdict sends ON CONFLICT (booli_id) DO UPDATE AND INSERT INTO sold_match.
    await checkAsync('upsertSoldVerdict: INSERT INTO sold_match + ON CONFLICT (booli_id) DO UPDATE', async () => {
      const c = mockClient();
      await upsertSoldVerdict(c, { booli_id: 5, verdict: 'matched' });
      assert.ok(c.calls[0].sql.includes('INSERT INTO sold_match'), 'should INSERT INTO sold_match');
      assert.ok(c.calls[0].sql.includes('ON CONFLICT (booli_id) DO UPDATE'),
        `SQL should contain ON CONFLICT (booli_id) DO UPDATE, got: ${c.calls[0].sql}`);
    });

    // 5. upsertSoldVerdict JSON-stringifies evidence (5th param).
    await checkAsync('upsertSoldVerdict: evidence JSON-stringified to $5', async () => {
      const c = mockClient();
      await upsertSoldVerdict(c, { booli_id: 6, evidence: { a: 1 } });
      assert.strictEqual(c.calls[0].params[4], '{"a":1}',
        `$5 should be the JSON string of evidence, got: ${JSON.stringify(c.calls[0].params[4])}`);
    });

    // 6. persistVerdictForRecord: title transfer → false, zero queries (D-02).
    await checkAsync('persistVerdictForRecord: title transfer → false + zero queries (D-02)', async () => {
      const c = mockClient();
      const r = await persistVerdictForRecord(c, { is_title_transfer: true, booli_id: 1 }, { verdict: 'matched' });
      assert.strictEqual(r, false, 'should return false for a title transfer');
      assert.strictEqual(c.calls.length, 0, 'must issue zero queries for a title transfer');
    });

    // 7. persistVerdictForRecord: market sale → true + INSERT INTO sold_match.
    await checkAsync('persistVerdictForRecord: market sale → true + sold_match write', async () => {
      const c = mockClient();
      const r = await persistVerdictForRecord(c, { is_title_transfer: false, booli_id: 2 }, { verdict: 'booli_only' });
      assert.strictEqual(r, true, 'should return true for a market sale');
      assert.ok(c.calls.length === 1 && c.calls[0].sql.includes('INSERT INTO sold_match'),
        'should issue one INSERT INTO sold_match');
    });

    // 8. persistVerdictForRecord: config-predicate fallback (no is_title_transfer field).
    await checkAsync('persistVerdictForRecord: Lagfart via config fallback → false', async () => {
      const c = mockClient();
      const r = await persistVerdictForRecord(c, { sold_price_type: 'Lagfart', booli_id: 3 }, { verdict: 'matched' });
      assert.strictEqual(r, false, 'Lagfart (no is_title_transfer field) should fall back to config predicate → false');
      assert.strictEqual(c.calls.length, 0, 'must issue zero queries for a Lagfart record');
    });

    // 9. upsertSoldVerdict accepts matched_hemnet_slug: null (booli_only verdict).
    await checkAsync('upsertSoldVerdict: matched_hemnet_slug null accepted', async () => {
      const c = mockClient();
      await upsertSoldVerdict(c, { booli_id: 7, matched_hemnet_slug: null, verdict: 'booli_only' });
      assert.strictEqual(c.calls[0].params[1], null, '$2 (matched_hemnet_slug) should be null');
    });

    // ---- Phase-18 re-check scheduling helpers (RECHECK-01/02/03) ----

    // 10. exports: all five scheduling helpers are typeof 'function'.
    check('exports: enrollRecheck', () => assert.strictEqual(typeof enrollRecheck, 'function'));
    check('exports: advanceRecheck', () => assert.strictEqual(typeof advanceRecheck, 'function'));
    check('exports: settleNonHemnet', () => assert.strictEqual(typeof settleNonHemnet, 'function'));
    check('exports: clearRecheck', () => assert.strictEqual(typeof clearRecheck, 'function'));
    check('exports: fetchDueRecheck', () => assert.strictEqual(typeof fetchDueRecheck, 'function'));

    // 11. enrollRecheck issues UPDATE with first_unmatched_at IS NULL idempotency guard.
    await checkAsync('enrollRecheck: UPDATE with first_unmatched_at IS NULL guard + params', async () => {
      const c = mockClient();
      await enrollRecheck(c, 1, {
        firstUnmatchedAt: '2026-06-01T00:00:00Z',
        recheckUntil: '2026-06-29T00:00:00Z',
        nextRecheckAt: '2026-06-08T00:00:00Z',
      });
      assert.ok(c.calls[0].sql.includes('UPDATE sold_match'), 'should UPDATE sold_match');
      assert.ok(c.calls[0].sql.includes('first_unmatched_at IS NULL'),
        `enroll must guard with first_unmatched_at IS NULL, got: ${c.calls[0].sql}`);
      assert.deepStrictEqual(c.calls[0].params,
        [1, '2026-06-01T00:00:00Z', '2026-06-29T00:00:00Z', '2026-06-08T00:00:00Z'],
        'params should be [booliId, firstUnmatchedAt, recheckUntil, nextRecheckAt]');
    });

    // 12. settleNonHemnet sets terminal verdict + nulls next_recheck_at, guarded by booli_only.
    await checkAsync('settleNonHemnet: verdict genuine_non_hemnet + next_recheck_at NULL', async () => {
      const c = mockClient();
      await settleNonHemnet(c, 2, { adjudicatedAt: '2026-06-30T00:00:00Z' });
      assert.ok(c.calls[0].sql.includes("verdict = 'genuine_non_hemnet'"), 'must set terminal verdict');
      assert.ok(c.calls[0].sql.includes('next_recheck_at = NULL'), 'must null next_recheck_at');
      assert.ok(c.calls[0].sql.includes("AND verdict = 'booli_only'"), 'must guard AND verdict = booli_only');
      assert.deepStrictEqual(c.calls[0].params, [2, '2026-06-30T00:00:00Z'], 'params [booliId, adjudicatedAt]');
    });

    // 13. clearRecheck nulls the scheduling columns but PRESERVES first_unmatched_at
    //     (the late-resolved marker Phase-20 uses to split first-scrape vs late-added).
    await checkAsync('clearRecheck: nulls scheduling cols, preserves first_unmatched_at', async () => {
      const c = mockClient();
      await clearRecheck(c, 3);
      assert.ok(c.calls[0].sql.includes('recheck_until = NULL'), 'must null recheck_until');
      assert.ok(c.calls[0].sql.includes('next_recheck_at = NULL'), 'must null next_recheck_at');
      assert.ok(!/first_unmatched_at = NULL/.test(c.calls[0].sql),
        'must NOT null first_unmatched_at (preserve the late-resolved marker)');
      assert.ok(/verdict <> 'booli_only'/.test(c.calls[0].sql), 'keeps the WR-03 booli_only guard');
    });

    // 14. advanceRecheck updates next_recheck_at only — verdict untouched.
    await checkAsync('advanceRecheck: next_recheck_at only, no verdict mutation', async () => {
      const c = mockClient();
      await advanceRecheck(c, 4, '2026-06-15T00:00:00Z');
      assert.ok(c.calls[0].sql.includes('SET next_recheck_at = $2'), 'must SET next_recheck_at = $2');
      // The only `verdict =` allowed is the WHERE guard; the SET clause must not touch verdict.
      const setClause = c.calls[0].sql.split('WHERE')[0];
      assert.ok(!/verdict\s*=/.test(setClause), 'SET clause must NOT mutate verdict');
      assert.deepStrictEqual(c.calls[0].params, [4, '2026-06-15T00:00:00Z'], 'params [booliId, nextRecheckAt]');
    });

    // 15. fetchDueRecheck filters to booli_only + due + in-window + enrolled.
    await checkAsync('fetchDueRecheck: booli_only + due + in-window + enrolled filters', async () => {
      const c = mockClient();
      await fetchDueRecheck(c, { now: '2026-06-10T00:00:00Z' });
      const sql = c.calls[0].sql;
      assert.ok(sql.includes("verdict = 'booli_only'"), 'must filter verdict = booli_only');
      assert.ok(sql.includes('next_recheck_at <= $1'), 'must filter next_recheck_at <= $1 (due)');
      assert.ok(/recheck_until\s+>= \$1/.test(sql), 'must filter recheck_until >= $1 (in-window)');
      assert.ok(sql.includes('first_unmatched_at IS NOT NULL'), 'must filter enrolled rows only');
      assert.strictEqual(c.calls[0].params[0], '2026-06-10T00:00:00Z', '$1 should be now');
    });

    // 16. fetchDueRecheck never selects terminal genuine_non_hemnet rows (by construction).
    await checkAsync('fetchDueRecheck: excludes terminal genuine_non_hemnet', async () => {
      const c = mockClient();
      await fetchDueRecheck(c, { now: '2026-06-10T00:00:00Z' });
      assert.ok(!c.calls[0].sql.includes('genuine_non_hemnet'),
        'due SELECT only matches booli_only, so terminal rows can never be returned');
    });

    // 17. fetchDueRecheck returns seeded rows from the (mock) DB.
    await checkAsync('fetchDueRecheck: returns seeded rows', async () => {
      const c = mockClient();
      c.rowsToReturn = [{ booli_id: 9, verdict: 'booli_only' }];
      const rows = await fetchDueRecheck(c, { now: '2026-06-10T00:00:00Z' });
      assert.strictEqual(rows.length, 1, 'should return one seeded row');
      assert.strictEqual(rows[0].booli_id, 9, 'should passthrough booli_id 9');
    });

    // 18. fetchDueRecheck applies segment + limit as bound params (no interpolation of values).
    await checkAsync('fetchDueRecheck: segment + limit bound params', async () => {
      const c = mockClient();
      await fetchDueRecheck(c, { now: '2026-06-10T00:00:00Z', segment: 'taby-villa', limit: 50 });
      const sql = c.calls[0].sql;
      assert.ok(sql.includes('segment = $2'), 'segment should bind to $2');
      assert.ok(sql.includes('LIMIT $3'), 'limit should bind to $3');
      assert.deepStrictEqual(c.calls[0].params, ['2026-06-10T00:00:00Z', 'taby-villa', 50],
        'params [now, segment, limit]');
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
