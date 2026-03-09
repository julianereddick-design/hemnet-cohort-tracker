# Deploy Instructions for Hemnet Cohort Tracker

Paste these commands into the DigitalOcean Console one section at a time.

## 1. Delete dead scripts on Droplet

```bash
rm /opt/hemnet-cohort-tracker/cohort-report.js
rm /opt/hemnet-cohort-tracker/cohort-views-report.js
rm /opt/hemnet-cohort-tracker/cohort-summary.js
rm /opt/hemnet-cohort-tracker/cohort-backfill.js
rm /opt/hemnet-cohort-tracker/migrate-simplify-schema.js
```

## 2. Deploy updated files

Paste each block below to overwrite the file on the Droplet.

### cohort-track.js

```bash
cat > /opt/hemnet-cohort-tracker/cohort-track.js << 'ENDOFFILE'
const { runJob } = require('./cron-wrapper');

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

async function main(client, log) {
  const today = new Date().toISOString().slice(0, 10);

  const cohorts = await client.query(`
    SELECT cohort_id, week_start FROM cohorts
    WHERE week_start >= CURRENT_DATE - INTERVAL '44 days'
    ORDER BY week_start
  `);

  if (cohorts.rows.length === 0) {
    log('INFO', 'No active cohorts to track.');
    return { cohortsTracked: 0, totalTracked: 0, totalSkipped: 0, totalDroppedBooli: 0, totalDroppedHemnet: 0 };
  }

  log('INFO', `Tracking ${cohorts.rows.length} active cohort(s) for ${today}`);

  let totalTracked = 0;
  let totalSkipped = 0;
  let totalDroppedBooli = 0;
  let totalDroppedHemnet = 0;

  for (const cohort of cohorts.rows) {
    const pairs = await client.query(`
      SELECT cp.id, cp.booli_id, cp.hemnet_id,
             cp.dropped_booli_on, cp.dropped_hemnet_on,
             cp.booli_listed::text AS booli_listed
      FROM cohort_pairs cp
      WHERE cp.cohort_id = $1
    `, [cohort.cohort_id]);

    let tracked = 0;
    let skipped = 0;
    let droppedBooli = 0;
    let droppedHemnet = 0;

    for (const pair of pairs.rows) {
      const dayNum = daysBetween(pair.booli_listed, today);
      if (dayNum < 0 || dayNum > 30) {
        skipped++;
        continue;
      }

      let booliViews = null;
      let hemnetViews = null;

      if (!pair.dropped_booli_on) {
        const bRes = await client.query(
          'SELECT times_viewed, is_active FROM booli_listing WHERE booli_id = $1',
          [pair.booli_id]
        );
        if (bRes.rows.length > 0 && bRes.rows[0].is_active) {
          booliViews = bRes.rows[0].times_viewed;
        } else {
          await client.query(
            'UPDATE cohort_pairs SET dropped_booli_on = $1 WHERE id = $2',
            [today, pair.id]
          );
          droppedBooli++;
        }
      }

      if (!pair.dropped_hemnet_on) {
        const hRes = await client.query(
          'SELECT times_viewed, is_active FROM hemnet_listingv2 WHERE hemnet_id = $1',
          [pair.hemnet_id]
        );
        if (hRes.rows.length > 0 && hRes.rows[0].is_active) {
          hemnetViews = hRes.rows[0].times_viewed;
        } else {
          await client.query(
            'UPDATE cohort_pairs SET dropped_hemnet_on = $1 WHERE id = $2',
            [today, pair.id]
          );
          droppedHemnet++;
        }
      }

      await client.query(`
        INSERT INTO cohort_daily_views (pair_id, date, booli_views, hemnet_views)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (pair_id, date) DO NOTHING
      `, [pair.id, today, booliViews, hemnetViews]);

      tracked++;
    }

    log('INFO', `${cohort.cohort_id}: tracked ${tracked}, skipped ${skipped} (>30d)` +
      (droppedBooli ? `, ${droppedBooli} Booli dropped` : '') +
      (droppedHemnet ? `, ${droppedHemnet} Hemnet dropped` : ''));

    totalTracked += tracked;
    totalSkipped += skipped;
    totalDroppedBooli += droppedBooli;
    totalDroppedHemnet += droppedHemnet;
  }

  log('INFO', `Done. Tracked: ${totalTracked}, Skipped: ${totalSkipped}, Dropped: ${totalDroppedBooli} Booli / ${totalDroppedHemnet} Hemnet`);

  return {
    cohortsTracked: cohorts.rows.length,
    totalTracked,
    totalSkipped,
    totalDroppedBooli,
    totalDroppedHemnet,
  };
}

runJob({
  scriptName: 'cohort-track',
  main,
  validate: (summary) => {
    if (summary.totalTracked === 0 && summary.cohortsTracked > 0) {
      return `0 pairs tracked across ${summary.cohortsTracked} active cohort(s) — expected hundreds`;
    }
    return null;
  },
});
ENDOFFILE
```

