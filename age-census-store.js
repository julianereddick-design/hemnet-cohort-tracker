'use strict';
// age-census-store.js — every DB write/read for the monthly age census.
// Functions take an injected client so they unit-test offline against a stub;
// persistPool() is the one entry point that owns a connection.
// Spec: docs/superpowers/specs/2026-08-13-age-penetration-monthly-design.md
const { createClient } = require('./db');

const UPSERT_RUN = `
  INSERT INTO age_census_run
    (run_date, platform, pool, method, n_total, n_newbuild, n_newbuild_sampled,
     n_newbuild_sample_n, n_undated, buckets, buckets_secondhand, ox_calls,
     error_pages, runtime_s, status, notes)
  VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (run_date, platform, pool) DO UPDATE SET
    method=EXCLUDED.method, n_total=EXCLUDED.n_total, n_newbuild=EXCLUDED.n_newbuild,
    n_newbuild_sampled=EXCLUDED.n_newbuild_sampled,
    n_newbuild_sample_n=EXCLUDED.n_newbuild_sample_n, n_undated=EXCLUDED.n_undated,
    buckets=EXCLUDED.buckets, buckets_secondhand=EXCLUDED.buckets_secondhand,
    ox_calls=EXCLUDED.ox_calls, error_pages=EXCLUDED.error_pages,
    runtime_s=EXCLUDED.runtime_s, status=EXCLUDED.status, notes=EXCLUDED.notes,
    created_at=NOW()
  RETURNING id`;

const DELETE_MUNI = `DELETE FROM age_census_muni WHERE run_id = $1`;
const INSERT_MUNI = `
  INSERT INTO age_census_muni
    (run_id, muni_name, muni_id, headline_n, counted_n, buckets, buckets_secondhand)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (run_id, muni_id) DO UPDATE SET
    muni_name=EXCLUDED.muni_name, headline_n=EXCLUDED.headline_n,
    counted_n=EXCLUDED.counted_n, buckets=EXCLUDED.buckets,
    buckets_secondhand=EXCLUDED.buckets_secondhand`;

// status = 'ok' is load-bearing: this total is what gateTotalDrift anchors on. Anchoring on a
// gate-failed month is wrong in both directions — a broken 16,000 followed by a still-broken
// 16,000 shows 0% drift and PASSES, while a broken 16,000 followed by a CORRECT 33,742 shows
// 111% drift and wrongly gate-fails the good month. So the baseline is the most recent VALID
// prior row, which may be older than the immediately preceding one. Same rule the report's
// delta baseline already applies (commit 8260b7a).
const SELECT_PRIOR = `
  SELECT n_total FROM age_census_run
   WHERE platform = $1 AND pool = $2 AND run_date < $3::date AND status = 'ok'
   ORDER BY run_date DESC LIMIT 1`;

async function upsertRun(client, row) {
  const res = await client.query(UPSERT_RUN, [
    row.run_date, row.platform, row.pool, row.method, row.n_total, row.n_newbuild,
    row.n_newbuild_sampled, row.n_newbuild_sample_n, row.n_undated, row.buckets,
    row.buckets_secondhand, row.ox_calls, row.error_pages, row.runtime_s,
    row.status, row.notes,
  ]);
  return res.rows[0].id;
}

// Replace-then-insert so a re-run of a partially-written month leaves no orphan munis.
async function insertMuniRows(client, runId, muniRows) {
  if (!muniRows || muniRows.length === 0) return 0;
  await client.query(DELETE_MUNI, [runId]);
  let n = 0;
  for (const m of muniRows) {
    await client.query(INSERT_MUNI, [runId, m.name, m.id, m.headlineN, m.countedN, m.buckets, m.bucketsSecondhand]);
    n++;
  }
  return n;
}

async function getPriorTotal(client, { platform, pool, runDate }) {
  const res = await client.query(SELECT_PRIOR, [platform, pool, runDate]);
  return res.rows.length ? Number(res.rows[0].n_total) : null;
}

// Map scraper result (camelCase) to DB row shape (snake_case). Pure, testable function.
function toRunRow(result, runDate) {
  return {
    run_date: runDate,
    platform: result.platform,
    pool: result.pool,
    method: result.method,
    n_total: result.nTotal,
    n_newbuild: result.nNewbuild == null ? null : Math.round(result.nNewbuild),
    n_newbuild_sampled: !!result.newbuildSampled,
    n_newbuild_sample_n: result.newbuildSampleN == null ? null : result.newbuildSampleN,
    n_undated: result.nUndated,
    buckets: result.buckets,
    buckets_secondhand: result.bucketsSecondhand || null,
    ox_calls: result.oxCalls,
    error_pages: result.errorPages || 0,
    runtime_s: result.runtimeS == null ? null : Math.round(result.runtimeS),
    status: result.status,
    notes: result.notes || null,
  };
}

// One pool's full persistence. Owns its connection so a later pool's failure cannot
// roll back or block an earlier pool's already-banked row (spec §3).
async function persistPool(result, { runDate }) {
  const client = createClient();
  await client.connect();
  try {
    const runId = await upsertRun(client, toRunRow(result, runDate));
    const muniRows = await insertMuniRows(client, runId, result.muni || []);
    return { runId, muniRows };
  } finally {
    await client.end();
  }
}

