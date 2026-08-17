'use strict';

// lib/disk-floor.js
//
// Free-space headroom as an OUTCOME, not as a job (spec §2 principle 4, §3).
// Monitoring disk rather than the prune jobs that protect it also catches
// pressure from causes nobody thought of — and a real ENOSPC is what destroyed
// the 2026-07-27 spot-check run.
//
// BYTES AND INODES BOTH. Inodes are the half a percentage-of-bytes check cannot
// see: the spot-check gate writes thousands of small JPEGs per week (W30 3,113 →
// W31 7,177 → W32 12,407 with the prune confirmed broken), which exhausts inodes
// long before it exhausts gigabytes. A byte-only floor would read healthy right
// up to the ENOSPC.
//
// days_to_full is REPORTED, never itself a breach. It is context for judging how
// urgent a real breach is; treating a runway as an alert would fire on any disk
// that is merely growing, which every disk is.
//
//   node lib/disk-floor.js --smoke

const FLOOR_PCT = 15;                          // % free, bytes or inodes
const FLOOR_BYTES = 1024 * 1024 * 1024;        // and never below 1 GiB absolute

// parseDf(text, { blockSize }) -> { total, used, free } | null
//
// blockSize defaults to 1024 for `df -P -k`. Pass 1 for `df -P -i`, whose
// columns are COUNTS: scaling those by 1024 would report a terabyte of inodes
// and never breach.
//
// -P is POSIX output, but a device name longer than the column still wraps onto
// its own line, so the numbers are taken from the END of the joined row rather
// than by fixed field index.
function parseDf(text, { blockSize = 1024 } = {}) {
  if (!text) return null;
  const lines = String(text).trim().split('\n').slice(1);   // drop the header
  if (!lines.length) return null;
  const joined = lines.join(' ').trim().split(/\s+/);
  // ... total used free capacity mountpoint
  const nums = joined.filter(t => /^\d+$/.test(t));
  if (nums.length < 3) return null;
  const [total, used, free] = nums.slice(0, 3).map(Number);
  if (!Number.isFinite(total) || total <= 0) return null;
  return { total: total * blockSize, used: used * blockSize, free: free * blockSize };
}

// daysToFull(samples, currentFree) -> number | null
//
// samples: [{ day: 'YYYY-MM-DD', bytes_free }], any order.
// null whenever an extrapolation would be dishonest: fewer than two samples,
// a span under a day (which would divide by ~0 and report a runway of minutes),
// or a disk that is flat or being cleaned (which would report a NEGATIVE runway
// and read as an emergency).
function daysToFull(samples, currentFree) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanDays = (new Date(last.day) - new Date(first.day)) / 86400000;
  if (!(spanDays >= 1)) return null;
  const declinePerDay = (Number(first.bytes_free) - Number(last.bytes_free)) / spanDays;
  if (!(declinePerDay > 0)) return null;
  return currentFree / declinePerDay;
}

function pct(free, total) {
  return total > 0 ? Math.round((free / total) * 100) : 0;
}

function human(bytes) {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)}G` : `${Math.round(bytes / (1024 ** 2))}M`;
}

// assessDisk({ bytes, inodes, samples }) -> { breaches, pctFree, inodePctFree, daysToFull, detail }
function assessDisk({ bytes, inodes, samples = [] }) {
  const pctFree = pct(bytes.free, bytes.total);
  const inodePctFree = pct(inodes.free, inodes.total);
  const runway = daysToFull(samples, bytes.free);

  const breaches = [];
  if (pctFree < FLOOR_PCT) breaches.push(`free bytes ${pctFree}% below the ${FLOOR_PCT}% floor (${human(bytes.free)} left)`);
  if (bytes.free < FLOOR_BYTES) breaches.push(`free bytes ${human(bytes.free)} below the ${human(FLOOR_BYTES)} absolute floor`);
  if (inodePctFree < FLOOR_PCT) breaches.push(`free inodes ${inodePctFree}% below the ${FLOOR_PCT}% floor (${inodes.free} left)`);

  const runwayText = runway == null
    ? 'days to full: not enough history'
    : `days to full: ${runway < 1 ? '<1' : Math.round(runway)}`;
  const detail = `${human(bytes.free)} free (${pctFree}%), inodes ${inodePctFree}% free — ${runwayText}`;

  return { breaches, pctFree, inodePctFree, daysToFull: runway, detail };
}

// One row per day. days_to_full needs history, and there is nowhere else in this
// schema that records it. Same failure posture as lib/alert-state.js: a missing
// table degrades to "not enough history", never to a crash or a fake number.
const DISK_DDL = `
CREATE TABLE IF NOT EXISTS disk_sample (
  day          DATE   PRIMARY KEY,
  bytes_free   BIGINT NOT NULL,
  bytes_total  BIGINT NOT NULL,
  inodes_free  BIGINT NOT NULL,
  inodes_total BIGINT NOT NULL
)`;

function isMissingTable(err) {
  return err && (err.code === '42P01' || /relation "disk_sample" does not exist/i.test(err.message || ''));
}

async function recordSample(client, { bytes, inodes }) {
  try {
    await client.query(
      `INSERT INTO disk_sample (day, bytes_free, bytes_total, inodes_free, inodes_total)
       VALUES (CURRENT_DATE, $1, $2, $3, $4)
       ON CONFLICT (day) DO UPDATE SET
         bytes_free = EXCLUDED.bytes_free, bytes_total = EXCLUDED.bytes_total,
         inodes_free = EXCLUDED.inodes_free, inodes_total = EXCLUDED.inodes_total`,
      [bytes.free, bytes.total, inodes.free, inodes.total],
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

async function recentSamples(client, days = 30) {
  try {
    const r = await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, bytes_free
         FROM disk_sample WHERE day >= CURRENT_DATE - $1::int ORDER BY day`, [days]);
    return r.rows;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

