'use strict';
process.env.SCRAPE_FORCE_OXYLABS = '1';
require('dotenv').config();

// scripts/hemnet-ad-sweep.js — the weekly walk of EVERY live Hemnet ad (for sale and coming
// soon) into the ad registry (lib/ad-registry.js). Companion to scripts/hemnet-ad-daily.js.
//
// It reuses the age census's walker (scripts/hemnet-forsale-age-census.js run({ onCards })):
// municipality partition, sub-partitioned past Hemnet's 2,500-result limit, every page's
// filters checked, and the reconciliation / coverage / error-page gates. Each pool is written
// to the registry the moment it finishes, so a failure in the second pool keeps the first.
//
// Only when BOTH pools pass their gates are unseen ads marked gone (sold, withdrawn or
// expired); a walk with a hole in it would otherwise mark a whole municipality gone.
//
// Cron: Sunday 00:30 UTC (lib/job-registry.js 'hemnet-ad-sweep'), ~2-3h. Cost ~2,500 Oxylabs
// calls a week (census measurement 2026-11-01: for sale 1,652, coming soon 833).
//
//   node scripts/hemnet-ad-sweep.js --smoke    # offline self-test (no DB, no network)
//   node scripts/hemnet-ad-sweep.js            # live sweep into the registry

const POOLS = ['forsale', 'premarket'];
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// Orchestration with every side effect injected, so --smoke drives it offline.
//   walkPool({ pool, onCards, priorMuniSizes }) -> census result (status 'ok' | 'gate_failed')
//   persist(cards)  -> applyCards result     markGone() -> rows marked gone
//   priorMuniSizes(pool) -> { muni: n } | null
async function orchestrate({ walkPool, persist, markGone, priorMuniSizes = async () => null, logger = () => {} }) {
  const seen = new Map();
  const out = { pools: [], cardsSeen: 0, newAds: 0, changed: 0, upgrades: 0, headlineTotal: 0, oxCalls: 0, goneAds: null, failed: [], gateFailed: [], notes: [] };
  for (const pool of POOLS) {
    const cards = new Map();
    try {
      logger('INFO', `=== ${pool} — starting ===`);
      const res = await walkPool({ pool, priorMuniSizes: await priorMuniSizes(pool), onCards: (cs) => { for (const c of cs) cards.set(String(c.id), c); } });
      const applied = await persist([...cards.values()]);
      for (const [id, c] of cards) seen.set(id, c);
      out.cardsSeen += applied.cards;
      out.newAds += applied.newAds;
      out.changed += applied.changed;
      out.upgrades += applied.upgrades;
      out.oxCalls += res.oxCalls || 0;
      const headline = (res.muni || []).reduce((a, m) => a + (m.headlineN || 0), 0);
      out.headlineTotal += headline;
      out.pools.push({ pool, status: res.status, distinct: cards.size, headline, oxCalls: res.oxCalls, notes: res.notes || null });
      if (res.status !== 'ok') { out.gateFailed.push(pool); out.notes.push(`${pool} failed its completeness checks: ${res.notes || ''}`); }
      logger('INFO', `${pool}: ${cards.size} ads (Hemnet says ${headline}), status ${res.status}`);
    } catch (e) {
      // Whatever the walk collected before it threw is still real; keep it.
      if (cards.size) {
        try { await persist([...cards.values()]); for (const [id, c] of cards) seen.set(id, c); } catch (_) { /* reported below */ }
      }
      out.failed.push(pool);
      out.pools.push({ pool, status: 'failed', distinct: cards.size, error: e.message });
      out.notes.push(`${pool} failed: ${e.message}`);
      logger('ERROR', `${pool} FAILED: ${e.message} — continuing`);
    }
  }
  out.distinct = seen.size;
  out.seen = seen;
  if (out.failed.length === 0 && out.gateFailed.length === 0) {
    out.goneAds = await markGone();
  } else {
    out.notes.push('gone ads not marked this week (the walk was incomplete)');
  }
  out.status = out.failed.length ? 'failed' : (out.gateFailed.length ? 'warning' : 'ok');
  return out;
}

