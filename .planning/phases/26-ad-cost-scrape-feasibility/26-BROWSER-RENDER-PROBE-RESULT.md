VERDICT: BROWSER_WORKS — a real browser passes Cloudflare, commits the form, and renders the full ad-cost grid for $0

# Phase 26 — live browser feasibility test (the reframe that changes the recommendation)

**Date:** 2026-06-30 · **Method:** live Claude-in-Chrome (real Chrome, operator residential IP) driving https://www.hemnet.se/priser.

## The reframe (from an independent `claude -p` review)
The struggle (commit react-select / Oxylabs drops POST body / Web Unblocker floor) was all downstream of one wrong assumption: that we must replay a bare POST through a proxy, OR drive the calculator UI to completion. **We need neither.** The correct unit of work is *"a real browser that has cleared Cloudflare on hemnet.se."* Once a real browser holds the `cf_clearance` cookie + browser TLS fingerprint, you either (a) read the prices straight off the rendered DOM, or (b) fire `fetch('/graphql', {POST, body:<our JSON>})` **from inside the page's own context** — indistinguishable from the calculator's own request. react-select only mattered because we were trying to make the *page* fetch for us.

## Live proof (this test)
Drove the real browser end-to-end with zero proxy:
1. Navigated to `/priser` → **Cloudflare passed automatically** (full calculator rendered; no 403). Confirms the bare-POST/Oxylabs Cloudflare problem is a non-issue for a real browser.
2. Typed "Göteborg" in the location field → autocomplete opened with the exact option **"Göteborgs kommun, Västra Götalands län"**; clicked it → **react-select committed** (the exact step Oxylabs render could not do).
3. Entered asking price **5 000 000 kr**, clicked **Beräkna pris**.
4. Prices rendered client-side:

| Package | Price (Göteborg @ 5M kr) |
|---------|--------------------------|
| **Bas** | från **6 820 kr** |
| **Plus** | från **10 900 kr** |
| **Premium** | från **15 300 kr** |
| **Max** | från **21 200 kr** |

Plus the add-on products on the same page: **Raketen fr. 1 580 kr**, **Förnya annons fr. 6 210 kr** — which map to the remaining `AdCostV2` codes (TOPLISTING / PAID_REPUBLISH). The full muni×askingPrice×product grid is reachable; the form takes both inputs, so it is fully parameterizable for the 10×6×~7 historical grid.

> Prices noted "Priserna gäller åtminstone t.o.m. 26 juni 2026, inkl. moms." Headline is the cheapest payment method ("från"); the per-payment-method detail is behind "Se alla priser".

## What this means for cost & path
- **FEAS-02 is achievable via browser automation at ~$0** — no Web Unblocker ($45/mo), no body-capable proxy, no react-select solve.
- **Recommended production path:** headless browser (Playwright/Puppeteer) on the existing droplet, either reading the rendered prices or doing the in-page `fetch('/graphql')` after Cloudflare clears. Marginal cost ≈ $0 (uses already-paid droplet).
- **The one remaining open question:** will a **headless** Chromium pass Cloudflare from the **droplet's Sydney datacenter IP**? This test used the operator's *residential* IP. DC IPs sometimes get escalated to an interactive Turnstile challenge.
  - **Next test (free):** run headless Playwright from the droplet against `/priser`.
  - **Fallbacks if the DC IP is challenged (all < $45/mo):** (1) a cheap residential proxy in front of just the headless browser (~$2–10/mo); (2) a hosted "scraping browser" free/cheap tier (Browserbase / Steel.dev / Hyperbrowser / Bright Data Scraping Browser — drive the same Playwright script via their CDP endpoint, residential IP + managed anti-bot, ~pennies/week); (3) Oxylabs render with `execute_javascript` IF support confirms it exists (existing $249 plan — see the revised `26-OXYLABS-INQUIRY.md` Q1).

## Status of the $45/mo Web Unblocker decision
**Downgraded to last-resort.** The browser-automation path is almost certainly $0–pennies; Web Unblocker's $45/mo flat floor is now only relevant if every browser-automation option (self-hosted, residential front, hosted scraping browser, Oxylabs JS-eval) somehow fails — unlikely.

*Phase 26 · 2026-06-30 · left-field test prompted by operator; independent `claude -p` reframe + live in-browser proof. Next: headless-from-droplet Cloudflare test.*
