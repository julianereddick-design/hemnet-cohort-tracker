process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/sold-match-manual-check.js — operator eyeball pack for verifying sold-match
// verdicts against Hemnet by hand. Read-only: queries sold_match + booli_sold and
// builds clickable URLs. NO Oxylabs calls, NO writes. (SCRAPE_FORCE_OXYLABS is set
// only because requiring lib/sold-fetch-hemnet → lib/sold-transport asserts it at load.)
//
// For each record it prints the Booli listing link and a narrowed Hemnet /salda search
// link (same filters the matcher used). Walk each booli_only row: if the SAME property
// shows up in the Hemnet sold list → MATCHER MISS (mark present); if genuinely absent →
// true non-Hemnet (mark absent). This is the spike's manual confirmation (25/25 for Täby),
// re-runnable per segment.
//
//   SCRAPE_FORCE_OXYLABS=1 node scripts/sold-match-run.js ...        # produce verdicts first
//   node scripts/sold-match-manual-check.js --segment kungalv-villa  # then this pack
//   node scripts/sold-match-manual-check.js --segment kungalv-villa --verdict booli_only
//   node scripts/sold-match-manual-check.js --smoke                  # offline self-test

const fs = require('fs');
const path = require('path');
const { createClient } = require('../db');
const { buildHemnetSoldUrl, searchOptsFor } = require('../lib/sold-fetch-hemnet');

const VERDICTS = ['booli_only', 'matched', 'uncertain'];

function loadSegments() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'sold-segments.json'), 'utf8'));
}

function parseArgs(argv) {
  const a = { verdict: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.indexOf('=');
    const take = (k) => (eq >= 0 ? t.slice(eq + 1) : argv[++i]);
    if (t === '--segment' || t.startsWith('--segment=')) a.segment = take('segment');
    else if (t === '--verdict' || t.startsWith('--verdict=')) a.verdict = take('verdict');
    else if (t === '--out' || t.startsWith('--out=')) a.out = take('out');
    else if (t === '--smoke') a.smoke = true;
  }
  return a;
}

function fmtKr(n) { return n != null ? `${Number(n).toLocaleString('sv-SE')} kr` : 'n/a'; }
function fmtDate(d) { return d ? String(d).slice(0, 10) : '?'; }

// Booli listing URL — residence_url is /bostad/<id> OR /annons/<id>; /annons/<booli_id>
// always resolves, so use it as the fallback.
function booliUrl(row) {
  return row.residence_url
    ? `https://www.booli.se${row.residence_url}`
    : `https://www.booli.se/annons/${row.booli_id}`;
}

