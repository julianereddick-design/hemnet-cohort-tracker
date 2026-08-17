'use strict';

// lib/job-cron.js
//
// "When SHOULD this job have last fired?" — the question every assertion is
// phrased against. Assertions must never be phrased against a calendar period:
// the digest runs at 03:00 UTC, so "a market_totals row for today" would fail
// every single day for a job that fires at 08:30.
//
// TIMEZONE: cron on the droplet runs in UTC (confirmed — the health report
// timestamps are UTC). All arithmetic here is UTC.
//
// NOTE on `*/2` in the day-of-month field: cron expands it over the field's
// range, so it means the ODD days 1,3,...,31 — NOT "every 48 hours". After the
// 31st the next fire is the 1st, a ONE-day gap.
//
//   node lib/job-cron.js --smoke

function expandField(field, min, max) {
  if (field === '*') return null;                       // null = unrestricted
  const out = new Set();
  for (const part of field.split(',')) {
    const step = part.includes('/') ? parseInt(part.split('/')[1], 10) : 1;
    const range = part.split('/')[0];
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = hi = parseInt(range, 10); if (step > 1) hi = max; }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function parseCron(spec) {
  const f = String(spec).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${spec}" does not have 5 fields`);
  return {
    minutes: expandField(f[0], 0, 59) || Array.from({ length: 60 }, (_, i) => i),
    hours: expandField(f[1], 0, 23) || Array.from({ length: 24 }, (_, i) => i),
    doms: expandField(f[2], 1, 31),
    months: expandField(f[3], 1, 12),
    dows: expandField(f[4], 0, 6),
  };
}

// Standard cron semantics: when BOTH day-of-month and day-of-week are
// restricted, a day matches if EITHER matches. When one is '*', it is ignored.
function dayMatches(d, p) {
  if (p.months && !p.months.includes(d.getUTCMonth() + 1)) return false;
  const domOk = p.doms ? p.doms.includes(d.getUTCDate()) : null;
  const dowOk = p.dows ? p.dows.includes(d.getUTCDay()) : null;
  if (domOk === null && dowOk === null) return true;
  if (domOk === null) return dowOk;
  if (dowOk === null) return domOk;
  return domOk || dowOk;
}

function lastExpectedFire(spec, now) {
  const p = parseCron(spec);
  const hours = [...p.hours].sort((a, b) => b - a);
  const minutes = [...p.minutes].sort((a, b) => b - a);
  for (let back = 0; back <= 400; back++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    if (!dayMatches(day, p)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
        if (t <= now) return t;
      }
    }
  }
  return null;
}

module.exports = { parseCron, lastExpectedFire, expandField, dayMatches };

// ---------------------------------------------------------------
//   node lib/job-cron.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { parseCron, lastExpectedFire } = module.exports;
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };
  const iso = (d) => (d ? d.toISOString().slice(0, 16) + 'Z' : null);

  check('parseCron: field types', () => {
    const p = parseCron('30 8 * * *');
    assert.deepStrictEqual(p.minutes, [30]);
    assert.deepStrictEqual(p.hours, [8]);
    assert.strictEqual(p.doms, null, '* must mean unrestricted, not every value');
    assert.strictEqual(p.dows, null);
  });

  check('parseCron: */2 in day-of-month expands to odd days', () => {
    const p = parseCron('0 22 */2 * *');
    assert.deepStrictEqual(p.doms.slice(0, 4), [1, 3, 5, 7]);
    assert.strictEqual(p.doms[p.doms.length - 1], 31);
  });

  // THE trap. The digest runs at 03:00; market-totals-daily fires at 08:30.
  // "a row for today" would fail every single day.
  check('daily job at 03:00 resolves to YESTERDAY 08:30, not today', () => {
    const now = new Date('2026-08-17T03:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('30 8 * * *', now)), '2026-08-16T08:30Z');
  });

  check('daily job just after its fire resolves to today', () => {
    const now = new Date('2026-08-17T09:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('30 8 * * *', now)), '2026-08-17T08:30Z');
  });

  check('weekly Monday job at Monday 03:00 resolves to LAST Monday', () => {
    const now = new Date('2026-08-17T03:00:00Z'); // a Monday
    assert.strictEqual(iso(lastExpectedFire('0 6 * * 1', now)), '2026-08-10T06:00Z');
  });

  check('weekly Monday job later that Monday resolves to today', () => {
    const now = new Date('2026-08-17T07:00:00Z');
    assert.strictEqual(iso(lastExpectedFire('0 6 * * 1', now)), '2026-08-17T06:00Z');
  });

  check('weekly Sunday job (dow=0)', () => {
    const now = new Date('2026-08-17T03:00:00Z'); // Monday
    assert.strictEqual(iso(lastExpectedFire('0 22 * * 0', now)), '2026-08-16T22:00Z');
  });

  // Monthly on the 1st: at 03:00 on the 1st it HAS fired (02:00); at 01:00 it has not.
  check('monthly job after its fire on the 1st', () => {
    assert.strictEqual(iso(lastExpectedFire('0 2 1 * *', new Date('2026-09-01T03:00:00Z'))), '2026-09-01T02:00Z');
  });

  check('monthly job before its fire on the 1st resolves to the previous month', () => {
    assert.strictEqual(iso(lastExpectedFire('0 2 1 * *', new Date('2026-09-01T01:00:00Z'))), '2026-08-01T02:00Z');
  });

  check('every-2-days job on an even day resolves to the previous odd day', () => {
    // 2026-08-16 is even, so the last fire was the 15th at 22:00.
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-16T12:00:00Z'))), '2026-08-15T22:00Z');
  });

  check('every-2-days job on an odd day before 22:00 resolves to the previous odd day', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-17T12:00:00Z'))), '2026-08-15T22:00Z');
  });

  check('every-2-days job on an odd day after 22:00 resolves to today', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-08-17T23:00:00Z'))), '2026-08-17T22:00Z');
  });

  // The 31st->1st wrap: */2 is odd-days-of-month, so Sep 1 follows Aug 31 with a
  // ONE day gap, not two. A window sized on "every 48h" would be wrong here.
  check('every-2-days wraps 31st -> 1st with a one-day gap', () => {
    assert.strictEqual(iso(lastExpectedFire('0 22 */2 * *', new Date('2026-09-01T12:00:00Z'))), '2026-08-31T22:00Z');
  });

  check('every registry cron parses and resolves', () => {
    const { JOBS } = require('./job-registry');
    const now = new Date('2026-08-17T03:00:00Z');
    for (const [job, rec] of Object.entries(JOBS)) {
      if (!rec.cron) continue;
      const t = lastExpectedFire(rec.cron, now);
      assert.ok(t instanceof Date, `${job} (${rec.cron}) did not resolve to a Date`);
      assert.ok(t <= now, `${job} resolved to a FUTURE time ${iso(t)}`);
    }
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
