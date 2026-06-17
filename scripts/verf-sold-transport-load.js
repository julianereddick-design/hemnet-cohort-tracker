'use strict';

// verf-sold-transport-load.js — committed, re-runnable load probe confirming
// lib/sold-transport.js loads and exposes its full export surface with NO DB
// (offline recon / smoke / verf-soldspike dumps must keep working after the
// pluggable-tally wiring of 16-03). Run:
//   SCRAPE_FORCE_OXYLABS=1 node scripts/verf-sold-transport-load.js

process.env.SCRAPE_FORCE_OXYLABS = '1';
const t = require('../lib/sold-transport');
const need = ['setSpendClient', 'cachedFetch', 'CeilingError', 'spentCalls', 'remainingCalls', 'spentCallsAsync', 'remainingCallsAsync'];
for (const k of need) {
  if (typeof t[k] !== 'function') { console.error('MISSING export:', k); process.exit(1); }
}
console.log('load OK no-DB');
process.exit(0);
