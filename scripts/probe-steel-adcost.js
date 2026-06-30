#!/usr/bin/env node
/*
 * Phase 26 — Steel.dev hosted-scraping-browser validation probe.
 *
 * Proves the ad-cost capture works through a residential/managed-egress browser:
 *   1. Open a Steel session with residential proxy + CAPTCHA solving.
 *   2. Drive a real (remote) Chromium that should clear Hemnet's Cloudflare from
 *      Steel's residential IP (our droplet's datacenter IP gets a 403 — see
 *      26-DROPLET-CHROMIUM-TEST.md).
 *   3. Load hemnet.se/priser, fill the calculator (kommun + asking price), and
 *      read the Bas/Plus/Premium/Max ad-package prices — same data the disabled
 *      droplet task search_ad_cost_2 fetches via GraphQL.
 *   4. Opportunistically capture the SellerMarketingProductPrices GraphQL POST
 *      body (anonymous session — no user auth) so we have the exact query for a
 *      production in-page-fetch implementation.
 *
 * Usage:
 *   STEEL_API_KEY=sk_... node scripts/probe-steel-adcost.js
 * Optional overrides:
 *   PROBE_KOMMUN="Göteborg"  PROBE_PRICE="5000000"
 *
 * Deps (install without polluting package.json):
 *   npm install --no-save steel-sdk playwright-core
 *
 * Exit codes: 0 cleared+captured, 3 cleared-no-prices, 4 cloudflare-blocked,
 *   2 misconfig, 5 error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Load STEEL_API_KEY from the gitignored .env without echoing it anywhere.
function envFromDotenv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => l.replace(/^\s*export\s+/, '').startsWith(key + '='));
    if (!line) return undefined;
    let v = line.slice(line.indexOf('=') + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  } catch (_) { return undefined; }
}

const STEEL_API_KEY = envFromDotenv('STEEL_API_KEY');
const KOMMUN = process.env.PROBE_KOMMUN || 'Göteborg';
const PRICE = process.env.PROBE_PRICE || '5000000';

function loadSteel() {
  const m = require('steel-sdk');
  return m && (m.default || m.Steel || m);
}

async function main() {
  if (!STEEL_API_KEY) {
    console.error('FATAL: STEEL_API_KEY not set. Get one at https://app.steel.dev/settings/api-keys');
    process.exit(2);
  }
  const Steel = loadSteel();
  const { chromium } = require('playwright-core');
  const client = new Steel({ steelAPIKey: STEEL_API_KEY });

  let session, browser, page;
  const gqlBodies = [];
  let exitCode = 5;
  try {
    const noProxy = process.env.PROBE_NO_PROXY === '1';
    const CLEAR_RE = /Räkna ut priset|Gata eller kommun|Skriv område|Utgångspris/i;
    const BLOCK_RE = /just a moment|checking your browser|cf-chl|attention required|enable javascript and cookies|verifying you are human/i;
    const MAX_ATTEMPTS = noProxy ? 1 : 5;
    let cleared = false;

    // Cloudflare bypass is probabilistic per residential IP — retry with a fresh
    // session/IP on block (this is the production pattern too).
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cleared; attempt++) {
      console.log(`\n=== Attempt ${attempt}/${MAX_ATTEMPTS}: new Steel session${noProxy ? ' (NO proxy — free check)' : ' (residential proxy + solveCaptcha)'} ===`);
      session = await client.sessions.create(noProxy
        ? { sessionTimeout: 300000 }
        : { useProxy: true, solveCaptcha: true, sessionTimeout: 300000 });
      console.log('session.id =', session.id, session.sessionViewerUrl ? '| viewer ' + session.sessionViewerUrl : '');
      browser = await chromium.connectOverCDP(`${session.websocketUrl}&apiKey=${STEEL_API_KEY}`);
      const ctx = browser.contexts()[0];
      page = (ctx.pages()[0]) || (await ctx.newPage());
      page.on('request', (req) => {
        try {
          if (req.method() === 'POST' && req.url().includes('/graphql')) {
            const pd = req.postData() || '';
            if (/SellerMarketingProductPrices|AutocompleteLocations/.test(pd)) gqlBodies.push(pd.slice(0, 3000));
          }
        } catch (_) {}
      });
      console.log('Navigating to https://www.hemnet.se/priser …');
      await page.goto('https://www.hemnet.se/priser', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('  goto:', e.message));
      for (let i = 0; i < 16; i++) { // ~48s per attempt
        await page.waitForTimeout(3000);
        const st = await page.evaluate(() => ({
          title: document.title,
          body: document.body ? document.body.innerText.slice(0, 4000) : '',
          hasForm: !!document.querySelector('#location') && !!document.querySelector('#text-input-askingPrice'),
        })).catch(() => ({ title: '', body: '', hasForm: false }));
        const isBlock = BLOCK_RE.test(st.title) || BLOCK_RE.test(st.body.slice(0, 600));
        const cfClear = CLEAR_RE.test(st.body) || (/^Priser/i.test(st.title) && st.body.length > 200 && !isBlock);
        const isClear = cfClear && st.hasForm; // only proceed once the form has hydrated
        if (i % 3 === 0 || isClear) console.log(`  [a${attempt} t+${(i + 1) * 3}s] title=${JSON.stringify(st.title).slice(0, 26)} blocked=${isBlock} cfClear=${cfClear} form=${st.hasForm}`);
        if (isClear) { cleared = true; break; }
      }
      if (cleared) { console.log(`Cloudflare CLEARED via Steel residential egress (attempt ${attempt}). Driving the calculator…`); break; }
      console.log(`  attempt ${attempt} still challenged; ${attempt < MAX_ATTEMPTS ? 'retrying with a fresh residential IP…' : 'no clear.'}`);
      try { if (browser) await browser.close(); } catch (_) {}
      try { if (session) await client.sessions.release(session.id); } catch (_) {}
      browser = null; session = null;
    }

    if (!cleared) {
      console.log(`VERDICT: STEEL_BLOCKED_CF — challenged on all ${MAX_ATTEMPTS} attempts (CF clears intermittently; raise attempts or try Bright Data)`);
      exitCode = 4;
      return;
    }
    console.log('Cloudflare cleared via Steel residential egress. Driving the calculator…');

    // Cookie consent: Hemnet uses Usercentrics (shadow-DOM CMP #usercentrics-cmp-ui)
    // that intercepts pointer events. Deny non-essential via its API (privacy-preserving),
    // and remove the overlay node so it can't block form clicks.
    const consent = await page.evaluate(() => {
      try {
        if (window.UC_UI) {
          if (window.UC_UI.denyAllConsents) window.UC_UI.denyAllConsents();
          if (window.UC_UI.closeCMP) window.UC_UI.closeCMP();
        }
      } catch (_) {}
      const el = document.querySelector('#usercentrics-cmp-ui, #usercentrics-root');
      if (el) { el.remove(); return 'removed-overlay'; }
      return 'no-overlay';
    }).catch(() => 'consent-err');
    console.log('  cookie consent:', consent);
    await page.waitForTimeout(600);

    // Diagnostic: enumerate form controls so selectors can be targeted reliably.
    const controls = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input,button,[role="combobox"]'));
      return els.slice(0, 30).map((e) => ({
        tag: e.tagName, type: e.type || '', role: e.getAttribute('role') || '',
        ph: e.getAttribute('placeholder') || '', aria: e.getAttribute('aria-label') || '',
        id: (e.id || '').slice(0, 40), inputmode: e.getAttribute('inputmode') || '',
        txt: ((e.innerText || e.value || '') + '').slice(0, 30),
      }));
    }).catch(() => []);
    console.log('FORM_CONTROLS =', JSON.stringify(controls));

    // The Usercentrics CMP can inject late and intercept pointer events. Defeat it
    // repeatedly, and drive fields via JS-focus + keyboard typing (no pointer click).
    const killOverlay = () => page.evaluate(() => {
      try { if (window.UC_UI && window.UC_UI.denyAllConsents) window.UC_UI.denyAllConsents(); } catch (_) {}
      document.querySelectorAll('#usercentrics-cmp-ui, #usercentrics-root, [id*="usercentrics" i]').forEach((el) => el.remove());
    }).catch(() => {});

    // Location (react-select #location): force-click to focus, type into the element
    // directly (pressSequentially), wait for the menu, Enter commits the exact match.
    await killOverlay();
    const locEl = page.locator('#location').first();
    await locEl.click({ force: true, timeout: 15000 });
    await locEl.pressSequentially(KOMMUN, { delay: 120 });
    await page.waitForTimeout(2800);
    await locEl.press('Enter');
    await page.waitForTimeout(1200);
    const locVal = await locEl.inputValue().catch(() => '');
    console.log('  location committed =', JSON.stringify(locVal) || '(empty)');

    // Asking price (#text-input-askingPrice): set via the React-native value setter so the
    // controlled input registers it, then dispatch input/change to fire the price query.
    await killOverlay();
    await page.locator('#text-input-askingPrice').evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PRICE);
    await page.waitForTimeout(600);
    const priceSet = await page.locator('#text-input-askingPrice').inputValue().catch(() => '');
    console.log('  askingPrice field =', JSON.stringify(priceSet));

    // Calculate (force-click in case the CMP overlay re-appeared).
    await killOverlay();
    await page.getByRole('button', { name: /Beräkna pris/i }).first().click({ force: true, timeout: 8000 });
    await page.waitForTimeout(5000);

    const finalText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const out = {};
    for (const pkg of ['Bas', 'Plus', 'Premium', 'Max']) {
      const m = new RegExp("(?:Hemnet\\s+)?" + pkg + "[\\s\\S]{0,80}?fr(?:ån|\\.)?\\s*([0-9\\u00a0 ]+kr)", 'i').exec(finalText);
      if (m) out[pkg] = m[1].replace(/[ \s]+/g, ' ').trim();
    }
    const got = Object.keys(out).length >= 3;
    console.log('PRICES =', JSON.stringify(out));
    const priceQ = gqlBodies.find((b) => /SellerMarketingProductPrices/.test(b));
    const autoN = gqlBodies.filter((b) => /AutocompleteLocations/i.test(b)).length;
    console.log(`GQL_CAPTURED: ${autoN} autocomplete + ${priceQ ? 1 : 0} SellerMarketingProductPrices`);
    if (priceQ) console.log('PRICE_QUERY (for production in-page fetch):\n' + priceQ.slice(0, 2500));
    if (got) {
      console.log('VERDICT: STEEL_WORKS — Cloudflare cleared + ad-cost prices captured via hosted residential browser');
      exitCode = 0;
    } else {
      console.log('VERDICT: STEEL_CLEARED_BUT_NO_PRICES — CF passed but form/selectors need tuning. Body sample below:');
      console.log(finalText.slice(0, 1500));
      exitCode = 3;
    }
  } catch (e) {
    console.error('ERROR:', (e && e.message) || e);
    console.log('VERDICT: STEEL_PROBE_ERROR');
    exitCode = 5;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { if (session) await client.sessions.release(session.id); } catch (_) {}
    console.log('session released.');
    process.exit(exitCode);
  }
}

main();
