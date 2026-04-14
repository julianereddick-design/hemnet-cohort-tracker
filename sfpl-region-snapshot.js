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

const BUCKET_ORDER = ['0-7d', '8-14d', '15-28d', '29-90d', '91-180d', '181d+'];

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS sfpl_region_daily (
    snapshot_date   DATE    NOT NULL,
    region          TEXT    NOT NULL,
    age_bucket      TEXT    NOT NULL,
    booli_pm_count  INTEGER NOT NULL DEFAULT 0,
    hemnet_fs_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (snapshot_date, region, age_bucket)
  )
`;

const ADD_BOOLI_FS_COL = `
  ALTER TABLE sfpl_region_daily ADD COLUMN IF NOT EXISTS booli_fs_count INTEGER NOT NULL DEFAULT 0
`;

const BOOLI_QUERY = `
  SELECT
    county,
    CASE
      WHEN (CURRENT_DATE - listed) BETWEEN 0 AND 7 THEN '0-7d'
      WHEN (CURRENT_DATE - listed) BETWEEN 8 AND 14 THEN '8-14d'
      WHEN (CURRENT_DATE - listed) BETWEEN 15 AND 28 THEN '15-28d'
      WHEN (CURRENT_DATE - listed) BETWEEN 29 AND 90 THEN '29-90d'
      WHEN (CURRENT_DATE - listed) BETWEEN 91 AND 180 THEN '91-180d'
      ELSE '181d+'
    END AS bucket,
    COUNT(*) AS cnt
  FROM booli_listing
  WHERE is_pre_market = true
    AND removed IS NULL
  GROUP BY county, bucket
`;

const BOOLI_FS_QUERY = `
  SELECT county, COUNT(*) AS cnt
  FROM booli_listing
  WHERE is_pre_market = false
    AND removed IS NULL
  GROUP BY county
`;

const HEMNET_QUERY = `
  SELECT county, COUNT(*) AS cnt
  FROM hemnet_listingv2
  WHERE is_active = true
    AND is_pre_market = false
  GROUP BY county
`;

async function main(client, log) {
  await client.query(CREATE_TABLE);
  await client.query(ADD_BOOLI_FS_COL);

  const [booliRes, booliFs, hemnetRes] = await Promise.all([
    client.query(BOOLI_QUERY),
    client.query(BOOLI_FS_QUERY),
    client.query(HEMNET_QUERY),
  ]);

  const booliByRegionBucket = {};
  for (const r of booliRes.rows) {
    const county = normalizeCounty(r.county);
    if (!county) continue;
    const region = countyToRegion(county);
    const key = `${region}|${r.bucket}`;
    booliByRegionBucket[key] = (booliByRegionBucket[key] || 0) + Number(r.cnt);
  }

  const booliFsByRegion = { Stockholm: 0, VG: 0, Rest: 0 };
  for (const r of booliFs.rows) {
    const county = normalizeCounty(r.county);
    if (!county) continue;
    const region = countyToRegion(county);
    booliFsByRegion[region] += Number(r.cnt);
  }

  const hemnetByRegion = { Stockholm: 0, VG: 0, Rest: 0 };
  for (const r of hemnetRes.rows) {
    const county = normalizeCounty(r.county);
    if (!county) continue;
    const region = countyToRegion(county);
    hemnetByRegion[region] += Number(r.cnt);
  }

  const today = new Date().toISOString().slice(0, 10);
  const regions = ['Stockholm', 'VG', 'Rest'];

  const UPSERT = `
    INSERT INTO sfpl_region_daily (snapshot_date, region, age_bucket, booli_pm_count, hemnet_fs_count, booli_fs_count)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (snapshot_date, region, age_bucket)
    DO UPDATE SET booli_pm_count = EXCLUDED.booli_pm_count, hemnet_fs_count = EXCLUDED.hemnet_fs_count, booli_fs_count = EXCLUDED.booli_fs_count
  `;

  let rowCount = 0;
  const regionSummary = {};
  for (const region of regions) {
    let booliPmTotal = 0;
    for (const bucket of BUCKET_ORDER) {
      const booliPm = booliByRegionBucket[`${region}|${bucket}`] || 0;
      const hemnet = hemnetByRegion[region];
      const booliFs = booliFsByRegion[region];
      await client.query(UPSERT, [today, region, bucket, booliPm, hemnet, booliFs]);
      booliPmTotal += booliPm;
      rowCount++;
    }
    regionSummary[region] = { booliPmTotal, booliFsTotal: booliFsByRegion[region], hemnetFs: hemnetByRegion[region] };
  }

  log('INFO', `Snapshot ${today}: upserted ${rowCount} rows`);
  for (const region of regions) {
    const s = regionSummary[region];
    log('INFO', `  ${region}: Booli PM=${s.booliPmTotal}, Booli FS=${s.booliFsTotal}, Hemnet FS=${s.hemnetFs}`);
  }

  return { rowCount, regions: regionSummary };
}

runJob({
  scriptName: 'sfpl-region-snapshot',
  main,
  validate: (summary) => {
    if (summary.rowCount !== 18) {
      return `Expected 18 rows upserted, got ${summary.rowCount}`;
    }
    return null;
  },
});
