'use strict';

// sold-spend.js — Pluggable Oxylabs spend tally for the sold-match pipeline.
//
// Exposes ONE interface ({ reserveCall, spent, remaining, backend }) with TWO
// implementations:
//   - DB-backed (makeDbTally): an ATOMIC increment
//       UPDATE sold_spend SET calls = calls + 1 WHERE spend_key = $1 AND calls < $2 RETURNING calls
//     The `calls < $2` guard makes the ceiling check and the increment a single
//     statement — there is no read-then-write window, so concurrent Phase-17
//     drivers cannot both pass the ceiling. A zero-row RETURNING result means the
//     ceiling was hit. This CLOSES CR-01 (the non-atomic _spend.json
//     read-modify-write race at lib/sold-transport.js:90-102).
//   - File-backed (makeFileTally): the retained _spend.json counter (same
//     { liveCalls } shape and SPEND_FILE default) for offline / no-DB runs
//     (recon, smoke, verf-soldspike dumps). The load->check->++->save sequence is
//     acceptable on this single-process offline path.
//
// CeilingError (code: 'OXY_CEILING') is defined ONCE here and thrown by BOTH
// backends, so every existing catch site (15-04/15-05) keeps matching on
// `e instanceof CeilingError` / `e.code === 'OXY_CEILING'`.
//
// All SQL values are bound via $1,$2 placeholders — never string-interpolated
// (T-16-11). This module never opens its own DB connection; the DB backend
// receives a connected client (T-16-12).

const fs = require('fs');

class CeilingError extends Error {
  constructor(msg) { super(msg); this.code = 'OXY_CEILING'; }
}

// ---------------------------------------------------------------
// (a) DB-backed tally — atomic seed-then-increment.
// ---------------------------------------------------------------
function makeDbTally(client, { spendKey, max }) {
  let seeded = false;
  async function ensureSeed() {
    if (seeded) return;
    await client.query(
      `INSERT INTO sold_spend (spend_key, calls) VALUES ($1, 0)
       ON CONFLICT (spend_key) DO NOTHING`,
      [spendKey],
    );
    seeded = true;
  }
  return {
    async reserveCall() {
      await ensureSeed();
      const r = await client.query(
        `UPDATE sold_spend SET calls = calls + 1, updated_at = NOW()
          WHERE spend_key = $1 AND calls < $2
          RETURNING calls`,
        [spendKey, max],
      );
      if (r.rows.length === 0) {
        throw new CeilingError(`Oxylabs ceiling reached: ${max}/${max} live calls — refusing new fetch`);
      }
      return r.rows[0].calls;
    },
    async spent() {
      const r = await client.query(`SELECT calls FROM sold_spend WHERE spend_key = $1`, [spendKey]);
      return r.rows.length ? r.rows[0].calls : 0;
    },
    async remaining() { return Math.max(0, max - (await this.spent())); },
    backend: 'db',
  };
}

// ---------------------------------------------------------------
// (b) File-backed tally — retained _spend.json counter (offline fallback).
// ---------------------------------------------------------------
function makeFileTally({ spendFile, max }) {
  function load() {
    try { return JSON.parse(fs.readFileSync(spendFile, 'utf8')); }
    catch (_) { return { liveCalls: 0 }; }
  }
  function save(s) { fs.writeFileSync(spendFile, JSON.stringify(s)); }
  return {
    async reserveCall() {
      const s = load();
      if (s.liveCalls >= max) {
        throw new CeilingError(`Oxylabs ceiling reached: ${s.liveCalls}/${max} live calls — refusing new fetch`);
      }
      s.liveCalls += 1; save(s);
      return s.liveCalls;
    },
    async spent() { return load().liveCalls; },
    async remaining() { return Math.max(0, max - load().liveCalls); },
    backend: 'file',
  };
}

// ---------------------------------------------------------------
// (c) Factory — client present => DB tally, else => file tally.
// ---------------------------------------------------------------
function makeSpendTally(opts = {}) {
  const max = opts.max != null ? opts.max : parseInt(process.env.MAX_OXY_CALLS || '4000', 10);
  const spendKey = opts.spendKey || process.env.SOLD_SPEND_KEY || 'sold-global';
  if (opts.client) {
    return makeDbTally(opts.client, { spendKey, max });
  }
  return makeFileTally({ spendFile: opts.spendFile, max });
}

