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
  CREATE TABLE IF NOT EXISTS listing_gap_weekly (
    snapshot_date  DATE        NOT NULL,
    region         TEXT        NOT NULL,
    segment        TEXT        NOT NULL,
    hemnet_count   INTEGER     NOT NULL,
    booli_count    INTEGER     NOT NULL,
    h_b_pct        NUMERIC(5,1) NOT NULL,
    PRIMARY KEY (snapshot_date, region, segment)
  )
`;

const HEMNET_QUERY = `
  SELECT county, is_pre_market, COUNT(*)::int AS count
  FROM hemnet_listingv2
  WHERE is_active = true AND (CURRENT_DATE - listed) <= 360
  GROUP BY county, is_pre_market
`;

const BOOLI_QUERY = `
  SELECT county, is_pre_market, COUNT(*)::int AS count
  FROM booli_listing
  WHERE removed IS NULL AND (CURRENT_DATE - listed) <= 360
  GROUP BY county, is_pre_market
`;

function buildRegionData(rows) {
  const data = {};
  for (const row of rows) {
    const county = normalizeCounty(row.county);
    if (!county) continue;
    const region = countyToRegion(county);
    const seg = row.is_pre_market ? 'pm' : 'fs';
    const key = `${region}|${seg}`;
    data[key] = (data[key] || 0) + row.count;
  }
  return data;
}

async function main(client, log) {
  await client.query(CREATE_TABLE);

  const [hemnetRes, booliRes] = await Promise.all([
    client.query(HEMNET_QUERY),
    client.query(BOOLI_QUERY),
  ]);

  const hemnet = buildRegionData(hemnetRes.rows);
  const booli = buildRegionData(booliRes.rows);

  const regions = ['Stockholm', 'VG', 'Rest'];
  const segments = ['fs', 'pm', 'total'];
  const today = new Date().toISOString().slice(0, 10);

  // Compute National by summing regions
  for (const seg of ['fs', 'pm']) {
    hemnet[`National|${seg}`] = regions.reduce((s, r) => s + (hemnet[`${r}|${seg}`] || 0), 0);
    booli[`National|${seg}`] = regions.reduce((s, r) => s + (booli[`${r}|${seg}`] || 0), 0);
  }

  // Compute totals (fs + pm) for each region + National
  for (const r of [...regions, 'National']) {
    hemnet[`${r}|total`] = (hemnet[`${r}|fs`] || 0) + (hemnet[`${r}|pm`] || 0);
    booli[`${r}|total`] = (booli[`${r}|fs`] || 0) + (booli[`${r}|pm`] || 0);
  }

  const UPSERT = `
    INSERT INTO listing_gap_weekly (snapshot_date, region, segment, hemnet_count, booli_count, h_b_pct)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (snapshot_date, region, segment)
    DO UPDATE SET hemnet_count = EXCLUDED.hemnet_count,
                 booli_count = EXCLUDED.booli_count,
                 h_b_pct = EXCLUDED.h_b_pct
  `;

  const allRegions = [...regions, 'National'];
  let rowCount = 0;
  for (const region of allRegions) {
    for (const seg of segments) {
      const h = hemnet[`${region}|${seg}`] || 0;
      const b = booli[`${region}|${seg}`] || 0;
      const pct = b > 0 ? (h / b * 100) : 0;
      await client.query(UPSERT, [today, region, seg, h, b, parseFloat(pct.toFixed(1))]);
      rowCount++;
    }
  }

  const natH = hemnet['National|total'] || 0;
  const natB = booli['National|total'] || 0;
  const natPct = natB > 0 ? (natH / natB * 100).toFixed(1) : '0';
  log('INFO', `Snapshot ${today}: ${rowCount} rows. National: H=${natH} B=${natB} H/B=${natPct}%`);

  return { rowCount, national: { hemnet: natH, booli: natB, hbPct: parseFloat(natPct) } };
}

runJob({
  scriptName: 'listing-gap-monitor',
  main,
  validate: (summary) => {
    if (summary.rowCount !== 12) {
      return `Expected 12 rows upserted, got ${summary.rowCount}`;
    }
    if (summary.national.hemnet === 0 || summary.national.booli === 0) {
      return `Zero count detected: Hemnet=${summary.national.hemnet}, Booli=${summary.national.booli}`;
    }
    return null;
  },
});