### cohort-create.js

```bash
cat > /opt/hemnet-cohort-tracker/cohort-create.js << 'ENDOFFILE'
const { runJob } = require('./cron-wrapper');

const BOOLI_COUNTIES = [
  'Stockholms län',
  'Västra Götalands län',
  'Skåne län',
  'Uppsala län',
];

const HEMNET_COUNTIES = [
  'Stockholms',
  'Västra Götalands',
  'Skåne',
  'Uppsala',
];

function getCohortWeek(dateStr) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);

  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const thu = new Date(monday);
  thu.setDate(monday.getDate() + 3);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((thu - jan1) / 86400000) + 1;
  const weekNum = Math.ceil(dayOfYear / 7);

  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const cohortId = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  return { cohortId, weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

async function main(client, log) {
  const argDate = process.argv[2];
  let targetDate;
  if (argDate) {
    targetDate = argDate;
  } else {
    const today = new Date();
    const day = today.getDay();
    const diffToLastMon = day === 0 ? 6 : day - 1;
    const lastMon = new Date(today);
    lastMon.setDate(today.getDate() - diffToLastMon - 7);
    targetDate = lastMon.toISOString().slice(0, 10);
  }

  const { cohortId, weekStart, weekEnd } = getCohortWeek(targetDate);
  log('INFO', `Creating cohort ${cohortId} (${weekStart} to ${weekEnd})`);

  const existing = await client.query('SELECT 1 FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (existing.rows.length > 0) {
    log('INFO', `Cohort ${cohortId} already exists. Skipping.`);
    return {
      cohortId,
      weekStart,
      weekEnd,
      skipped: true,
      booliListingsFound: 0,
      matched: 0,
      unmatched: 0,
      matchRate: 'N/A',
      day0PairsRecorded: 0,
    };
  }

  const booliListings = await client.query(`
    SELECT booli_id, title, street_address, postcode, municipality, county,
           listed, times_viewed
    FROM booli_listing
    WHERE is_active = true
      AND is_pre_market = false
      AND listed >= $1::date
      AND listed <= $2::date
      AND county = ANY($3)
  `, [weekStart, weekEnd, BOOLI_COUNTIES]);

  log('INFO', `Found ${booliListings.rows.length} Booli FS listings in target counties`);

  if (booliListings.rows.length === 0) {
    log('WARN', 'No listings found. Aborting.');
    return {
      cohortId,
      weekStart,
      weekEnd,
      skipped: false,
      booliListingsFound: 0,
      matched: 0,
      unmatched: 0,
      matchRate: '0%',
      day0PairsRecorded: 0,
    };
  }

  const matched = [];
  const unmatched = [];

  for (const b of booliListings.rows) {
    if (!b.title || !b.postcode) {
      unmatched.push(b);
      continue;
    }

    const hemnetCandidates = await client.query(`
      SELECT hemnet_id, street_address, postcode, municipality, county,
             listed, times_viewed
      FROM hemnet_listingv2
      WHERE is_active = true
        AND is_pre_market = false
        AND postcode = $1
        AND LOWER(TRIM(street_address)) = LOWER(TRIM($2))
        AND listed >= $3::date - INTERVAL '7 days'
        AND listed <= $3::date + INTERVAL '7 days'
        AND county = ANY($4)
    `, [b.postcode, b.title, b.listed, HEMNET_COUNTIES]);

    if (hemnetCandidates.rows.length > 0) {
      const best = hemnetCandidates.rows.reduce((a, c) => {
        const aDiff = Math.abs(new Date(a.listed) - new Date(b.listed));
        const cDiff = Math.abs(new Date(c.listed) - new Date(b.listed));
        return cDiff < aDiff ? c : a;
      });
      matched.push({ booli: b, hemnet: best });
    } else {
      unmatched.push(b);
    }
  }

  const matchRate = ((matched.length / booliListings.rows.length) * 100).toFixed(1) + '%';
  log('INFO', `Matched: ${matched.length}, Unmatched: ${unmatched.length}, Rate: ${matchRate}`);

  const countsByCounty = {};
  for (const m of matched) {
    const county = m.booli.county;
    countsByCounty[county] = (countsByCounty[county] || 0) + 1;
  }
  for (const [county, cnt] of Object.entries(countsByCounty).sort((a, b) => b[1] - a[1])) {
    log('INFO', `  ${county}: ${cnt}`);
  }

  await client.query('INSERT INTO cohorts (cohort_id, week_start, week_end) VALUES ($1, $2, $3)',
    [cohortId, weekStart, weekEnd]);

  for (const m of matched) {
    const county = m.booli.county.replace(/\s+län$/i, '');

    await client.query(`
      INSERT INTO cohort_pairs
        (cohort_id, booli_id, hemnet_id, street_address, postcode,
         municipality, county, booli_listed, hemnet_listed,
         booli_views_day0, hemnet_views_day0)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (cohort_id, booli_id, hemnet_id) DO NOTHING
    `, [
      cohortId,
      m.booli.booli_id,
      m.hemnet.hemnet_id,
      m.booli.title,
      m.booli.postcode,
      m.booli.municipality,
      county,
      m.booli.listed,
      m.hemnet.listed,
      m.booli.times_viewed,
      m.hemnet.times_viewed,
    ]);
  }

  for (const u of unmatched) {
    const county = (u.county || '').replace(/\s+län$/i, '');
    await client.query(`
      INSERT INTO cohort_unmatched
        (cohort_id, booli_id, title, street_address, postcode,
         municipality, county, listed, times_viewed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      cohortId, u.booli_id, u.title, u.street_address,
      u.postcode, u.municipality, county, u.listed, u.times_viewed,
    ]);
  }

  log('INFO', `Cohort ${cohortId} created with ${matched.length} pairs.`);

  const pairs = await client.query(
    'SELECT id, booli_views_day0, hemnet_views_day0 FROM cohort_pairs WHERE cohort_id = $1',
    [cohortId]
  );
  const today = new Date().toISOString().slice(0, 10);
  for (const p of pairs.rows) {
    await client.query(`
      INSERT INTO cohort_daily_views (pair_id, date, booli_views, hemnet_views)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (pair_id, date) DO NOTHING
    `, [p.id, today, p.booli_views_day0, p.hemnet_views_day0]);
  }

  log('INFO', `Day 0 views recorded for ${pairs.rows.length} pairs.`);

  return {
    cohortId,
    weekStart,
    weekEnd,
    skipped: false,
    booliListingsFound: booliListings.rows.length,
    matched: matched.length,
    unmatched: unmatched.length,
    matchRate,
    day0PairsRecorded: pairs.rows.length,
  };
}