module.exports = {
  parseDf, daysToFull, assessDisk, FLOOR_PCT, FLOOR_BYTES,
  DISK_DDL, recordSample, recentSamples,
};

// ---------------------------------------------------------------
//   node lib/disk-floor.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { parseDf, daysToFull, assessDisk, FLOOR_PCT, FLOOR_BYTES } = module.exports;
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  // Captured verbatim from the droplet 2026-08-17.
  const DF_K = `Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/vda1          9065864 5014180   4035300      56% /`;
  const DF_I = `Filesystem      Inodes   IUsed   IFree IUse% Mounted on
/dev/vda1      1179648 162765 1016883   14% /`;

  check('parseDf reads the 1K-block form', () => {
    const d = parseDf(DF_K);
    assert.strictEqual(d.total, 9065864 * 1024);
    assert.strictEqual(d.free, 4035300 * 1024);
  });

  // -i reports COUNTS, not kilobytes. Multiplying them by 1024 would report a
  // terabyte of inodes and never breach.
  check('parseDf reads the inode form without scaling it', () => {
    const d = parseDf(DF_I, { blockSize: 1 });
    assert.strictEqual(d.total, 1179648);
    assert.strictEqual(d.free, 1016883);
  });

  check('parseDf survives a device name long enough to wrap the column', () => {
    const wrapped = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/mapper/a-very-long-logical-volume-name
                   9065864 5014180   4035300      56% /`;
    const d = parseDf(wrapped);
    assert.strictEqual(d.free, 4035300 * 1024, 'a wrapped df line must still parse');
  });

  check('parseDf returns null on junk rather than pretending', () => {
    assert.strictEqual(parseDf('df: /: No such file or directory'), null);
  });

  // ---- daysToFull ----

  const s = (day, free) => ({ day, bytes_free: free });

  check('a steadily filling disk reports a finite runway', () => {
    const samples = [s('2026-08-11', 5e9), s('2026-08-17', 2e9)];   // -500MB/day
    assert.strictEqual(Math.round(daysToFull(samples, 2e9)), 4);
  });

  // The interesting direction: a disk that is being CLEANED must not report a
  // negative or absurd runway, which would read as an emergency.
  check('a disk that is emptying reports no runway rather than a negative one', () => {
    assert.strictEqual(daysToFull([s('2026-08-11', 2e9), s('2026-08-17', 5e9)], 5e9), null);
  });

  check('a flat disk reports no runway', () => {
    assert.strictEqual(daysToFull([s('2026-08-11', 3e9), s('2026-08-17', 3e9)], 3e9), null);
  });

  // Two samples an hour apart would divide by ~0 and report a runway of minutes.
  check('samples spanning less than a day are not enough to extrapolate', () => {
    assert.strictEqual(daysToFull([s('2026-08-17', 3e9), s('2026-08-17', 2.9e9)], 2.9e9), null);
  });

  check('a single sample is not enough to extrapolate', () => {
    assert.strictEqual(daysToFull([s('2026-08-17', 3e9)], 3e9), null);
  });

  // ---- assessDisk ----

  const healthy = { bytes: { total: 9065864 * 1024, free: 4035300 * 1024 },
                    inodes: { total: 1179648, free: 1016883 } };

  check('the droplet as measured on 2026-08-17 is healthy', () => {
    const a = assessDisk(Object.assign({ samples: [] }, healthy));
    assert.deepStrictEqual(a.breaches, [], `expected no breach, got ${JSON.stringify(a.breaches)}`);
    assert.strictEqual(a.pctFree, 45);
  });

  check('a low percentage of free bytes breaches', () => {
    const a = assessDisk({ bytes: { total: 10e9, free: 0.5e9 }, inodes: { total: 100, free: 90 }, samples: [] });
    assert.ok(a.breaches.some(b => /bytes/i.test(b)), JSON.stringify(a.breaches));
  });

  // §3: a real ENOSPC destroyed the Jul 27 spot-check run. Inodes are the half
  // that a percentage-of-bytes check cannot see — thousands of small JPGs exhaust
  // inodes while the byte gauge still looks fine.
  check('inode exhaustion breaches even when bytes look fine', () => {
    const a = assessDisk({ bytes: { total: 10e9, free: 9e9 }, inodes: { total: 1e6, free: 20000 }, samples: [] });
    assert.ok(a.breaches.some(b => /inode/i.test(b)), JSON.stringify(a.breaches));
  });

  check('a healthy disk with a short runway still reports the runway', () => {
    const a = assessDisk(Object.assign({
      samples: [s('2026-08-11', 8e9), s('2026-08-17', 4035300 * 1024)],
    }, healthy));
    assert.deepStrictEqual(a.breaches, [], 'a runway is context, not by itself a breach');
    assert.ok(a.daysToFull > 0, `expected a runway, got ${a.daysToFull}`);
    assert.match(a.detail, /days to full/i);
  });

  check('with no history the detail says so instead of inventing a number', () => {
    const a = assessDisk(Object.assign({ samples: [] }, healthy));
    assert.strictEqual(a.daysToFull, null);
    assert.doesNotMatch(a.detail, /NaN|Infinity/);
  });

  check('the floors are the documented 15% and 1GB', () => {
    assert.strictEqual(FLOOR_PCT, 15);
    assert.strictEqual(FLOOR_BYTES, 1024 * 1024 * 1024);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
