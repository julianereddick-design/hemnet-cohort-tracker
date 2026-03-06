const { createClient } = require('./db');

// Target counties: Booli uses " län" suffix, Hemnet does not
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

// Get ISO week string (e.g. "2026-W10") and Mon-Sun date range
function getCohortWeek(dateStr) {
  // Parse as local date (avoid timezone shifts)
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);

  // Find Monday of this week (getDay: 0=Sun, 1=Mon, ..., 6=Sat)
  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  // ISO 8601 week number: week 1 contains the first Thursday of the year
  const thu = new Date(monday);
  thu.setDate(monday.getDate() + 3); // Thursday of this week
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

async function run() {
  const client = createClient();
  await client.connect();

  // Determine which week to create a cohort for
  // Default: previous week (run on Monday for Mon-Sun prior)
  // Override: pass a date as CLI arg (e.g. node cohort-create.js 2026-03-01)
  const argDate = process.argv[2];
  let targetDate;
  if (argDate) {
    targetDate = argDate;
  } else {
    // Default to last Monday (start of previous week)
    const today = new Date();
    const day = today.getDay();
    const diffToLastMon = day === 0 ? 6 : day - 1;
    const lastMon = new Date(today);
    lastMon.setDate(today.getDate() - diffToLastMon - 7);
    targetDate = lastMon.toISOString().slice(0, 10);
  }

  const { cohortId, weekStart, weekEnd } = getCohortWeek(targetDate);
  console.log(`Creating cohort ${cohortId} (${weekStart} to ${weekEnd})\n`);

  // Check if cohort already exists
  const existing = await client.query('SELECT 1 FROM cohorts WHERE cohort_id = $1', [cohortId]);
  if (existing.rows.length > 0) {
    console.log(`Cohort ${cohortId} already exists. Skipping.`);
    await client.end();
    return;
  }

  // Step 1: Find new Booli for-sale listings in the cohort week
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

  console.log(`Found ${booliListings.rows.length} Booli FS listings in target counties\n`);

  if (booliListings.rows.length === 0) {
    console.log('No listings found. Aborting.');
    await client.end();
    return;
  }

  // Step 2: Match each Booli listing to Hemnet
  // Match on: postcode + normalised address (Booli title = Hemnet street_address)
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
      // Take the closest listed date match
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

  console.log(`Matched: ${matched.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  console.log(`Match rate: ${((matched.length / booliListings.rows.length) * 100).toFixed(1)}%\n`);

  // County breakdown
  const countsByCounty = {};
  for (const m of matched) {
    const county = m.booli.county;
    countsByCounty[county] = (countsByCounty[county] || 0) + 1;
  }
  console.log('Matches by county:');
  for (const [county, cnt] of Object.entries(countsByCounty).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${county}: ${cnt}`);
  }

  // Step 3: Insert cohort and pairs
  await client.query('INSERT INTO cohorts (cohort_id, week_start, week_end) VALUES ($1, $2, $3)',
    [cohortId, weekStart, weekEnd]);

  for (const m of matched) {
    // Normalise county: strip " län" from Booli
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

  // Log unmatched
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

  console.log(`\nCohort ${cohortId} created with ${matched.length} pairs.`);

  // Day 0 tracking entry
  const pairs = await client.query(
    'SELECT id, booli_views_day0, hemnet_views_day0 FROM cohort_pairs WHERE cohort_id = $1',
    [cohortId]
  );
  const today = new Date().toISOString().slice(0, 10);
  for (const p of pairs.rows) {
    await client.query(`
      INSERT INTO cohort_daily_views (cohort_id, pair_id, day, date, booli_views, hemnet_views, booli_delta, hemnet_delta)
      VALUES ($1, $2, 0, $3, $4, $5, 0, 0)
      ON CONFLICT (pair_id, day) DO NOTHING
    `, [cohortId, p.id, today, p.booli_views_day0, p.hemnet_views_day0]);
  }

  console.log(`Day 0 views recorded for ${pairs.rows.length} pairs.`);
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