runJob({
  scriptName: 'cohort-create',
  main,
  validate: (summary) => {
    if (summary.skipped) return null;
    if (summary.booliListingsFound === 0) {
      return 'No Booli listings found for cohort week — data pipeline may be down';
    }
    if (summary.matched === 0 && summary.booliListingsFound > 0) {
      return `0 matches from ${summary.booliListingsFound} Booli listings — check matching logic`;
    }
    return null;
  },
});
ENDOFFILE
```

### cohort-setup.js

```bash
cat > /opt/hemnet-cohort-tracker/cohort-setup.js << 'ENDOFFILE'
const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();
  console.log('Connected. Creating cohort tables...\n');

  // 1. Cohorts — one row per weekly cohort
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohorts (
      cohort_id TEXT PRIMARY KEY,           -- e.g. "2026-W10"
      week_start DATE NOT NULL,             -- Monday
      week_end DATE NOT NULL,               -- Sunday
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('  Created: cohorts');

  // 2. Cohort pairs — matched Booli+Hemnet listings in each cohort
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_pairs (
      id SERIAL PRIMARY KEY,
      cohort_id TEXT NOT NULL REFERENCES cohorts(cohort_id),
      booli_id BIGINT NOT NULL,
      hemnet_id BIGINT NOT NULL,
      street_address TEXT NOT NULL,
      postcode INTEGER NOT NULL,
      municipality TEXT NOT NULL,
      county TEXT NOT NULL,
      booli_listed DATE NOT NULL,
      hemnet_listed DATE NOT NULL,
      booli_views_day0 INTEGER NOT NULL DEFAULT 0,
      hemnet_views_day0 INTEGER NOT NULL DEFAULT 0,
      dropped_booli_on DATE,                -- date Booli listing went inactive
      dropped_hemnet_on DATE,               -- date Hemnet listing went inactive
      UNIQUE(cohort_id, booli_id, hemnet_id)
    )
  `);
  console.log('  Created: cohort_pairs');

  // 3. Daily view snapshots — one row per pair per date
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_daily_views (
      id SERIAL PRIMARY KEY,
      pair_id INTEGER NOT NULL REFERENCES cohort_pairs(id),
      date DATE NOT NULL,
      booli_views INTEGER,
      hemnet_views INTEGER,
      UNIQUE(pair_id, date)
    )
  `);
  console.log('  Created: cohort_daily_views');

  // 4. Unmatched log — Booli listings that didn't match to Hemnet
  await client.query(`
    CREATE TABLE IF NOT EXISTS cohort_unmatched (
      id SERIAL PRIMARY KEY,
      cohort_id TEXT NOT NULL REFERENCES cohorts(cohort_id),
      booli_id BIGINT NOT NULL,
      title TEXT,
      street_address TEXT,
      postcode INTEGER,
      municipality TEXT,
      county TEXT,
      listed DATE,
      times_viewed INTEGER
    )
  `);
  console.log('  Created: cohort_unmatched');

  console.log('\nDone. All tables ready.');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
