'use strict';
// migrate-sold-backfill-single-candidate.js — one-off, idempotent, transactional.
//
// Re-evaluates the STORED evidence on current `uncertain` sold_match rows and flips
// the ones that satisfy the single-candidate apartment confirmation rule to `matched`
// (match_method='single_candidate_confirmed_backfill'). NO scraping — reads only the
// evidence JSONB already persisted on each row.
//
// House-safe WITHOUT a family filter: the predicate requires a single same-address
// candidate with agreeing area (<=7%) + price (<=5%); the HOUSE branch of
// scripts/sold-match-run.js already auto-matches that case, so such a row can only be
// an apartment. Rooms are not in stored evidence → the rooms veto is skipped here
// (address+area+price already agree; acceptable per the design spec).
//
// DRY-RUN BY DEFAULT (read-only preview + count). Pass --apply to perform the write.
// Backfilled rows keep matched_hemnet_slug=NULL (uncertain rows never stored the slug)
// — fine for the count; no clickable Hemnet link on those historical rows.
//
//   node migrate-sold-backfill-single-candidate.js            # dry-run preview
//   node migrate-sold-backfill-single-candidate.js --apply    # transactional write
//   node migrate-sold-backfill-single-candidate.js --smoke     # offline predicate self-test

const { createClient } = require('./db');
const { AREA_AGREE_PCT, PRICE_AGREE_PCT, FEE_AGREE_PCT } = require('./lib/sold-config');

const CFG = { AREA_AGREE_PCT, PRICE_AGREE_PCT, FEE_AGREE_PCT };

// Idempotent by the `verdict='uncertain'` guard: a second run finds the flipped rows
// already 'matched' and updates zero of them.
const BACKFILL_UPDATE_SQL =
  `UPDATE sold_match
      SET verdict = 'matched',
          match_method = 'single_candidate_confirmed_backfill',
          adjudicated_at = NOW()
    WHERE booli_id = ANY($1) AND verdict = 'uncertain'`;

// qualifiesForBackfill — the single-candidate predicate over stored evidence.
// Mirrors the live tier (scripts/sold-match-run.js) minus the rooms veto (rooms are
// not stored in evidence). Returns true iff: exactly one address candidate, address
// matched, area+price within tolerance, and NOT (fee present on both AND gap > tol).
function qualifiesForBackfill(evidence, cfg) {
  const ev = typeof evidence === 'string' ? safeParse(evidence) : evidence;
  if (!ev) return false;
  const d = ev.deltas || {};
  const fee = ev.fee || {};
  const single = Number(ev.addr_candidates) === 1;
  const addrOk = d.address_match === true;
  const areaOk = d.area_pct_diff != null && d.area_pct_diff <= cfg.AREA_AGREE_PCT;
  const priceOk = d.price_pct_diff != null && d.price_pct_diff <= cfg.PRICE_AGREE_PCT;
  const br = fee.booli_rent, hf = fee.hemnet_fee;
  const feeContradicts = br != null && hf != null && Math.abs(hf - br) / br > cfg.FEE_AGREE_PCT;
  return single && addrOk && areaOk && priceOk && !feeContradicts;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

async function run({ apply }) {
  const client = createClient();
  await client.connect();
  try {
    const before = await client.query(
      `SELECT verdict, COUNT(*)::int AS n FROM sold_match GROUP BY verdict ORDER BY verdict`,
    );
    console.log('=== BEFORE (verdict counts) ===');
    console.table(before.rows, ['verdict', 'n']);

    const rows = (await client.query(
      `SELECT booli_id, evidence FROM sold_match WHERE verdict = 'uncertain'`,
    )).rows;

    const qualifying = rows.filter((r) => qualifiesForBackfill(r.evidence, CFG)).map((r) => r.booli_id);
    console.log(`uncertain rows scanned: ${rows.length}; qualifying (single-candidate, area+price agree, fee not contradicting): ${qualifying.length}`);
    console.log('NOTE: backfilled rows keep matched_hemnet_slug=NULL (no clickable Hemnet link on these historical rows).');

    if (!apply) {
      console.log('DRY RUN — no rows written. Re-run with --apply (after approval) to perform the flip.');
      return;
    }

    await client.query('BEGIN');
    const upd = await client.query(BACKFILL_UPDATE_SQL, [qualifying]);
    await client.query('COMMIT');
    console.log(`Committed. ${upd.rowCount} rows flipped uncertain -> matched (single_candidate_confirmed_backfill).`);

    const after = await client.query(
      `SELECT verdict, COUNT(*)::int AS n FROM sold_match GROUP BY verdict ORDER BY verdict`,
    );
    console.log('=== AFTER (verdict counts) ===');
    console.table(after.rows, ['verdict', 'n']);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

module.exports = { qualifiesForBackfill, BACKFILL_UPDATE_SQL };

if (require.main === module) {
  if (process.argv.includes('--smoke')) {
    runSmoke();
  } else {
    const apply = process.argv.includes('--apply');
    run({ apply })
      .then(() => process.exit(0))
      .catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
  }
}

function runSmoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  const cfg = CFG;
  const base = () => ({
    addr_candidates: 1,
    deltas: { address_match: true, area_pct_diff: 0.02, price_pct_diff: 0.01 },
    fee: { booli_rent: null, hemnet_fee: null },
  });

  check('qualifying: single candidate, agree, fee absent → true', () => {
    assert.strictEqual(qualifiesForBackfill(base(), cfg), true);
  });
  check('qualifying: fee present on both & within 5% → true', () => {
    const ev = base(); ev.fee = { booli_rent: 5000, hemnet_fee: 4900 }; // 2%
    assert.strictEqual(qualifiesForBackfill(ev, cfg), true);
  });
  check('reject: fee present on both & differs >5% → false', () => {
    const ev = base(); ev.fee = { booli_rent: 4000, hemnet_fee: 5000 }; // 25%
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: multi-candidate (addr_candidates=2) → false', () => {
    const ev = base(); ev.addr_candidates = 2;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: address_match not true → false', () => {
    const ev = base(); ev.deltas.address_match = null;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: area disagrees → false', () => {
    const ev = base(); ev.deltas.area_pct_diff = 0.3;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: price disagrees → false', () => {
    const ev = base(); ev.deltas.price_pct_diff = 0.2;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('reject: area_pct_diff missing (null) → false', () => {
    const ev = base(); ev.deltas.area_pct_diff = null;
    assert.strictEqual(qualifiesForBackfill(ev, cfg), false);
  });
  check('accepts a JSON string evidence (parses)', () => {
    assert.strictEqual(qualifiesForBackfill(JSON.stringify(base()), cfg), true);
  });
  check('null/garbage evidence → false, no throw', () => {
    assert.strictEqual(qualifiesForBackfill(null, cfg), false);
    assert.strictEqual(qualifiesForBackfill('not json', cfg), false);
  });
  check('idempotency: UPDATE SQL guards on verdict = uncertain', () => {
    assert.ok(/verdict\s*=\s*'uncertain'/.test(BACKFILL_UPDATE_SQL),
      'UPDATE must guard WHERE verdict = uncertain so a re-run is a no-op');
    assert.ok(/booli_id\s*=\s*ANY\(\$1\)/.test(BACKFILL_UPDATE_SQL),
      'UPDATE must target the qualifying booli_ids via ANY($1)');
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