// Render one record block. `seg` drives the narrowed Hemnet search URL.
function renderRow(row, seg) {
  const booli = {
    sold_price: row.sold_price, rooms: row.rooms, living_area: row.living_area,
    object_type: row.object_type, street_address: row.street_address,
  };
  const hemnetUrl = buildHemnetSoldUrl(booli, seg, searchOptsFor(seg));
  const lines = [];
  lines.push(`#### [ ] ${row.street_address || '(no address)'} — ${fmtKr(row.sold_price)} — sold ${fmtDate(row.sold_date)}`);
  lines.push(`- ${row.living_area != null ? row.living_area + ' m²' : 'area ?'} · ${row.rooms != null ? row.rooms + ' rok' : 'rooms ?'} · ${row.object_type || ''}${row.descriptive_area ? ' · ' + row.descriptive_area : ''}`);
  lines.push(`- **Booli:** ${booliUrl(row)}`);
  lines.push(`- **Hemnet /salda search:** ${hemnetUrl}`);
  const ev = [];
  if (row.src) ev.push(`source=${row.src}`);
  if (row.match_method) ev.push(`method=${row.match_method}`);
  if (row.matched_hemnet_slug) ev.push(`slug=${row.matched_hemnet_slug}`);
  if (row.hemnet_fee) ev.push(`hemnet_fee=${row.hemnet_fee}`);
  if (ev.length) lines.push(`- verdict=${row.verdict} (${ev.join(', ')})`);
  lines.push('- result: **[ ] absent (true non-Hemnet)**   **[ ] present (matcher miss)**   notes: ____');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const segments = loadSegments();
  if (!args.segment || !segments[args.segment]) {
    throw new Error(`--segment required and must be one of: ${Object.keys(segments).join(', ')}`);
  }
  const seg = segments[args.segment];
  const want = args.verdict === 'all' ? VERDICTS : [args.verdict];
  for (const v of want) {
    if (!VERDICTS.includes(v)) throw new Error(`--verdict must be one of: ${VERDICTS.join(', ')}, all`);
  }

  const client = createClient();
  await client.connect();
  let out;
  try {
    const counts = await client.query(
      'select verdict, count(*)::int n from sold_match where segment=$1 group by verdict order by verdict',
      [args.segment],
    );
    const rows = await client.query(
      `select m.booli_id, m.verdict, m.match_method, m.matched_hemnet_slug,
              b.street_address, b.sold_price, b.sold_date, b.living_area, b.rooms,
              b.object_type, b.residence_url, b.descriptive_area,
              m.evidence->>'source' src, m.evidence->'fee'->>'hemnet_fee' hemnet_fee
         from sold_match m join booli_sold b on b.booli_id = m.booli_id
        where m.segment = $1 and m.verdict = ANY($2::text[])
        order by m.verdict, b.sold_date desc nulls last`,
      [args.segment, want],
    );

    const L = [];
    L.push(`# Manual check — ${seg.label} (${args.segment})`);
    L.push('');
    L.push('Verdict counts (full segment):');
    for (const c of counts.rows) L.push(`- ${c.verdict}: ${c.n}`);
    L.push('');
    L.push('**How to use:** for each row, open the Booli link to see the property, then the Hemnet');
    L.push('search link (narrowed to its area/price/rooms). If the SAME property appears in Hemnet\'s');
    L.push('sold list → it\'s a **matcher miss** (mark *present*). If it\'s genuinely not there → **true');
    L.push('non-Hemnet** (mark *absent*). `booli_only` is the group that drives the non-Hemnet thesis;');
    L.push('`matched`/`uncertain` are included for a sanity spot-check of the matcher.');
    L.push('');

    const byVerdict = {};
    for (const r of rows.rows) (byVerdict[r.verdict] = byVerdict[r.verdict] || []).push(r);
    for (const v of want) {
      const group = byVerdict[v] || [];
      L.push(`## ${v} — ${group.length} record(s)`);
      L.push('');
      if (!group.length) { L.push('_(none)_', ''); continue; }
      for (const r of group) { L.push(renderRow(r, seg)); L.push(''); }
    }

    const outDir = path.join(__dirname, '..', 'verf-soldmatch-manual');
    fs.mkdirSync(outDir, { recursive: true });
    out = args.out || path.join(outDir, `${args.segment}-${args.verdict}.md`);
    fs.writeFileSync(out, L.join('\n') + '\n', 'utf8');
  } finally {
    await client.end();
  }
  console.log(`wrote ${out}`);
}

// ---------------------------------------------------------------------------
function runSmoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  check('parseArgs honors --segment/--verdict (both forms)', () => {
    assert.strictEqual(parseArgs(['--segment', 'kungalv-villa']).segment, 'kungalv-villa');
    assert.strictEqual(parseArgs(['--verdict=booli_only']).verdict, 'booli_only');
  });
  check('booliUrl uses residence_url, falls back to /annons/<booli_id>', () => {
    assert.strictEqual(booliUrl({ residence_url: '/bostad/9', booli_id: 1 }), 'https://www.booli.se/bostad/9');
    assert.strictEqual(booliUrl({ residence_url: '/annons/7', booli_id: 1 }), 'https://www.booli.se/annons/7');
    assert.strictEqual(booliUrl({ residence_url: null, booli_id: 42 }), 'https://www.booli.se/annons/42');
  });
  check('renderRow emits Booli + Hemnet links and a checkbox', () => {
    const seg = { label: 'X', family: 'HOUSE', hemnet: { locationId: 17973, itemType: null } };
    const md = renderRow({
      booli_id: 5, street_address: 'Testgatan 1', sold_price: 5000000, sold_date: '2026-03-01',
      living_area: 100, rooms: 5, object_type: 'Villa', residence_url: '/annons/5', verdict: 'booli_only',
    }, seg);
    assert.ok(/booli\.se\/annons\/5/.test(md), 'has Booli link');
    assert.ok(/hemnet\.se\/salda\?/.test(md), 'has Hemnet search link');
    assert.ok(/\[ \] absent/.test(md), 'has absent checkbox');
  });
  check('fmtKr formats and null-safes', () => {
    assert.strictEqual(fmtKr(null), 'n/a');
    assert.ok(/kr$/.test(fmtKr(1234567)));
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

module.exports = { parseArgs, booliUrl, renderRow, fmtKr, loadSegments };

if (require.main === module) {
  if (process.argv.includes('--smoke')) runSmoke();
  else main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
