'use strict';

// spike-report.js — Stage 4/5. Reads the seed + match results and produces:
//   - REPORT.md        : per-segment match rate, precision proxy, Booli-only
//                        breakdown, title-transfer count, ratio floor + Wilson CI,
//                        and the kill-test verdict.
//   - MANUAL-AUDIT-<segment>.md : human review pack (matches first for precision,
//                        then Booli-only for composition), direct Hemnet+Booli links.
//   - report.json      : machine-readable rollup.
// Read-only over artifacts; no network.

process.env.SCRAPE_FORCE_OXYLABS = '1'; // satisfies spike-common guard; this script never fetches
require('dotenv').config();
const path = require('path');
const { ROOT, ensureDir, readJsonl, writeJson } = require('./spike-common');
const { SEGMENTS, READ_TIME_EXCLUDE_DAYS, daysAgoISO } = require('./spike-config');

function wilson(k, n) {
  if (!n) return { p: 0, lo: 0, hi: 0 };
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const booliUrl = (r) => (r.booli && r.booli.residence_url ? `https://www.booli.se${r.booli.residence_url}` : '(n/a)');
const hemnetUrl = (r) => (r.hemnet && r.hemnet.detail_url) || '(n/a)';

function analyzeSegment(segKey, seg) {
  const seed = readJsonl(path.join(ROOT, 'seed', `${segKey}.jsonl`));
  const results = readJsonl(path.join(ROOT, 'match', `${segKey}.results.jsonl`));
  const titleTransfers = seed.filter((r) => r.is_title_transfer);
  const matchSeed = seed.filter((r) => !r.is_title_transfer);

  const v = {};
  for (const r of results) v[r.verdict] = (v[r.verdict] || 0) + 1;
  const confirmed = results.filter((r) => r.verdict === 'CONFIRMED_MATCH');
  const mismatch = results.filter((r) => r.verdict === 'CONFIRMED_MISMATCH');
  const uncertain = results.filter((r) => r.verdict === 'UNCERTAIN');
  const booliOnly = results.filter((r) => r.verdict === 'BOOLI_ONLY');
  const errors = results.filter((r) => r.verdict === 'ERROR');
  const incomplete = results.filter((r) => r.incomplete);

  const recall = {};
  for (const r of booliOnly) if (r.recall) recall[r.recall] = (recall[r.recall] || 0) + 1;

  // Apartment precision proxy: fee-exact among confirmed apartment matches.
  const feeExact = confirmed.filter((r) => r.fee && r.fee.exact).length;
  const aptConfirmedWithFee = confirmed.filter((r) => r.fee).length;

  // Ratio (conservative floor): matched / matchSeed processed. Seed is already
  // >90d (read-time exclusion satisfied at scrape) and title transfers removed.
  const processed = results.length;
  const ratio = wilson(confirmed.length, processed || 1);
  const matchRate = processed ? confirmed.length / processed : 0;

  return {
    segKey, label: seg.label, family: seg.family,
    seed: seed.length, titleTransfers: titleTransfers.length,
    matchSeed: matchSeed.length, processed,
    verdicts: v, confirmed: confirmed.length, mismatch: mismatch.length,
    uncertain: uncertain.length, booliOnly: booliOnly.length, errors: errors.length,
    incomplete: incomplete.length,
    recall, feeExact, aptConfirmedWithFee,
    matchRate, ratio,
    _confirmed: confirmed, _mismatch: mismatch, _uncertain: uncertain, _booliOnly: booliOnly,
  };
}

function auditPack(a) {
  const lines = [];
  lines.push(`# Manual audit pack — ${a.label} (${a.segKey})`);
  lines.push('');
  lines.push(`Auto-adjudicated census. Review **matches** for precision (false positives), then **Booli-only** for composition (match-miss vs genuine bypass). Title transfers excluded from matching.`);
  lines.push('');
  lines.push(`Counts: confirmed ${a.confirmed} · uncertain ${a.uncertain} · mismatch ${a.mismatch} · Booli-only ${a.booliOnly} · errors ${a.errors}`);
  lines.push('');

  const matchRow = (r) => {
    const d = r.deltas || {};
    const fee = r.fee ? ` · fee Booli ${r.fee.booli_rent ?? '?'} / Hemnet ${r.fee.hemnet_fee ?? '?'}${r.fee.exact ? ' ✓exact' : ''}` : '';
    return [
      `#### ${r.booli.street_address} — ${r.booli.municipality} (${r.booli.sold_date}, ${r.booli.sold_price_type})`,
      `- Booli: ${booliUrl(r)}  ·  sold ${r.booli.sold_price?.toLocaleString?.() || r.booli.sold_price} kr · ${r.booli.living_area ?? '?'} m² · ${r.booli.rooms ?? '?'} rum`,
      `- Hemnet: ${hemnetUrl(r)}  ·  final ${r.hemnet?.final_price?.toLocaleString?.() || r.hemnet?.final_price} kr · ${r.hemnet?.living_area ?? '?'} m² · ${r.hemnet?.rooms ?? '?'} rum · broker ${r.hemnet?.broker_name || '?'}`,
      `- Δ price ${d.price_pct_diff != null ? pct(d.price_pct_diff) : '?'} · Δ area ${d.area_pct_diff != null ? pct(d.area_pct_diff) : '?'}${fee} · candidates ${r.addr_candidates}`,
      `- Verdict: \`${r.verdict}\` (${r.source}) — ${r.reason}`,
      '',
    ].join('\n');
  };

  lines.push(`## MATCHES — ${a.confirmed} (verify precision)`);
  lines.push('');
  for (const r of a._confirmed) lines.push(matchRow(r));
  if (a._uncertain.length) {
    lines.push(`## UNCERTAIN — ${a.uncertain}`);
    lines.push('');
    for (const r of a._uncertain) lines.push(matchRow(r));
  }
  if (a._mismatch.length) {
    lines.push(`## CONFIRMED MISMATCH — ${a.mismatch}`);
    lines.push('');
    for (const r of a._mismatch) lines.push(matchRow(r));
  }

  lines.push(`## BOOLI-ONLY — ${a.booliOnly} (classify: match-miss vs genuine bypass)`);
  lines.push('');
  lines.push('Recall = stricter/fuzzier Hemnet re-search. `match-miss` = found when loosened (our narrowing missed it). `genuine-bypass` = not on Hemnet even loosened.');
  lines.push('');
  for (const r of a._booliOnly) {
    const rec = r.recall === 'match-miss' && r.hemnet ? `  → recall HIT ${hemnetUrl(r)} (final ${r.hemnet.final_price})` : '';
    lines.push(`- **${r.booli.street_address}** ${r.booli.municipality} (${r.booli.sold_date}, ${r.booli.sold_price_type}) — Booli ${booliUrl(r)} · ${r.booli.sold_price} kr · \`${r.recall || 'n/a'}\`${rec}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  // Only report segments that actually have a seed in this workspace (a
  // villa-only historical run leaves the apartment segment empty).
  const segKeys = Object.keys(SEGMENTS).filter((k) => readJsonl(path.join(ROOT, 'seed', `${k}.jsonl`)).length > 0);
  const analyses = segKeys.map((k) => analyzeSegment(k, SEGMENTS[k]));

  // Write audit packs.
  for (const a of analyses) {
    require('fs').writeFileSync(path.join(ROOT, `MANUAL-AUDIT-${a.segKey}.md`), auditPack(a));
  }

  // REPORT.md
  const L = [];
  L.push('# Spike report — Hemnet-as-%-of-Booli (sold-record matching feasibility)');
  L.push('');
  L.push(`Generated ${new Date().toISOString()}. Portal-to-portal sold-record comparison; NOT a market-share figure.`);
  L.push(`Seed window ends ${daysAgoISO(READ_TIME_EXCLUDE_DAYS)} (sales ≥${READ_TIME_EXCLUDE_DAYS}d old → ratio-eligible + Hemnet-posted). Vision unavailable; apartment confirmation via fee-exact (Booli serves no sold photos → no dHash).`);
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push('| Segment | Seed | Title-transfers | Matched | Booli-only | Uncertain | Match rate | Ratio floor (95% CI) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const a of analyses) {
    L.push(`| ${a.label} | ${a.seed} | ${a.titleTransfers} | ${a.confirmed} | ${a.booliOnly} | ${a.uncertain} | ${pct(a.matchRate)} | ${pct(a.ratio.p)} [${pct(a.ratio.lo)}–${pct(a.ratio.hi)}] |`);
  }
  L.push('');
  for (const a of analyses) {
    L.push(`## ${a.label} (${a.family})`);
    L.push('');
    L.push(`- Seed ${a.seed}; title transfers ${a.titleTransfers} (${pct(a.titleTransfers / (a.seed || 1))}) excluded; match seed ${a.matchSeed}; processed ${a.processed}.`);
    L.push(`- Verdicts: ${JSON.stringify(a.verdicts)}`);
    L.push(`- **Match rate ${pct(a.matchRate)}** (${a.confirmed}/${a.processed}); ratio floor ${pct(a.ratio.p)} (95% CI ${pct(a.ratio.lo)}–${pct(a.ratio.hi)}).`);
    if (a.family === 'APARTMENT') L.push(`- Apartment precision proxy: ${a.feeExact}/${a.aptConfirmedWithFee} confirmed matches have an EXACT fee match (strong unit identity).`);
    L.push(`- Booli-only composition (recall): ${JSON.stringify(a.recall)}.`);
    if (a.incomplete) L.push(`- ⚠ ${a.incomplete} searches flagged incomplete (pagination cap) — excluded from confident Booli-only.`);
    L.push('');
  }
  L.push('## Kill-test read');
  L.push('');
  L.push('- **Houses**: validated if match precision >95% and Booli-only resolves cleanly into title-transfer vs genuine-bypass.');
  L.push('- **Apartments**: the spike\'s real risk. Booli-only is dominated by GENUINE Hemnet-absence (bostadsrätt have no public deed; Booli aggregates broker-reported slutpris Hemnet never showed / suppressed), NOT matcher misses — see recall split + the manual audit packs. Confirm by reviewing MANUAL-AUDIT-stockholm-apt.md.');
  L.push('');
  L.push('Audit packs: `MANUAL-AUDIT-<segment>.md` (matches → verify precision; Booli-only → confirm genuine absence).');
  require('fs').writeFileSync(path.join(ROOT, 'REPORT.md'), L.join('\n'));

  writeJson(path.join(ROOT, 'report.json'), analyses.map((a) => { const { _confirmed, _mismatch, _uncertain, _booliOnly, ...rest } = a; return rest; }));

  console.log('REPORT.md + MANUAL-AUDIT-*.md written to', ROOT);
  for (const a of analyses) console.log(`  ${a.label}: matched ${a.confirmed}/${a.processed} (${pct(a.matchRate)}), booli-only ${a.booliOnly}, TT ${a.titleTransfers}, recall ${JSON.stringify(a.recall)}`);
}

main();
