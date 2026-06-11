#!/usr/bin/env node
// One-off (Phase 14.1): build a manual spot-check pack from a gate VERDICTS file
// so the operator can eyeball-verify the adjudicator's calls pair by pair.
// Pure transform — no fetches, no Slack, no DB.
//
// Usage: node scripts/make-manual-spotcheck.js [verdicts.json] [out.md]

const fs = require('fs');
const path = require('path');

const inFile = process.argv[2] || 'verf-probe14/VERDICTS-2026-W23.json';
const outFile = process.argv[3] || path.join(path.dirname(inFile), 'MANUAL-SPOTCHECK-2026-W23.md');

const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const pairs = data.pairs;

// Funnel groups in review-priority order. `take: 0` = include all.
// `mustInclude` pins specific pair_ids into the sample.
const GROUPS = [
  { source: 'conflict',              title: 'Fee conflict → human review (UNCERTAIN/conflict)',            take: 0 },
  { source: 'field-divergence',      title: 'MISMATCH (CONFIRMED_MISMATCH/field-divergence)',              take: 0 },
  { source: 'insufficient-evidence', title: 'Vision ran, unverified (UNCERTAIN/insufficient-evidence)',    take: 0 },
  { source: 'no-photos',             title: 'Both pages dead — delisted population (UNCERTAIN/no-photos)', take: 3, mustInclude: [16460] },
  { source: 'mode-b-vision',         title: 'Vision-confirmed (CONFIRMED_MATCH/mode-b-vision)',            take: 3 },
  { source: 'dhash',                 title: 'Photo-confirmed (CONFIRMED_MATCH/dhash)',                     take: 3 },
  { source: 'unit-fields',           title: 'Fee-confirmed (CONFIRMED_MATCH/unit-fields)',                 take: 3 },
];

// Deterministic spread: first / middle / last of the group (sorted by pair_id),
// after pinning any mustInclude ids.
function sample(group, take, mustInclude = []) {
  const sorted = [...group].sort((a, b) => a.pair_id - b.pair_id);
  if (!take || take >= sorted.length) return sorted;
  const picked = sorted.filter((p) => mustInclude.includes(p.pair_id));
  const rest = sorted.filter((p) => !mustInclude.includes(p.pair_id));
  while (picked.length < take && rest.length) {
    const idx = picked.length === 0 ? 0 : picked.length === 1 ? Math.floor(rest.length / 2) : rest.length - 1;
    picked.push(rest.splice(idx, 1)[0]);
  }
  return picked.sort((a, b) => a.pair_id - b.pair_id);
}

const fmt = (v, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);
// deltas.*_pct_diff are stored as fractions (0.25 = 25%) despite the name
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);

function dhashLine(p) {
  const d = p.dhash;
  if (!d || d.minDist === null || d.minDist === undefined) return 'not run (no comparable galleries)';
  return `minDist ${d.minDist} (threshold ${fmt(d.threshold)}) · shared scenes ${fmt(d.sharedCount)}/${fmt(d.needed)} → ${d.confirmed ? 'CONFIRMED' : 'not confirmed'}`;
}

function visionLine(p) {
  const v = p.vision;
  if (!v) return 'not run';
  const verdict = v.sharedPhoto === true ? 'shared photo' : v.sharedPhoto === false ? 'no shared photo' : 'inconclusive';
  let line = `${verdict} (confidence: ${fmt(v.confidence)})`;
  if (v.reasoning) line += `\n  - _${v.reasoning}_`;
  return line;
}

function renderPair(p) {
  const lines = [];
  lines.push(`#### Pair ${p.pair_id} — ${p.street_address}, ${p.municipality} (${p.county})`);
  lines.push('');
  lines.push(`- **Hemnet:** https://www.hemnet.se/bostad/${p.hemnet_id}`);
  lines.push(`- **Booli:** https://www.booli.se/annons/${p.booli_id}`);
  lines.push(`- **Fee:** Hemnet ${fmt(p.hemnet_unit && p.hemnet_unit.fee, ' kr')} / Booli ${fmt(p.booli_unit && p.booli_unit.rent, ' kr')}` +
    `${p.isMultiUnit ? ' · **multi-unit address**' : ''}`);
  lines.push(`- **Deltas:** price ${fmtPct(p.deltas && p.deltas.price_pct_diff)} · area ${fmtPct(p.deltas && p.deltas.area_pct_diff)}`);
  lines.push(`- **dHash:** ${dhashLine(p)}`);
  lines.push(`- **Vision:** ${visionLine(p)}`);
  lines.push(`- **Verdict:** \`${p.verdict}\` (${p.verdict_source}) — ${p.verdict_reason || '—'}`);
  if (p.verdict_challenge) lines.push(`- **Challenge:** ${p.verdict_challenge}`);
  if (p.photos && p.photos.notes && p.photos.notes.length) lines.push(`- **Fetch notes:** ${p.photos.notes.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

const bySource = {};
for (const p of pairs) (bySource[p.verdict_source] = bySource[p.verdict_source] || []).push(p);

const out = [];
out.push(`# Manual spot-check pack — cohort ${data.cohortId}`);
out.push('');
out.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`${path.basename(inFile)}\` (gate run ${data.generated_at}, ${pairs.length} pairs, adjudication mode: ${data.adjudicationMode}).`);
out.push('');
out.push('Sampled pairs from each funnel stage of the 2026-W23 live gate run. For each pair, open both links and check: same property? Does the verdict hold up? Funnel totals: ' +
  GROUPS.map((g) => `${g.source} ${bySource[g.source] ? bySource[g.source].length : 0}`).join(' · ') + '.');
out.push('');

for (const g of GROUPS) {
  const group = bySource[g.source] || [];
  const picked = sample(group, g.take, g.mustInclude);
  out.push(`## ${g.title} — ${picked.length} of ${group.length}`);
  out.push('');
  for (const p of picked) out.push(renderPair(p));
}

fs.writeFileSync(outFile, out.join('\n'));
console.log(`wrote ${outFile}`);
