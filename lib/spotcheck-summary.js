// lib/spotcheck-summary.js
//
// Pure summary/CI module for the cohort-match spot-check weekly QA gate.
// No DB, no network — deterministic transforms over post-adjudication records.
//
// Exports:
//   wilson95(successes, n)           — 95% Wilson score CI [lo, hi]
//   computeSummary(pairs)            — rate + CI + byCounty + mismatches
//   renderSlackAlert(summary, cohortId) — plain-text escalation string
//   renderSummaryMd(summary, cohortId)  — markdown artifact
//
// Usage:
//   const { wilson95, computeSummary, renderSlackAlert, renderSummaryMd }
//     = require('./lib/spotcheck-summary');
//   node lib/spotcheck-summary.js --smoke

'use strict';

// ---------------------------------------------------------------
// wilson95 — 95% Wilson score interval for a binomial proportion.
// Copied verbatim from cohort-spotcheck.js lines 108-117.
// NOT re-imported from that file (it is not exported there).
// ---------------------------------------------------------------
function wilson95(successes, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

// ---------------------------------------------------------------
// computeSummary(pairs)
//
//   pairs — array of post-adjudication records (each with .verdict).
//           Each record: { pair_id, county, booli_url, hemnet_url,
//                          verdict, verdict_reason, deltas }
//
// Returns:
//   {
//     sampled,              // pairs.length
//     confirmedMatch,       // count of CONFIRMED_MATCH
//     confirmedMismatch,    // count of CONFIRMED_MISMATCH
//     uncertain,            // count of UNCERTAIN
//     confirmedMismatchRate,// confirmedMismatch / (confirmedMatch+confirmedMismatch), 0 if denom=0
//     wilsonLo,             // 95% Wilson CI lower bound
//     wilsonHi,             // 95% Wilson CI upper bound
//     byCounty,             // { [county]: { sampled, confirmedMatch, confirmedMismatch, uncertain, rate } }
//     mismatches,           // [{ pair_id, county, booli_url, hemnet_url, why }] for CONFIRMED_MISMATCH
//   }
// ---------------------------------------------------------------
function computeSummary(pairs) {
  const arr = pairs || [];

  let confirmedMatch = 0;
  let confirmedMismatch = 0;
  let uncertain = 0;
  const byCounty = {};
  const mismatches = [];

  for (const record of arr) {
    const v = record.verdict;
    const county = record.county || 'Unknown';

    // ensure county bucket
    if (!byCounty[county]) {
      byCounty[county] = { sampled: 0, confirmedMatch: 0, confirmedMismatch: 0, uncertain: 0, rate: 0 };
    }
    byCounty[county].sampled++;

    if (v === 'CONFIRMED_MATCH') {
      confirmedMatch++;
      byCounty[county].confirmedMatch++;
    } else if (v === 'CONFIRMED_MISMATCH') {
      confirmedMismatch++;
      byCounty[county].confirmedMismatch++;

      // Build the "why" string from verdict_reason + diverging deltas
      const d = record.deltas || {};
      const deltaParts = [];
      if (d.area_pct_diff != null) {
        deltaParts.push(`area Δ ${(d.area_pct_diff * 100).toFixed(0)}%`);
      }
      if (d.price_pct_diff != null) {
        deltaParts.push(`price Δ ${(d.price_pct_diff * 100).toFixed(0)}%`);
      }
      const deltaStr = deltaParts.length > 0 ? ` · ${deltaParts.join(' · ')}` : '';
      const reason = record.verdict_reason || 'mismatch';
      mismatches.push({
        pair_id: record.pair_id,
        county,
        booli_url: record.booli_url || null,
        hemnet_url: record.hemnet_url || null,
        why: `${reason}${deltaStr}`,
      });
    } else {
      // UNCERTAIN or any unrecognised verdict
      uncertain++;
      byCounty[county].uncertain++;
    }
  }

  // Compute per-county false-match rate (adjudicated denominator)
  for (const county of Object.keys(byCounty)) {
    const c = byCounty[county];
    const adjudicated = c.confirmedMatch + c.confirmedMismatch;
    c.rate = adjudicated > 0 ? c.confirmedMismatch / adjudicated : 0;
  }

  const adjudicated = confirmedMatch + confirmedMismatch;
  const confirmedMismatchRate = adjudicated > 0 ? confirmedMismatch / adjudicated : 0;
  const [wilsonLo, wilsonHi] = wilson95(confirmedMismatch, adjudicated);

  return {
    sampled: arr.length,
    confirmedMatch,
    confirmedMismatch,
    uncertain,
    confirmedMismatchRate,
    wilsonLo,
    wilsonHi,
    byCounty,
    mismatches,
  };
}

// ---------------------------------------------------------------
// renderSlackAlert(summary, cohortId)
//
// Returns a plain-text string (NOT a Slack Block-Kit payload).
// The cron-wrapper wraps it as:
//   [WARNING] cohort-spotcheck-gate: <this string>
// and sends it via its existing { text } Slack webhook path.
// ---------------------------------------------------------------
function renderSlackAlert(summary, cohortId) {
  const { confirmedMismatchRate, confirmedMismatch, confirmedMatch, wilsonLo, wilsonHi, mismatches } = summary;
  const adjudicated = confirmedMatch + confirmedMismatch;
  return (
    `confirmed false-match rate ${(confirmedMismatchRate * 100).toFixed(1)}%` +
    ` (n=${adjudicated}, 95% CI ${(wilsonLo * 100).toFixed(1)}-${(wilsonHi * 100).toFixed(1)}%)` +
    ` for cohort ${cohortId} — ${mismatches.length} mismatch(es)`
  );
}

// ---------------------------------------------------------------
// renderSummaryMd(summary, cohortId)
//
// Returns a markdown document with:
//   - Summary block (rate + Wilson CI + counts)
//   - By-county table
//   - Mismatches section
// ---------------------------------------------------------------
function renderSummaryMd(summary, cohortId) {
  const {
    sampled,
    confirmedMatch,
    confirmedMismatch,
    uncertain,
    confirmedMismatchRate,
    wilsonLo,
    wilsonHi,
    byCounty,
    mismatches,
  } = summary;
  const adjudicated = confirmedMatch + confirmedMismatch;

  const lines = [];

  lines.push(`# Spot-check gate summary — ${cohortId}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Cohort | ${cohortId} |`);
  lines.push(`| Sampled pairs | ${sampled} |`);
  lines.push(`| Adjudicated (match+mismatch) | ${adjudicated} |`);
  lines.push(`| CONFIRMED_MATCH | ${confirmedMatch} |`);
  lines.push(`| CONFIRMED_MISMATCH | ${confirmedMismatch} |`);
  lines.push(`| UNCERTAIN | ${uncertain} |`);
  lines.push(`| Confirmed false-match rate | ${(confirmedMismatchRate * 100).toFixed(2)}% |`);
  lines.push(`| 95% Wilson CI | ${(wilsonLo * 100).toFixed(1)}% – ${(wilsonHi * 100).toFixed(1)}% |`);
  lines.push('');

  // By county table
  lines.push('## By county');
  lines.push('');
  lines.push(`| County | Sampled | Match | Mismatch | Uncertain | Rate |`);
  lines.push(`|--------|---------|-------|----------|-----------|------|`);
  for (const county of Object.keys(byCounty).sort()) {
    const c = byCounty[county];
    lines.push(
      `| ${county} | ${c.sampled} | ${c.confirmedMatch} | ${c.confirmedMismatch} | ${c.uncertain} | ${(c.rate * 100).toFixed(1)}% |`
    );
  }
  lines.push('');

  // Mismatches section
  lines.push('## Mismatches');
  lines.push('');
  if (mismatches.length === 0) {
    lines.push('None.');
  } else {
    for (const m of mismatches) {
      lines.push(`### pair_id ${m.pair_id} (${m.county})`);
      lines.push('');
      lines.push(`- **Booli:** ${m.booli_url || '—'}`);
      lines.push(`- **Hemnet:** ${m.hemnet_url || '—'}`);
      lines.push(`- **Why:** ${m.why}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { wilson95, computeSummary, renderSlackAlert, renderSummaryMd };

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/spotcheck-summary.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // --- wilson95 ---
  check('wilson95 n=0 → [0,0]', () => {
    const [lo, hi] = wilson95(0, 0);
    assert.strictEqual(lo, 0);
    assert.strictEqual(hi, 0);
  });

  check('wilson95(0, 112) → lo=0', () => {
    const [lo, hi] = wilson95(0, 112);
    assert.strictEqual(lo, 0);
    assert.ok(hi > 0, 'hi should be > 0');
    assert.ok(hi < 0.05, `hi should be < 0.05, got ${hi}`);
  });

  check('wilson95(2, 112) ≈ [0.005, 0.063]', () => {
    const [lo, hi] = wilson95(2, 112);
    assert.ok(lo >= 0.003 && lo <= 0.010, `lo ${lo} out of expected ~0.005 range`);
    assert.ok(hi >= 0.055 && hi <= 0.075, `hi ${hi} out of expected ~0.063 range`);
  });

  check('wilson95 bounds in [0,1]', () => {
    for (const [s, n] of [[0, 1], [1, 1], [5, 10], [100, 100], [0, 10]]) {
      const [lo, hi] = wilson95(s, n);
      assert.ok(lo >= 0 && lo <= 1, `lo out of [0,1]: ${lo}`);
      assert.ok(hi >= 0 && hi <= 1, `hi out of [0,1]: ${hi}`);
      assert.ok(lo <= hi, `lo > hi: ${lo} > ${hi}`);
    }
  });

  // --- computeSummary fixture ---
  // Build a small mixed-verdict fixture (mirrors cohort 2026-W23 proportions)
  const FIXTURE = [
    // 2 mismatches
    {
      pair_id: 16347, county: 'Stockholm',
      verdict: 'CONFIRMED_MISMATCH', verdict_reason: 'suspect triage + vision found no shared photo',
      deltas: { price_pct_diff: 0.16, area_pct_diff: 0.17 },
      booli_url: 'https://www.booli.se/annons/16347',
      hemnet_url: 'https://www.hemnet.se/bostad/16347',
    },
    {
      pair_id: 16999, county: 'Uppsala',
      verdict: 'CONFIRMED_MISMATCH', verdict_reason: 'suspect triage + vision found no shared photo',
      deltas: { price_pct_diff: 0.22, area_pct_diff: null },
      booli_url: 'https://www.booli.se/annons/16999',
      hemnet_url: 'https://www.hemnet.se/bostad/16999',
    },
    // 5 matches
    { pair_id: 15647, county: 'Stockholm', verdict: 'CONFIRMED_MATCH', verdict_reason: 'price agrees + likely-match + photos present (deterministic promote)', deltas: { price_pct_diff: 0.0, area_pct_diff: 0.15 }, booli_url: null, hemnet_url: null },
    { pair_id: 15648, county: 'Stockholm', verdict: 'CONFIRMED_MATCH', verdict_reason: 'price agrees + vision found shared photo', deltas: {}, booli_url: null, hemnet_url: null },
    { pair_id: 15649, county: 'Uppsala',   verdict: 'CONFIRMED_MATCH', verdict_reason: 'deterministic', deltas: {}, booli_url: null, hemnet_url: null },
    { pair_id: 15650, county: 'Skåne',     verdict: 'CONFIRMED_MATCH', verdict_reason: 'deterministic', deltas: {}, booli_url: null, hemnet_url: null },
    { pair_id: 15651, county: 'Skåne',     verdict: 'CONFIRMED_MATCH', verdict_reason: 'deterministic', deltas: {}, booli_url: null, hemnet_url: null },
    // 3 uncertain
    { pair_id: 10000, county: 'Stockholm', verdict: 'UNCERTAIN', verdict_reason: 'no-photos', deltas: {}, booli_url: null, hemnet_url: null },
    { pair_id: 10001, county: 'Skåne',     verdict: 'UNCERTAIN', verdict_reason: 'no-vision', deltas: {}, booli_url: null, hemnet_url: null },
    { pair_id: 10002, county: 'Uppsala',   verdict: 'UNCERTAIN', verdict_reason: 'no-vision', deltas: {}, booli_url: null, hemnet_url: null },
  ];

  let summary;
  check('computeSummary runs without error', () => {
    summary = computeSummary(FIXTURE);
  });

  check('computeSummary: sampled=10', () => {
    assert.strictEqual(summary.sampled, 10);
  });

  check('computeSummary: confirmedMatch=5', () => {
    assert.strictEqual(summary.confirmedMatch, 5);
  });

  check('computeSummary: confirmedMismatch=2', () => {
    assert.strictEqual(summary.confirmedMismatch, 2);
  });

  check('computeSummary: uncertain=3', () => {
    assert.strictEqual(summary.uncertain, 3);
  });

  check('computeSummary: confirmedMismatchRate=2/7 ≈ 0.286', () => {
    assert.ok(Math.abs(summary.confirmedMismatchRate - 2 / 7) < 1e-10,
      `rate=${summary.confirmedMismatchRate}, expected ${2 / 7}`);
  });

  check('computeSummary: Wilson CI bounds in [0,1] and lo<=hi', () => {
    assert.ok(summary.wilsonLo >= 0 && summary.wilsonLo <= 1);
    assert.ok(summary.wilsonHi >= 0 && summary.wilsonHi <= 1);
    assert.ok(summary.wilsonLo <= summary.wilsonHi);
  });

  check('computeSummary: mismatches.length=2', () => {
    assert.strictEqual(summary.mismatches.length, 2);
  });

  check('computeSummary: mismatches contain pair_id 16347', () => {
    const ids = summary.mismatches.map(m => m.pair_id);
    assert.ok(ids.includes(16347), `mismatches ${JSON.stringify(ids)} missing 16347`);
  });

  check('computeSummary: mismatch why includes delta info', () => {
    const m = summary.mismatches.find(m => m.pair_id === 16347);
    assert.ok(m.why.includes('price'), `why: ${m.why}`);
    assert.ok(m.why.includes('area'), `why: ${m.why}`);
  });

  check('computeSummary: byCounty has Stockholm, Uppsala, Skåne', () => {
    assert.ok('Stockholm' in summary.byCounty);
    assert.ok('Uppsala' in summary.byCounty);
    assert.ok('Skåne' in summary.byCounty);
  });

  check('computeSummary: Stockholm sampled=4', () => {
    assert.strictEqual(summary.byCounty.Stockholm.sampled, 4);
  });

  check('computeSummary: Stockholm confirmedMismatch=1, confirmedMatch=2', () => {
    assert.strictEqual(summary.byCounty.Stockholm.confirmedMismatch, 1);
    assert.strictEqual(summary.byCounty.Stockholm.confirmedMatch, 2);
  });

  check('computeSummary: Uppsala confirmedMismatch=1, confirmedMatch=1', () => {
    assert.strictEqual(summary.byCounty.Uppsala.confirmedMismatch, 1);
    assert.strictEqual(summary.byCounty.Uppsala.confirmedMatch, 1);
  });

  check('computeSummary: Skåne rate=0 (0 mismatches)', () => {
    assert.strictEqual(summary.byCounty.Skåne.confirmedMismatch, 0);
    assert.strictEqual(summary.byCounty.Skåne.rate, 0);
  });

  // Edge case: empty pairs
  check('computeSummary: empty array → zeroes, rate=0', () => {
    const s = computeSummary([]);
    assert.strictEqual(s.sampled, 0);
    assert.strictEqual(s.confirmedMismatchRate, 0);
    const [lo, hi] = [s.wilsonLo, s.wilsonHi];
    assert.strictEqual(lo, 0);
    assert.strictEqual(hi, 0);
    assert.strictEqual(s.mismatches.length, 0);
  });

  // --- renderSlackAlert ---
  check('renderSlackAlert returns string containing "false-match rate"', () => {
    const s = renderSlackAlert(summary, '2026-W23');
    assert.strictEqual(typeof s, 'string');
    assert.ok(s.includes('false-match rate'), `missing "false-match rate" in: ${s}`);
  });

  check('renderSlackAlert contains cohortId', () => {
    const s = renderSlackAlert(summary, '2026-W23');
    assert.ok(s.includes('2026-W23'), `missing cohortId in: ${s}`);
  });

  check('renderSlackAlert contains mismatch count', () => {
    const s = renderSlackAlert(summary, '2026-W23');
    assert.ok(s.includes('2 mismatch'), `missing mismatch count in: ${s}`);
  });

  check('renderSlackAlert contains CI', () => {
    const s = renderSlackAlert(summary, '2026-W23');
    assert.ok(s.includes('95% CI'), `missing CI in: ${s}`);
  });

  // --- renderSummaryMd ---
  let md;
  check('renderSummaryMd returns non-empty string', () => {
    md = renderSummaryMd(summary, '2026-W23');
    assert.strictEqual(typeof md, 'string');
    assert.ok(md.length > 0);
  });

  check('renderSummaryMd contains "By county"', () => {
    assert.ok(md.includes('By county'), `missing "By county" in md`);
  });

  check('renderSummaryMd contains each mismatch pair_id', () => {
    for (const m of summary.mismatches) {
      assert.ok(md.includes(String(m.pair_id)), `missing pair_id ${m.pair_id} in md`);
    }
  });

  check('renderSummaryMd contains cohortId', () => {
    assert.ok(md.includes('2026-W23'), `missing cohortId in md`);
  });

  check('renderSummaryMd contains county names', () => {
    assert.ok(md.includes('Stockholm'));
    assert.ok(md.includes('Uppsala'));
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
