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

  let session, browser;
  const gqlBodies = [];
  let exitCode = 5;
  try {
    const noProxy = process.env.PROBE_NO_PROXY === '1';
    console.log('Creating Steel session' + (noProxy ? ' (NO proxy/captcha — free pipeline check)…' : ' (useProxy + solveCaptcha)…'));
    session = await client.sessions.create(noProxy ? {
      sessionTimeout: 300000,
    } : {
      useProxy: true,        // residential proxy — the residential egress we need
      solveCaptcha: true,    // managed anti-bot / Cloudflare / Turnstile
      sessionTimeout: 300000,
    });
    console.log('session.id =', session.id);
    if (session.sessionViewerUrl) console.log('live viewer:', session.sessionViewerUrl);

    browser = await chromium.connectOverCDP(`${session.websocketUrl}&apiKey=${STEEL_API_KEY}`);
    const ctx = browser.contexts()[0];
    const page = (ctx.pages()[0]) || (await ctx.newPage());

    // Capture the GraphQL POST bodies for production reuse (anonymous session).
    page.on('request', (req) => {
      try {
        if (req.method() === 'POST' && req.url().includes('/graphql')) {
          const pd = req.postData() || '';
          if (/SellerMarketingProductPrices|AutocompleteLocations/.test(pd)) {
            gqlBodies.push(pd.slice(0, 3000));
          }
        }
      } catch (_) {}
    });

    console.log('Navigating to https://www.hemnet.se/priser …');
    await page.goto('https://www.hemnet.se/priser', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const title = await page.title();
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const blocked = /just a moment|checking your browser|cf-chl|attention required|enable javascript and cookies|verifying you are human/i.test(title + '\n' + bodyText.slice(0, 800));
    const cleared = /Räkna ut priset|Gata eller kommun|Skriv område/i.test(bodyText) || /^Priser/i.test(title);
    console.log('TITLE =', JSON.stringify(title));
    console.log('CF_BLOCKED =', blocked, '| CF_CLEARED =', cleared);

    if (blocked && !cleared) {
      console.log('VERDICT: STEEL_BLOCKED_CF — residential session still challenged (try Bright Data, or check solveCaptcha)');
      exitCode = 4;
      return;
    }
    console.log('Cloudflare cleared via Steel residential egress. Driving the calculator…');

    // Cookie consent — prefer the privacy-preserving choice, fall back to proceed.
    try {
      const consentRes = [/Endast nödvändiga/i, /Neka alla/i, /Avvisa/i, /Necessary only/i, /Reject all/i, /Godkänn alla/i, /Acceptera alla/i, /Accept all/i];
      for (const re of consentRes) {
        const btn = page.getByRole('button', { name: re });
        if (await btn.count().catch(() => 0)) { await btn.first().click({ timeout: 3000 }).catch(() => {}); console.log('  cookie banner:', re.source); break; }
      }
    } catch (_) {}

    // Location autocomplete (react-select) — a real browser commits on click/Enter.
    const loc = page.getByPlaceholder(/område eller adress|Gata eller kommun/i).first();
    await loc.click({ timeout: 20000 });
    await loc.fill(KOMMUN);
    await page.waitForTimeout(1800);
    const opt = page.getByText(new RegExp(KOMMUN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*kommun', 'i')).first();
    if (await opt.count().catch(() => 0)) {
      await opt.click({ timeout: 8000 }).catch(async () => { await loc.press('Enter'); });
    } else {
      await loc.press('Enter');
    }
    await page.waitForTimeout(900);

    // Asking price.
    const price = page.getByPlaceholder(/Ex\. *2 *000 *000|2 000 000/i).first();
    await price.click({ timeout: 8000 });
    await price.fill(PRICE);

    // Calculate.
    await page.getByRole('button', { name: /Beräkna pris/i }).first().click({ timeout: 8000 });
    await page.waitForTimeout(4500);

    const finalText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const out = {};
    for (const pkg of ['Bas', 'Plus', 'Premium', 'Max']) {
      const m = new RegExp(pkg + "\\s*\\n?\\s*från\\s*\\n?\\s*([0-9\\u00a0 ]+kr)", 'i').exec(finalText);
      if (m) out[pkg] = m[1].replace(/[ \s]+/g, ' ').trim();
    }
    const got = Object.keys(out).length >= 3;
    console.log('PRICES =', JSON.stringify(out));
    if (gqlBodies.length) {
      console.log('GQL_CAPTURED =', gqlBodies.length, 'request body/bodies (for production in-page fetch):');
      console.log(gqlBodies.join('\n---\n').slice(0, 4000));
    }
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