async function main(_client, logger = (l, m) => console.log(`  [${l}] ${m}`)) {
  const { createClient } = require('../db');
  const registry = require('../lib/ad-registry');
  const census = require('./hemnet-forsale-age-census');
  const { getPriorMuniSizes } = require('../age-census-store');
  const startedAt = new Date();
  const runDate = isoDay(startedAt);
  // One short-lived connection per write: the sweep runs for hours, and an idle connection
  // held that long is the census's documented failure mode.
  const withClient = async (fn) => {
    const c = createClient();
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };

  const out = await orchestrate({
    walkPool: ({ pool, onCards, priorMuniSizes }) => census.run({ pool, onCards, priorMuniSizes, logger }),
    persist: (cards) => withClient(c => registry.applyCards(c, cards, { seenOn: runDate, source: 'weekly' })),
    markGone: () => withClient(c => registry.markGone(c, { sweepDate: runDate })),
    priorMuniSizes: (pool) => withClient(c => getPriorMuniSizes(c, { platform: 'hemnet', pool, runDate })).catch(() => null),
    logger,
  });

  const rows = [...out.seen.values()].map(c => registry.shapeCard(c, runDate));
  const counts = registry.tierCounts(rows);
  await withClient(c => registry.recordRun(c, {
    kind: 'weekly', runDate, status: out.status, cardsSeen: out.cardsSeen, distinct: out.distinct,
    headlineTotal: out.headlineTotal, newAds: out.newAds, changed: out.changed, upgrades: out.upgrades,
    goneAds: out.goneAds, pages: 0, oxCalls: out.oxCalls, counts, notes: out.notes.join('; ') || null, startedAt,
  }));
  delete out.seen;
  return { runDate, ...out, counts };
}

function validate(s) {
  if (!s) return 'no summary returned';
  if (s.failed.length) return { severity: 'failure', message: `pools failed: ${s.failed.join(', ')}` };
  if (s.gateFailed.length) return `pools failed completeness checks: ${s.gateFailed.join(', ')} — gone ads not marked`;
  return null;
}

module.exports = { orchestrate, validate, main, POOLS };

const ACCEPTED_ARGV = new Set(['--smoke']);
const USAGE = 'Usage: node scripts/hemnet-ad-sweep.js [--smoke]';

if (require.main === module) {
  const argv = process.argv.slice(2);
  const bad = argv.filter(a => !ACCEPTED_ARGV.has(a));
  if (bad.length) {
    console.error(`Unrecognised argument(s): ${bad.join(' ')}\n${USAGE}`);
    process.exit(1);
  } else if (argv.includes('--smoke')) {
    smoke();
  } else {
    const { runJob } = require('../cron-wrapper');
    runJob({ scriptName: 'hemnet-ad-sweep', main: (client, log) => main(client, log), validate });
  }
}

async function smoke() {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; } };
  const card = (id, upcoming, pkg) => ({ id, upcoming, activePackage: pkg });
  const fakeWalk = (byPool) => async ({ pool, onCards }) => {
    const spec = byPool[pool];
    if (spec.throwAfter) { onCards(spec.cards); throw new Error(spec.throwAfter); }
    onCards(spec.cards); onCards(spec.cards.slice(0, 1)); // duplicates across scopes are normal
    return { status: spec.status || 'ok', oxCalls: 10, muni: [{ headlineN: spec.cards.length }], notes: spec.notes };
  };
  const persisted = [];
  const persist = async (cards) => { persisted.push(cards.length); return { cards: cards.length, distinct: cards.length, newAds: cards.length, changed: 0, upgrades: 0 }; };

  await check('both pools clean: everything persisted, gone ads marked, status ok', async () => {
    persisted.length = 0;
    let gone = false;
    const out = await orchestrate({
      walkPool: fakeWalk({ forsale: { cards: [card(1, false, 'PLUS'), card(2, false, 'AGGREGATED')] }, premarket: { cards: [card(3, true, 'MINIMAL')] } }),
      persist, markGone: async () => { gone = true; return 7; },
    });
    assert.deepStrictEqual(persisted, [2, 1], 'each pool persisted once, deduped');
    assert.ok(gone);
    assert.strictEqual(out.goneAds, 7);
    assert.strictEqual(out.distinct, 3);
    assert.strictEqual(out.headlineTotal, 3);
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(validate(out), null);
  });
  await check('a gate failure keeps the data but does not mark anything gone', async () => {
    let gone = false;
    const out = await orchestrate({
      walkPool: fakeWalk({ forsale: { cards: [card(1, false, 'PLUS')], status: 'gate_failed', notes: 'reconciliation 4%' }, premarket: { cards: [card(3, true, 'MINIMAL')] } }),
      persist, markGone: async () => { gone = true; return 1; },
    });
    assert.ok(!gone);
    assert.strictEqual(out.goneAds, null);
    assert.strictEqual(out.status, 'warning');
    assert.match(validate(out), /completeness/);
  });
  await check('a pool that throws keeps what it read, the other pool still runs, run fails', async () => {
    persisted.length = 0;
    let gone = false;
    const out = await orchestrate({
      walkPool: fakeWalk({ forsale: { cards: [card(1, false, 'PLUS'), card(2, false, 'BASIC')], throwAfter: 'Oxylabs 613' }, premarket: { cards: [card(3, true, 'MINIMAL')] } }),
      persist, markGone: async () => { gone = true; return 1; },
    });
    assert.deepStrictEqual(persisted, [2, 1], 'the partial pool was still written');
    assert.ok(!gone);
    assert.strictEqual(out.status, 'failed');
    assert.strictEqual(validate(out).severity, 'failure');
  });
  console.log(`smoke: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}