module.exports = { CeilingError, makeSpendTally, makeDbTally, makeFileTally };

// ---------------------------------------------------------------
// --smoke self-test (no DB, no network).
//   node lib/sold-spend.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const os = require('os');
  const path = require('path');
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  (async () => {
    // 1. Exports present.
    check('exports: CeilingError/makeSpendTally/makeDbTally/makeFileTally', () => {
      assert.strictEqual(typeof CeilingError, 'function');
      assert.strictEqual(typeof makeSpendTally, 'function');
      assert.strictEqual(typeof makeDbTally, 'function');
      assert.strictEqual(typeof makeFileTally, 'function');
    });

    // 2. Factory selects backend by client presence.
    check('makeSpendTally: client => db, none => file', () => {
      const dbT = makeSpendTally({ client: { query: async () => ({ rows: [] }) }, spendKey: 'k', max: 5 });
      const fileT = makeSpendTally({ spendFile: path.join(os.tmpdir(), 'sold-spend-smoke-x.json'), max: 5 });
      assert.strictEqual(dbT.backend, 'db');
      assert.strictEqual(fileT.backend, 'file');
    });

    // 3. DB reserveCall success: seed INSERT issued BEFORE the UPDATE; returns calls.
    await checkAsync('db reserveCall: seeds then increments, returns calls', async () => {
      const calls = [];
      const mockClient = {
        query: async (sql) => {
          calls.push(sql.trim());
          if (sql.includes('UPDATE sold_spend')) return { rows: [{ calls: 1 }] };
          return { rows: [] };
        },
      };
      const t = makeDbTally(mockClient, { spendKey: 'sold-global', max: 4000 });
      const n = await t.reserveCall();
      assert.strictEqual(n, 1, `expected 1, got ${n}`);
      assert.ok(calls[0].includes('INSERT INTO sold_spend') && calls[0].includes('ON CONFLICT (spend_key) DO NOTHING'),
        `calls[0] should be the seed INSERT, got: ${calls[0]}`);
      assert.ok(calls[1].includes('UPDATE sold_spend') && calls[1].includes('calls = calls + 1'),
        `calls[1] should be the atomic UPDATE, got: ${calls[1]}`);
    });

    // 4. DB reserveCall ceiling: zero-row UPDATE => CeilingError code OXY_CEILING.
    await checkAsync('db reserveCall: zero-row UPDATE throws CeilingError OXY_CEILING', async () => {
      const mockClient = {
        query: async (sql) => {
          if (sql.includes('UPDATE sold_spend')) return { rows: [] };
          return { rows: [] };
        },
      };
      const t = makeDbTally(mockClient, { spendKey: 'sold-global', max: 4000 });
      let err = null;
      try { await t.reserveCall(); } catch (e) { err = e; }
      assert.ok(err instanceof CeilingError, `expected CeilingError, got ${err}`);
      assert.strictEqual(err.code, 'OXY_CEILING');
    });

    // 5. File reserveCall: max=1 => first returns 1, second throws CeilingError.
    await checkAsync('file reserveCall: ceiling at max=1 throws on 2nd', async () => {
      const tmp = path.join(os.tmpdir(), `sold-spend-smoke-${process.pid}-${Date.now()}.json`);
      try {
        const t = makeFileTally({ spendFile: tmp, max: 1 });
        const first = await t.reserveCall();
        assert.strictEqual(first, 1, `expected 1, got ${first}`);
        let err = null;
        try { await t.reserveCall(); } catch (e) { err = e; }
        assert.ok(err instanceof CeilingError, `expected CeilingError, got ${err}`);
        assert.strictEqual(err.code, 'OXY_CEILING');
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    });

    // 6. DB spent(): SELECT returns calls.
    await checkAsync('db spent(): returns SELECTed calls', async () => {
      const mockClient = { query: async () => ({ rows: [{ calls: 7 }] }) };
      const t = makeDbTally(mockClient, { spendKey: 'sold-global', max: 4000 });
      const s = await t.spent();
      assert.strictEqual(s, 7, `expected 7, got ${s}`);
    });

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((err) => {
    console.error(`SMOKE FAIL [uncaught]: ${err && err.message}`);
    process.exit(1);
  });
}