module.exports = { upsertRun, insertMuniRows, getPriorTotal, persistPool, toRunRow };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };

  // Stub client: records queries, returns canned results. No DB, no network.
  function stubClient(returns = {}) {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql, params });
        if (/INSERT INTO age_census_run/.test(sql)) return { rows: [{ id: returns.runId || 42 }] };
        if (/SELECT n_total/.test(sql)) return { rows: returns.priorRows || [] };
        return { rows: [], rowCount: (params && params.length) || 0 };
      },
    };
  }
  const ROW = {
    run_date: '2026-09-01', platform: 'hemnet', pool: 'forsale', method: 'muni-partition',
    n_total: 43338, n_newbuild: 2789, n_newbuild_sampled: false, n_newbuild_sample_n: null,
    n_undated: 0,
    buckets: { le1m: 20889, m1_3: 11224, m3_6: 3164, m6_12: 2600, m12_18: 1950, m18_24: 911, gt24: 2600, undated: 0 },
    buckets_secondhand: { le1m: 19000, m1_3: 10500, m3_6: 3000, m6_12: 2500, m12_18: 1900, m18_24: 900, gt24: 2549, undated: 0 },
    ox_calls: 1208, error_pages: 0, runtime_s: 7200, status: 'ok', notes: null,
  };

  (async () => {
    await check('upsertRun: returns the row id and passes JSONB as objects', async () => {
      const c = stubClient({ runId: 7 });
      const id = await upsertRun(c, ROW);
      assert.strictEqual(id, 7);
      const q = c.calls.find(x => /INSERT INTO age_census_run/.test(x.sql));
      assert.ok(/ON CONFLICT \(run_date, platform, pool\) DO UPDATE/.test(q.sql), 'must upsert, not just insert');
      assert.ok(q.params.includes(43338), 'n_total must be bound');
      assert.strictEqual(typeof q.params[q.params.indexOf(ROW.buckets)], 'object');
    });

    await check('insertMuniRows: deletes prior rows for the run, then inserts each muni', async () => {
      const c = stubClient();
      const n = await insertMuniRows(c, 7, [
        { name: 'Stockholm', id: 17744, headlineN: 5000, countedN: 4998, buckets: {}, bucketsSecondhand: {} },
        { name: 'Alingsås', id: 17920, headlineN: 7, countedN: 7, buckets: {}, bucketsSecondhand: {} },
      ]);
      assert.strictEqual(n, 2);
      assert.ok(c.calls.some(x => /DELETE FROM age_census_muni/.test(x.sql)), 'must clear before insert so a re-run is idempotent');
      assert.strictEqual(c.calls.filter(x => /INSERT INTO age_census_muni/.test(x.sql)).length, 2);
    });

    await check('insertMuniRows: empty list is a no-op returning 0', async () => {
      const c = stubClient();
      assert.strictEqual(await insertMuniRows(c, 7, []), 0);
      assert.strictEqual(c.calls.filter(x => /INSERT INTO age_census_muni/.test(x.sql)).length, 0);
    });

    await check('getPriorTotal: returns the most recent earlier total, or null when none', async () => {
      const c1 = stubClient({ priorRows: [{ n_total: 33000 }] });
      assert.strictEqual(await getPriorTotal(c1, { platform: 'booli', pool: 'premarket', runDate: '2026-09-01' }), 33000);
      const c2 = stubClient({ priorRows: [] });
      assert.strictEqual(await getPriorTotal(c2, { platform: 'booli', pool: 'premarket', runDate: '2026-09-01' }), null);
      const q = c1.calls[0];
      assert.ok(/run_date < \$3/.test(q.sql), 'must exclude the current run date');
      assert.ok(/ORDER BY run_date DESC/.test(q.sql), 'must take the most recent prior');
      // Without this filter gateTotalDrift anchors on gate-failed months: two broken months in
      // a row show 0% drift and pass, and a correct month after a broken one shows 111% drift
      // and is wrongly gate-failed. The baseline must be the most recent VALID prior row.
      assert.ok(/status = 'ok'/.test(q.sql), "must anchor drift only on gate-passed prior rows");
    });

    await check('toRunRow maps a scraper result to the DB row shape, both variants', () => {
      // muni-partition variant: exact second-hand histogram, per-muni rows, exact new-build count
      const hemnet = toRunRow({
        platform: 'hemnet', pool: 'forsale', method: 'muni-partition',
        nTotal: 43338, nUndated: 0, nNewbuild: 2789, newbuildSampled: false, newbuildSampleN: null,
        buckets: { le1m: 1 }, bucketsSecondhand: { le1m: 1 },
        oxCalls: 1208, errorPages: 0, runtimeS: 7200.6, status: 'ok', notes: null,
      }, '2026-09-01');
      assert.strictEqual(hemnet.run_date, '2026-09-01');
      assert.strictEqual(hemnet.n_total, 43338);
      assert.strictEqual(hemnet.n_newbuild, 2789);
      assert.strictEqual(hemnet.n_newbuild_sampled, false);
      assert.strictEqual(hemnet.runtime_s, 7201, 'runtime must be rounded to an integer column');
      assert.deepStrictEqual(hemnet.buckets_secondhand, { le1m: 1 });

      // binary-search variant: NO second-hand histogram, sampled new-build estimate
      const booli = toRunRow({
        platform: 'booli', pool: 'premarket', method: 'binary-search',
        nTotal: 33742, nUndated: 0, nNewbuild: 67.4, newbuildSampled: true, newbuildSampleN: 2100,
        buckets: { le1m: 1 }, bucketsSecondhand: null,
        oxCalls: 60, errorPages: 0, runtimeS: null, status: 'gate_failed', notes: 'gates failed: total_drift',
      }, '2026-09-01');
      assert.strictEqual(booli.buckets_secondhand, null, 'binary-search pools must store NULL, not undefined');
      assert.strictEqual(booli.n_newbuild, 67, 'sampled estimate must be rounded for the integer column');
      assert.strictEqual(booli.n_newbuild_sample_n, 2100);
      assert.strictEqual(booli.runtime_s, null);
      assert.strictEqual(booli.status, 'gate_failed');
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
