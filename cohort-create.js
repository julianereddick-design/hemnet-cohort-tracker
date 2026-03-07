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
      INSERT INTO cohort_daily_views (cohort_id, pair_id, day, date, booli_views, hemnet_views, booli_delta, hemnet_delta)
      VALUES ($1, $2, 0, $3, $4, $5, 0, 0)
      ON CONFLICT (pair_id, day) DO NOTHING
    `, [cohortId, p.id, today, p.booli_views_day0, p.hemnet_views_day0]);
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