ENDOFFILE
```

### cohort-report-new.js

```bash
cat > /opt/hemnet-cohort-tracker/cohort-report-new.js << 'ENDOFFILE'
const { createClient } = require('./db');

// --- Stat helpers (from cohort-views-report.js) ---

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtNum(v) {
  if (v === null || v === undefined) return '\u2014';
  return String(Math.round(v));
}

function fmtRatio(v) {
  if (v === null || v === undefined || v === '\u2014') return '\u2014';
  return typeof v === 'number' ? v.toFixed(1) : String(v);
}

// --- CLI parsing ---

const args = process.argv.slice(2);
const pairFlagIdx = args.indexOf('--pair');

async function run() {
  const client = createClient();
  await client.connect();

  try {
    if (pairFlagIdx !== -1) {
      const pairId = parseInt(args[pairFlagIdx + 1], 10);
      if (isNaN(pairId)) {
        console.log('Usage: node cohort-report-new.js --pair <pair_id>');
        return;
      }
      await runPairDetail(client, pairId);
    } else {
      const cohortId = args[0] || null;
      await runAggregate(client, cohortId);
    }
  } finally {
    await client.end();
  }
}

// --- Aggregate report (REPT-01 + REPT-02) ---

async function runAggregate(client, requestedCohortId) {
  // Resolve cohort
  let cohortId = requestedCohortId;
  if (!cohortId) {
    const latest = await client.query('SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1');
    if (latest.rows.length === 0) {
      console.log('No cohorts found.');
      return;
    }
    cohortId = latest.rows[0].cohort_id;
  }

  // Verify cohort exists
  const cohortInfo = await client.query('SELECT * FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (cohortInfo.rows.length === 0) {
    console.log(`Cohort ${cohortId} not found.`);
    return;
  }
  const cohort = cohortInfo.rows[0];

  // Fetch all view data (new schema -- no cohort_id, day, booli_delta, hemnet_delta on cohort_daily_views)
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views,
           cp.county, cp.booli_listed::text AS booli_listed
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
    ORDER BY dv.pair_id, dv.date
  `, [cohortId]);

  if (viewsRes.rows.length === 0) {
    console.log(`No view data for cohort ${cohortId}.`);
    return;
  }

  // Build pairDateMap: { pair_id: { date: { booli_views, hemnet_views, county } } }
  const pairDateMap = {};
  for (const r of viewsRes.rows) {
    if (!pairDateMap[r.pair_id]) pairDateMap[r.pair_id] = {};
    pairDateMap[r.pair_id][r.date] = {
      booli_views: r.booli_views,
      hemnet_views: r.hemnet_views,
      county: r.county,
    };
  }

  // Compute incrementals for consecutive dates
  const incrementals = []; // { pair_id, date, booli_incr, hemnet_incr, county }
  const qualityIssues = {
    negativeHemnet: [],
    negativeBooli: [],
    zeroDays: [],
    missingDates: [], // { pair_id, missing: [date_strings] }
  };

  const DAY_MS = 86400000;

  for (const pairId of Object.keys(pairDateMap)) {
    const dateMap = pairDateMap[pairId];
    const dates = Object.keys(dateMap).sort();

    // Check for missing dates (gaps)
    const missingForPair = [];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const gapDays = Math.round((curr - prev) / DAY_MS);
      if (gapDays > 1) {
        // Fill in missing date strings
        for (let g = 1; g < gapDays; g++) {
          const missing = new Date(prev.getTime() + g * DAY_MS);
          missingForPair.push(missing.toISOString().slice(0, 10));
        }
      }
    }
    if (missingForPair.length > 0) {
      qualityIssues.missingDates.push({ pair_id: pairId, missing: missingForPair });
    }

    // Compute incrementals
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const gapDays = Math.round((curr - prev) / DAY_MS);

      // Only compute for consecutive dates
      if (gapDays !== 1) continue;

      const prevData = dateMap[dates[i - 1]];
      const currData = dateMap[dates[i]];

      // Skip if views are NULL (dropped listings)
      if (currData.booli_views === null || currData.hemnet_views === null) continue;
      if (prevData.booli_views === null || prevData.hemnet_views === null) continue;

      const booli_incr = currData.booli_views - prevData.booli_views;
      const hemnet_incr = currData.hemnet_views - prevData.hemnet_views;

      incrementals.push({
        pair_id: pairId,
        date: dates[i],
        booli_incr,
        hemnet_incr,
        county: currData.county,
      });

      // Track quality issues
      if (hemnet_incr < 0) {
        qualityIssues.negativeHemnet.push({ pair_id: pairId, date: dates[i], value: hemnet_incr });
      }
      if (booli_incr < 0) {
        qualityIssues.negativeBooli.push({ pair_id: pairId, date: dates[i], value: booli_incr });
      }
      if (hemnet_incr === 0 && booli_incr === 0) {
        qualityIssues.zeroDays.push({ pair_id: pairId, date: dates[i] });
      }
    }
  }

  // Get date range
  const allDates = [...new Set(incrementals.map(r => r.date))].sort();
  const pairCount = Object.keys(pairDateMap).length;

  // Header
  console.log(`\n=== Cohort Report: ${cohortId} ===`);
  console.log(`Week: ${cohort.week_start.toISOString().slice(0, 10)} to ${cohort.week_end.toISOString().slice(0, 10)}`);
  console.log(`Pairs: ${pairCount}`);
  if (allDates.length > 0) {
    console.log(`Incremental date range: ${allDates[0]} to ${allDates[allDates.length - 1]}`);
  }

  // Aggregate table
  console.log(`\n--- Daily Incremental Views (median/mean across pairs) ---\n`);
  console.log(
    'Date'.padStart(12) +
    'Pairs'.padStart(7) +
    'H Med'.padStart(8) +
    'B Med'.padStart(8) +
    'M/M'.padStart(8) +
    'H Mean'.padStart(8) +
    'B Mean'.padStart(8) +
    'Mn/Mn'.padStart(8)
  );
  console.log('-'.repeat(67));

  // Group by date
  const byDate = {};
  for (const r of incrementals) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  for (const date of allDates) {
    const rows = byDate[date];
    const hVals = rows.map(r => r.hemnet_incr);
    const bVals = rows.map(r => r.booli_incr);
    const hMed = median(hVals);
    const bMed = median(bVals);
    const hMean = mean(hVals);
    const bMean = mean(bVals);
    const medRatio = bMed > 0 ? (hMed / bMed).toFixed(1) + 'x' : '\u2014';
    const meanRatio = bMean > 0 ? (hMean / bMean).toFixed(1) + 'x' : '\u2014';

    console.log(
      date.padStart(12) +
      String(rows.length).padStart(7) +
      fmtNum(hMed).padStart(8) +
      fmtNum(bMed).padStart(8) +
      String(medRatio).padStart(8) +
      fmtNum(hMean).padStart(8) +
      fmtNum(bMean).padStart(8) +
      String(meanRatio).padStart(8)
    );
  }

  // Data Quality section (REPT-02)
  console.log(`\n\n=== Data Quality ===\n`);

  // Negative incrementals
  console.log(`Negative Hemnet incrementals: ${qualityIssues.negativeHemnet.length}`);
  if (qualityIssues.negativeHemnet.length > 0) {
    const worst = qualityIssues.negativeHemnet.sort((a, b) => a.value - b.value)[0];
    console.log(`  Worst: pair ${worst.pair_id} on ${worst.date} = ${worst.value}`);
  }

  console.log(`Negative Booli incrementals: ${qualityIssues.negativeBooli.length}`);
  if (qualityIssues.negativeBooli.length > 0) {
    const worst = qualityIssues.negativeBooli.sort((a, b) => a.value - b.value)[0];
    console.log(`  Worst: pair ${worst.pair_id} on ${worst.date} = ${worst.value}`);
  }

  // Zero-incremental days
  const zeroPairs = new Set(qualityIssues.zeroDays.map(z => z.pair_id));
  console.log(`\nZero-incremental days (both H and B = 0): ${qualityIssues.zeroDays.length} occurrences across ${zeroPairs.size} pairs`);

  // Missing dates
  console.log(`\nPairs with date gaps: ${qualityIssues.missingDates.length}`);
  if (qualityIssues.missingDates.length > 0) {
    const showMax = Math.min(5, qualityIssues.missingDates.length);
    for (let i = 0; i < showMax; i++) {
      const m = qualityIssues.missingDates[i];
      const dates = m.missing.length <= 3
        ? m.missing.join(', ')
        : `${m.missing.slice(0, 3).join(', ')} (+${m.missing.length - 3} more)`;
      console.log(`  Pair ${m.pair_id}: missing ${dates}`);
    }
    if (qualityIssues.missingDates.length > showMax) {
      console.log(`  ... and ${qualityIssues.missingDates.length - showMax} more pairs`);
    }
  }
}

// --- Per-pair detail (REPT-04) ---

async function runPairDetail(client, pairId) {
  const res = await client.query(`
    SELECT dv.date::text AS date, dv.booli_views, dv.hemnet_views,
           cp.booli_id, cp.hemnet_id, cp.county, cp.booli_listed::text AS booli_listed
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE dv.pair_id = $1
    ORDER BY dv.date
  `, [pairId]);

  if (res.rows.length === 0) {
    console.log(`Pair ${pairId} not found.`);
    return;
  }

  const info = res.rows[0];
  const DAY_MS = 86400000;

  console.log(`\n=== Pair ${pairId} Detail ===`);
  console.log(`Booli ID: ${info.booli_id}, Hemnet ID: ${info.hemnet_id}`);
  console.log(`County: ${info.county}, Listed: ${info.booli_listed}`);

  console.log('');
  console.log(
    'Date'.padStart(12) +
    'Day'.padStart(5) +
    'B Views'.padStart(9) +
    'H Views'.padStart(9) +
    'B Incr'.padStart(8) +
    'H Incr'.padStart(8)
  );
  console.log('-'.repeat(51));

  const listedDate = new Date(info.booli_listed);

  for (let i = 0; i < res.rows.length; i++) {
    const r = res.rows[i];
    const rowDate = new Date(r.date);
    const day = Math.round((rowDate - listedDate) / DAY_MS);

    let bIncr = '\u2014';
    let hIncr = '\u2014';

    if (i > 0) {
      const prev = res.rows[i - 1];
      const prevDate = new Date(prev.date);
      const gap = Math.round((rowDate - prevDate) / DAY_MS);

      if (gap === 1 && r.booli_views !== null && prev.booli_views !== null
          && r.hemnet_views !== null && prev.hemnet_views !== null) {
        bIncr = String(r.booli_views - prev.booli_views);
        hIncr = String(r.hemnet_views - prev.hemnet_views);
      } else if (gap > 1) {
        bIncr = '[gap]';
        hIncr = '[gap]';
      }
    }

    const bViews = r.booli_views !== null ? String(r.booli_views) : '\u2014';
    const hViews = r.hemnet_views !== null ? String(r.hemnet_views) : '\u2014';

    console.log(
      r.date.padStart(12) +
      String(day).padStart(5) +
      bViews.padStart(9) +
      hViews.padStart(9) +
      bIncr.padStart(8) +
      hIncr.padStart(8)
    );
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
ENDOFFILE
```

### export-cohort-csv.js

```bash
cat > /opt/hemnet-cohort-tracker/export-cohort-csv.js << 'ENDOFFILE'
const { createClient } = require('./db');
const fs = require('fs');

async function run() {
  const client = createClient();
  await client.connect();

  // Determine cohort ID: use argv[2] or fall back to latest cohort
  let cohortId = process.argv[2];
  if (!cohortId) {
    const latestRes = await client.query(`
      SELECT cohort_id FROM cohorts ORDER BY week_start DESC LIMIT 1
    `);
    if (latestRes.rows.length === 0) {
      console.error('No cohorts found in database');
      await client.end();
      process.exit(1);
    }
    cohortId = latestRes.rows[0].cohort_id;
    console.log(`No cohort specified, using latest: ${cohortId}`);
  }

  // Get all dates for this cohort (sorted) -- JOIN through cohort_pairs
  const datesRes = await client.query(`
    SELECT DISTINCT dv.date::text AS date
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
    ORDER BY date
  `, [cohortId]);
  const dates = datesRes.rows.map(r => r.date);

  // Get all pairs with info
  const pairsRes = await client.query(`
    SELECT id, booli_id, hemnet_id, county, booli_listed::text AS booli_listed
    FROM cohort_pairs
    WHERE cohort_id = $1
    ORDER BY county, id
  `, [cohortId]);

  // Get all daily view data -- JOIN through cohort_pairs
  const viewsRes = await client.query(`
    SELECT dv.pair_id, dv.date::text AS date, dv.booli_views, dv.hemnet_views
    FROM cohort_daily_views dv
    JOIN cohort_pairs cp ON cp.id = dv.pair_id
    WHERE cp.cohort_id = $1
  `, [cohortId]);

  // Index views by pair_id + date
  const viewMap = {};
  for (const v of viewsRes.rows) {
    viewMap[`${v.pair_id}_${v.date}`] = v;
  }

  // Compute incremental views per pair (day-over-day change for consecutive dates)
  const incrMap = {};
  for (const pair of pairsRes.rows) {
    // Collect this pair's dates in sorted order
    const pairDates = dates.filter(d => viewMap[`${pair.id}_${d}`]);
    for (let i = 1; i < pairDates.length; i++) {
      const prev = viewMap[`${pair.id}_${pairDates[i - 1]}`];
      const curr = viewMap[`${pair.id}_${pairDates[i]}`];

      // Check dates are consecutive (1 day apart)
      const prevDate = new Date(pairDates[i - 1]);
      const currDate = new Date(pairDates[i]);
      const diffDays = (currDate - prevDate) / (1000 * 60 * 60 * 24);

      if (diffDays === 1 && curr.hemnet_views != null && prev.hemnet_views != null
          && curr.booli_views != null && prev.booli_views != null) {
        incrMap[`${pair.id}_${pairDates[i]}`] = {
          hemnet_incr: curr.hemnet_views - prev.hemnet_views,
          booli_incr: curr.booli_views - prev.booli_views,
        };
      }
    }
  }

  // Build CSV header: 4 columns per date (raw H, raw B, incremental H, incremental B)
  const headerParts = ['pair_id', 'booli_id', 'hemnet_id', 'county', 'booli_listed'];
  for (const d of dates) {
    headerParts.push(`H_${d}`);
    headerParts.push(`B_${d}`);
    headerParts.push(`H_incr_${d}`);
    headerParts.push(`B_incr_${d}`);
  }

  const lines = [headerParts.join(',')];

  for (const pair of pairsRes.rows) {
    const row = [
      pair.id,
      pair.booli_id,
      pair.hemnet_id,
      `"${pair.county}"`,
      pair.booli_listed,
    ];

    for (const d of dates) {
      const v = viewMap[`${pair.id}_${d}`];
      const incr = incrMap[`${pair.id}_${d}`];
      row.push(v ? (v.hemnet_views ?? '') : '');
      row.push(v ? (v.booli_views ?? '') : '');
      row.push(incr ? incr.hemnet_incr : '');
      row.push(incr ? incr.booli_incr : '');
    }

    lines.push(row.join(','));
  }

  const outFile = `cohort-${cohortId}-views.csv`;
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`Wrote ${pairsRes.rows.length} pairs x ${dates.length} dates to ${outFile}`);
  console.log(`Dates: ${dates[0]} to ${dates[dates.length - 1]}`);

  await client.end();
}

module.exports = { run };

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
ENDOFFILE
```

### package.json

```bash
cat > /opt/hemnet-cohort-tracker/package.json << 'ENDOFFILE'
{
  "name": "hemnet-cohort-tracker",
  "version": "1.0.0",
  "description": "Cohort-based listing views tracker: Hemnet vs Booli",
  "scripts": {
    "setup": "node cohort-setup.js",
    "create": "node cohort-create.js",
    "track": "node cohort-track.js",
    "report": "node cohort-report-new.js",
    "setup-cron": "node cron-setup.js",
    "health": "node cron-health.js"
  },
  "dependencies": {
    "dotenv": "^17.0.0",
    "pg": "^8.0.0"
  }
}
ENDOFFILE
```

## 3. Verify file transfer

Run these commands to confirm line counts match:

```bash
wc -l /opt/hemnet-cohort-tracker/cohort-track.js  # expected: 126
wc -l /opt/hemnet-cohort-tracker/cohort-create.js  # expected: 238
wc -l /opt/hemnet-cohort-tracker/cohort-setup.js  # expected: 79
wc -l /opt/hemnet-cohort-tracker/cohort-report-new.js  # expected: 352
wc -l /opt/hemnet-cohort-tracker/export-cohort-csv.js  # expected: 125
wc -l /opt/hemnet-cohort-tracker/package.json  # expected: 18
```

## 4. Update crontab

This replaces the entire crontab with the new schedule (23:30 UTC primary, 02:00 UTC backup for cohort-track).

```bash
crontab << 'CRONTAB'
30 23 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 2 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-create.js
0 8 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js sfpl-region-snapshot.js
CRONTAB
```

## 5. Verify crontab

```bash
crontab -l
```

Expected output:

```
30 23 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 2 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-track.js
0 6 * * 1 cd /opt/hemnet-cohort-tracker && node cron-wrapper.js cohort-create.js
0 8 * * * cd /opt/hemnet-cohort-tracker && node cron-wrapper.js sfpl-region-snapshot.js
```
