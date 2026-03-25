const { runJob } = require('./cron-wrapper');

function normalizeCounty(name) {
  if (!name) return '';
  return name.replace(/ län$/, '').trim();
}

function countyToRegion(county) {
  if (county === 'Stockholms') return 'Stockholm';
  if (county === 'Västra Götalands') return 'VG';
  return 'Rest';
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS listing_flow_weekly (
    week_start     DATE        NOT NULL,
    region         TEXT        NOT NULL,
    platform       TEXT        NOT NULL,
    segment        TEXT        NOT NULL,
    new_listings   INTEGER     NOT NULL,
    PRIMARY KEY (week_start, region, platform, segment)
  )
`;

// Hemnet: use crawled (reliable first-seen timestamp, scraper is stable)
const HEMNET_QUERY = `
  SELECT
    date_trunc('week', crawled)::date AS week_start,
    county,
    CASE WHEN is_pre_market = true THEN 'pm' ELSE 'fs' END AS segment,
    COUNT(*)::int AS new_listings
  FROM hemnet_listingv2
  WHERE crawled >= $1
  GROUP BY 1, 2, 3
`;

// Booli: use listed (avoids catch-up spikes from scraper downtime)
const BOOLI_QUERY = `
  SELECT
    date_trunc('week', listed)::date AS week_start,
    county,
    CASE WHEN is_pre_market = true THEN 'pm' ELSE 'fs' END AS segment,
    COUNT(*)::int AS new_listings
  FROM booli_listing
  WHERE listed >= $1
  GROUP BY 1, 2, 3
`;

function weeksBack(n) {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  return d.toISOString().slice(0, 10);
}

function buildRegionData(rows) {
  const data = {};
  const regions = ['Stockholm', 'VG', 'Rest'];
  for (const row of rows) {
    const county = normalizeCounty(row.county);
    if (!county) continue;
    const region = countyToRegion(county);
    const week = row.week_start.toISOString().slice(0, 10);
    const key = `${week}|${region}|${row.segment}`;
    data[key] = (data[key] || 0) + row.new_listings;
  }
  // Compute National totals
  const weeks = [...new Set(Object.keys(data).map(k => k.split('|')[0]))];
  for (const week of weeks) {
    for (const seg of ['fs', 'pm']) {
      const total = regions.reduce((s, r) => s + (data[`${week}|${r}|${seg}`] || 0), 0);
      data[`${week}|National|${seg}`] = total;
    }
  }
  return data;
}

async function main(client, log) {
  // Only collect data from 2026-03-24 onwards (historical scraper data unreliable)
  const FLOW_START = '2026-03-24';
  const weeks = 16;
  const lookback = weeksBack(weeks);
  const since = lookback > FLOW_START ? lookback : FLOW_START;

  await client.query(CREATE_TABLE);

  const [hemnetRes, booliRes] = await Promise.all([
    client.query(HEMNET_QUERY, [since]),
    client.query(BOOLI_QUERY, [since]),
  ]);

  const hemnet = buildRegionData(hemnetRes.rows);
  const booli = buildRegionData(booliRes.rows);

  const allWeeks = [...new Set([
    ...Object.keys(hemnet).map(k => k.split('|')[0]),
    ...Object.keys(booli).map(k => k.split('|')[0]),
  ])].sort();

  const allRegions = ['Stockholm', 'VG', 'Rest', 'National'];

  const UPSERT = `
    INSERT INTO listing_flow_weekly (week_start, region, platform, segment, new_listings)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (week_start, region, platform, segment)
    DO UPDATE SET new_listings = EXCLUDED.new_listings
  `;

  let upserted = 0;
  for (const week of allWeeks) {
    for (const region of allRegions) {
      for (const seg of ['fs', 'pm']) {
        const hKey = `${week}|${region}|${seg}`;
        const bKey = `${week}|${region}|${seg}`;
        if (hemnet[hKey] != null) {
          await client.query(UPSERT, [week, region, 'hemnet', seg, hemnet[hKey]]);
          upserted++;
        }
        if (booli[bKey] != null) {
          await client.query(UPSERT, [week, region, 'booli', seg, booli[bKey]]);
          upserted++;
        }
      }
    }
  }

  // Log latest complete week national summary
  const latestWeek = allWeeks[allWeeks.length - 2] || allWeeks[allWeeks.length - 1];
  const hFS = hemnet[`${latestWeek}|National|fs`] || 0;
  const bFS = booli[`${latestWeek}|National|fs`] || 0;
  const bPM = booli[`${latestWeek}|National|pm`] || 0;
  log('INFO', `${upserted} rows upserted. Latest full week (${latestWeek}): H FS=${hFS}, B FS=${bFS}, B PM=${bPM}`);

  return { upserted, weeks: allWeeks.length, latestWeek, nationalHFS: hFS, nationalBFS: bFS, nationalBPM: bPM };
}

runJob({
  scriptName: 'flow-monitor',
  main,
  validate: (summary) => {
    if (summary.upserted === 0) {
      return 'Zero rows upserted — no data found';
    }
    return null;
  },
});
