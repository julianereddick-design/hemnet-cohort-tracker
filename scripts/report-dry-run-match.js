#!/usr/bin/env node
// Pure log parser for hemnet-targeted-match.js --dry-run output.
// Reads a tee'd dry-run log on argv[2] and writes a Markdown verification
// report to stdout, grouped by outcome bucket with clickable Booli + Hemnet
// URLs so a human can spot-check matches and audit each miss category.
// No DB, no network.

const fs = require('fs');

const PREFIX = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[(INFO|WARN|ERROR)\] [^:]+: /;

function strip(line) {
  return line.replace(PREFIX, '');
}

function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const rows = new Map(); // booli_id -> row state
  const counts = { matchLines: 0, pcMismatchLines: 0, unmatchedEmptyLines: 0, unmatchedNoCardLines: 0 };
  let final = null;
  let lastBooliForCont = null;

  function ensure(booliId) {
    if (!rows.has(booliId)) {
      rows.set(booliId, { booliId, outcome: null });
    }
    return rows.get(booliId);
  }

  for (const raw of lines) {
    const line = strip(raw);

    // Continuation line of the `match` log entry — second line starts with `   -> hemnet_id=...`.
    if (line.startsWith('   -> hemnet_id=') && lastBooliForCont != null) {
      const m = /hemnet_id=(\d+) published=(\S+) postCode=(.+?) (https:\S+)$/.exec(line);
      if (m) {
        const r = ensure(lastBooliForCont);
        r.hemnetId = m[1];
        r.hemnetPublished = m[2];
        r.postcodeMarker = m[3];
        r.hemnetUrl = m[4];
      }
      lastBooliForCont = null;
      continue;
    }
    lastBooliForCont = null;

    let m;
    if ((m = /^narrowed search hit (\d+) cards booli_id=(\d+) muni="([^"]*)" filters=\[([^\]]*)\] url=(\S+)/.exec(line))) {
      const r = ensure(m[2]);
      r.cardsSeen = parseInt(m[1], 10);
      r.muni = m[3];
      r.filters = m[4];
      r.searchUrl = m[5];
    } else if ((m = /^match booli_id=(\d+) "([^"]*)" listed=(\S+) postcode=(\S+) (https:\S+)$/.exec(line))) {
      counts.matchLines++;
      const r = ensure(m[1]);
      // Don't downgrade an existing match outcome via duplicate row's later state
      if (r.outcome !== 'match') r.outcome = 'match';
      r.title = m[2];
      r.listed = m[3];
      r.booliPostcode = m[4];
      r.booliUrl = m[5];
      lastBooliForCont = m[1];
    } else if ((m = /^unmatched-narrowed-empty booli_id=(\d+) street="([^"]*)" muni="([^"]*)" cardsSeen=(\d+) filters=\[([^\]]*)\]/.exec(line))) {
      counts.unmatchedEmptyLines++;
      const r = ensure(m[1]);
      if (r.outcome !== 'match') r.outcome = 'unmatched-empty';
      r.title = m[2];
      r.muni = m[3];
      r.cardsSeen = parseInt(m[4], 10);
      r.filters = m[5];
      r.booliUrl = `https://www.booli.se/bostad/${m[1]}`;
    } else if ((m = /^unmatched-narrowed-no-card-match booli_id=(\d+) street="([^"]*)" muni="([^"]*)" cardsSeen=(\d+) filters=\[([^\]]*)\]/.exec(line))) {
      counts.unmatchedNoCardLines++;
      const r = ensure(m[1]);
      if (r.outcome !== 'match') r.outcome = 'unmatched-no-card-match';
      r.title = m[2];
      r.muni = m[3];
      r.cardsSeen = parseInt(m[4], 10);
      r.filters = m[5];
      r.booliUrl = `https://www.booli.se/bostad/${m[1]}`;
    } else if ((m = /^postcode-mismatch booli_id=(\d+) booli=(\S+) hemnet=(\S+) hemnet_id=(\d+)/.exec(line))) {
      counts.pcMismatchLines++;
      const r = ensure(m[1]);
      if (r.outcome !== 'match') r.outcome = 'postcode-mismatch';
      r.booliPostcode = m[2];
      r.hemnetPostcode = m[3];
      r.hemnetId = m[4];
      r.booliUrl = `https://www.booli.se/bostad/${m[1]}`;
      r.hemnetUrl = `https://www.hemnet.se/bostad/${m[4]}`;
    } else if ((m = /^Final: (\{.*\})$/.exec(line))) {
      try { final = JSON.parse(m[1]); } catch (_) { /* ignore */ }
    }
  }

  return { rows: [...rows.values()], final, counts };
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'n/a'; }

