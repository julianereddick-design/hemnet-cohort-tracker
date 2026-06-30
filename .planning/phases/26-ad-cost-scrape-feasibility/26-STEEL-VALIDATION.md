VERDICT: STEEL_RESIDENTIAL_CLEARS_CF — hosted scraping browser (Steel.dev) clears Hemnet's Cloudflare via residential IPs and renders the ad-cost prices; production technique = in-page GraphQL fetch (not form automation)

# Phase 26 — Steel.dev hosted-browser validation (live, 2026-06-30)

Tooling: `scripts/probe-steel-adcost.js` (steel-sdk + playwright-core, CDP). Operator topped up $10 (required — see cost). ~9 live sessions.

## Answer to the operator's question
**"Does the hosted scraping browser do IP changes like Oxylabs?" → YES, validated.** Steel sessions created with `useProxy:true` route through residential/rotating IPs with managed CAPTCHA solving (`solveCaptcha:true`). Across runs, Steel's residential egress **cleared Hemnet's Cloudflare** ("Just a moment…" → the real `/priser` calculator) on multiple attempts — the exact thing the droplet's datacenter IP cannot do (`26-DROPLET-CHROMIUM-TEST.md` = 403).

## What was proven
- ✅ **Cloudflare cleared via Steel residential** — repeatedly (t+3s to t+21s depending on the IP drawn). Clearing is **probabilistic per IP**; some attempts stay challenged → production needs **retry-on-block** (the probe's 5-attempt loop models this).
- ✅ **Ad-cost prices render and are captured** — one run captured the DOM after selecting Göteborg: **Hemnet Bas fr. 6 820 kr · Plus fr. 10 900 kr · Premium fr. 15 300 kr** (matches the live-browser test and the disabled droplet task's grid).
- ✅ **The form is drivable** — react-select location commits, and the asking-price field sets reliably via the React-native value setter.
- ✅ **Captured the real GraphQL query** `webAutocompleteLocations` (full query text, in the probe output) for a production in-page-fetch build.

## Key caveat → the production technique
**Scripted form-driving (click/type) triggers a mid-session Turnstile re-challenge** on roughly half the attempts ("Turnstile Solving…" appears the moment automation interacts). So the robust production approach is **NOT** to automate the form — it is to do a **quiet in-page GraphQL fetch** once Cloudflare clears: `page.evaluate(() => fetch('/graphql', {method:'POST', body: <SellerMarketingProductPrices>}))`, which looks like the page's own request and doesn't provoke a re-challenge. This is exactly the independent `claude -p` review's recommendation, and it sidesteps react-select entirely. The same in-page-fetch pattern is what an Oxylabs render `execute_javascript` (track 1) would run on the existing $249 plan.

## Cost (confirmed live)
- Steel **Launch = $0 + usage, $30 one-time free credit (90 days), no monthly floor** — BUT residential proxy + CAPTCHA require a **≥$10 paid balance** ("Launch requires at least $10 in paid balance to use CAPTCHA solving or Steel proxies"). So: **~$10 one-time floor + ~$0.50/mo** usage at our volume. (The free no-proxy run confirmed Steel's default datacenter IP is Cloudflare-blocked, isolating the spend to exactly the residential egress.)
- Still far below Oxylabs' ~$300/mo scraping browser and the ~$45/mo Web Unblocker.

## This is now a PRODUCTION BUILD, not feasibility
Feasibility = proven. The remaining work belongs to the build phase (27):
1. Implement the **in-page GraphQL fetch** loop: autocomplete (`webAutocompleteLocations`, captured) → `SellerMarketingProductPrices` (query string still to capture — do one clean form submit, or reconstruct from the droplet's `search_ad_cost_2`) for the 10 munis × 6 asking-price grid.
2. **Retry-on-block** wrapper (fresh session/IP on challenge), human-ish pacing, no aggressive clicking.
3. **Egress decision:** Steel (~$10 + ~$0.50/mo, proven here) vs Oxylabs render `execute_javascript` ($0 extra on the $249 plan, IF support confirms it — track-1 inquiry pending) vs Bright Data. The in-page-fetch code is identical across all three; only the session provider differs.

*Phase 26 · 2026-06-30 · validated live via Steel.dev. Probe: `scripts/probe-steel-adcost.js`.*