function emit({ rows, final, counts }) {
  const total = (final && final.booliCount) || rows.length;
  const matches = rows.filter((r) => r.outcome === 'match');
  const empties = rows.filter((r) => r.outcome === 'unmatched-empty');
  const noCard = rows.filter((r) => r.outcome === 'unmatched-no-card-match');
  const pcMismatch = rows.filter((r) => r.outcome === 'postcode-mismatch');

  const out = [];
  out.push(`# Job B dry-run match verification\n`);
  if (final) {
    out.push(`- **Cohort week:** ${final.cohortId}  (${final.weekStart} → ${final.weekEnd})`);
    out.push(`- **Booli rows processed:** ${total}${final.limited ? ` (--limit ${final.limited})` : ''}`);
    out.push(`- **Match rate (matchedFromSearch / booliCount, official):** ${final.matchedFromSearch}/${total} = **${pct(final.matchedFromSearch, total)}**`);
    out.push(`  - Of those, ${final.matchedFromSearch - final.postcodeMismatch} passed the postcode-mismatch gate (${final.postcodeMismatch} rejected)`);
    out.push(`- **Unique properties matched (deduped by booli_id):** ${matches.length}`);
    out.push(`- **Postcode mismatches:** ${final.postcodeMismatch} log lines / ${pcMismatch.length} unique booli_id`);
    out.push(`- **Fetch errors:** ${final.fetchErrors}  | **Parse errors:** ${final.parseErrors}  | **Null-title skipped:** ${final.nullTitleSkipped || 0}`);
    out.push(`- **Duration:** ${(final.durationMs / 1000).toFixed(1)}s\n`);
    if (counts && counts.matchLines > matches.length) {
      out.push(`> Note: ${counts.matchLines} match log lines were emitted for ${matches.length} unique booli_ids — some booli_ids have duplicate rows in booli_listing (Job D is "duplicate-row tolerant" by design). Dedup-by-booli_id below is the right unit for human verification.\n`);
    }
  }

  out.push(`## Matches (${matches.length} of ${total}, ${pct(matches.length, total)})`);
  out.push(`| # | Booli | Hemnet | Postcode | Open both | ✓ |`);
  out.push(`|---|-------|--------|----------|-----------|---|`);
  matches.forEach((r, i) => {
    const booliLabel = (r.title || `booli_id ${r.booliId}`).replace(/\|/g, '\\|');
    out.push(`| ${i + 1} | [${booliLabel}](${r.booliUrl}) | [hemnet ${r.hemnetId}](${r.hemnetUrl}) | ${r.postcodeMarker || ''} | [B](${r.booliUrl}) / [H](${r.hemnetUrl}) | ☐ |`);
  });
  out.push('');

  out.push(`## Unmatched — Hemnet returned 0 cards (${empties.length}, ${pct(empties.length, total)})`);
  out.push(`Open the **Search URL** to verify Hemnet really has nothing matching that price/rooms/item_type combo.`);
  out.push(`| Booli | Muni | Filters | Search URL |`);
  out.push(`|-------|------|---------|------------|`);
  empties.forEach((r) => {
    const booliLabel = (r.title || `booli_id ${r.booliId}`).replace(/\|/g, '\\|');
    out.push(`| [${booliLabel}](${r.booliUrl}) | ${r.muni || ''} | ${r.filters || ''} | [search](${r.searchUrl || ''}) |`);
  });
  out.push('');

  out.push(`## Unmatched — cards returned but no street/date match (${noCard.length}, ${pct(noCard.length, total)})`);
  out.push(`Open the **Search URL**; if any card looks like the same property, the cardMatches predicate is rejecting valid matches.`);
  out.push(`| Booli | Muni | Cards seen | Filters | Search URL |`);
  out.push(`|-------|------|-----------:|---------|------------|`);
  noCard.forEach((r) => {
    const booliLabel = (r.title || `booli_id ${r.booliId}`).replace(/\|/g, '\\|');
    out.push(`| [${booliLabel}](${r.booliUrl}) | ${r.muni || ''} | ${r.cardsSeen} | ${r.filters || ''} | [search](${r.searchUrl || ''}) |`);
  });
  out.push('');

  out.push(`## Postcode mismatches (${pcMismatch.length}, ${pct(pcMismatch.length, total)})`);
  out.push(`| Booli | Booli postcode | Hemnet postcode | Hemnet |`);
  out.push(`|-------|----------------|-----------------|--------|`);
  pcMismatch.forEach((r) => {
    out.push(`| [booli ${r.booliId}](${r.booliUrl}) | ${r.booliPostcode} | ${r.hemnetPostcode} | [hemnet ${r.hemnetId}](${r.hemnetUrl}) |`);
  });
  out.push('');

  if (final && final.perCounty) {
    out.push(`## perCounty`);
    out.push(`| County | Booli rows | Matched | Inserted | Errors |`);
    out.push(`|--------|-----------:|--------:|---------:|-------:|`);
    Object.entries(final.perCounty).forEach(([k, v]) => {
      out.push(`| ${k} | ${v.booli || 0} | ${v.matched || 0} | ${v.inserted || 0} | ${v.errors || 0} |`);
    });
    out.push('');
  }

  if (final && final.perMuni) {
    out.push(`## perMuni (top 25 by booli rows)`);
    const entries = Object.entries(final.perMuni)
      .map(([k, v]) => ({ muni: k, ...v }))
      .sort((a, b) => (b.booli || 0) - (a.booli || 0))
      .slice(0, 25);
    out.push(`| Muni | Booli rows | Matched | Inserted | Pages exhausted |`);
    out.push(`|------|-----------:|--------:|---------:|:---------------:|`);
    entries.forEach((e) => {
      out.push(`| ${e.muni} | ${e.booli || 0} | ${e.matched || 0} | ${e.inserted || 0} | ${e.paginationExhausted ? '⚠' : ''} |`);
    });
    out.push('');
  }

  return out.join('\n');
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/report-dry-run-match.js <log-file>');
    process.exit(1);
  }
  const text = fs.readFileSync(path, 'utf8');
  process.stdout.write(emit(parseLog(text)));
}

if (require.main === module) main();

module.exports = { parseLog, emit };
