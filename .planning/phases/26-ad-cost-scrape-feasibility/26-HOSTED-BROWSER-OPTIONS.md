# Hosted Scraping-Browser Options for Hemnet Ad-Cost Capture

**Researched:** 2026-06-30 (all prices verified this date unless flagged). Prices change often — re-verify before committing.

## The use case (it's tiny)

We need a **remote real browser** (Playwright/Puppeteer over CDP) that:
- Clears **Cloudflare incl. Turnstile** on `hemnet.se` — our datacenter IP gets a 403 "Just a moment" challenge, so we need **residential / rotating IPs + managed anti-bot** (the way Oxylabs residential proxies rotate IPs).
- Loads `https://www.hemnet.se/priser`, drives a small react-select autocomplete + asking-price field, clicks, reads rendered prices — or does an in-page `fetch('/graphql')` after Cloudflare clears.
- **Volume is minuscule:** ~120 page loads/week (~60 form submits), a few seconds each, **~16 MB/month (~0.016 GB)** total, weekly cadence, unattended from a small server.

**Volume math used below:** ~480 page loads/month, generously ~30s browser time each ≈ **~4 browser-hours/month** and **~0.016 GB residential traffic/month**. Our spend is pennies-scale on any usage-metered vendor; the thing that bites us is a **monthly FLOOR / required plan**.

---

## Direct answer to "do hosted scraping browsers do residential IP rotation like Oxylabs?"

**Yes — that is exactly what this product category is.** Every serious "scraping browser" / "cloud browser" runs your CDP session **through a managed residential/rotating proxy pool with built-in Cloudflare/Turnstile + CAPTCHA handling**, i.e. the same IP-rotation behaviour you get from Oxylabs residential proxies, but wired into a real browser you drive with Playwright. The differences between vendors are (a) whether residential is **included or a paid add-on**, (b) the **per-GB / per-hour price**, and (c) whether there's a **monthly floor**.

---

## Comparison table

| Vendor | Residential / rotating IP + Cloudflare bypass in-session? | Pricing model + monthly FLOOR | Est. cost at OUR volume (~4 br-hr, ~0.016 GB resi/mo) | Free tier to test E2E | Standard Playwright/CDP drivable? |
|---|---|---|---|---|---|
| **Steel.dev** | Yes. Residential pool + CAPTCHA solve are session features (must enable in session). | **Pure PAYG, $0 floor** (Launch). Browser $0.10/hr; **residential $5/GB**. Scale plan $250/mo only if you want it. | **~$0.50/mo** ($0.40 br-hr + $0.08 resi). No floor. | **$30 one-time credits, 90-day** (Launch). Covers ~2 mo of us free. | **Yes** — open-source, standard Playwright/Puppeteer over CDP/websocket. Lowest lock-in. |
| **Bright Data Scraping Browser** | Yes. Built-in website unlocking, **CAPTCHA solving, automated proxy mgmt incl. residential**, all "included in the price." Strong Cloudflare track record. | **PAYG $8/GB, "no commitment"** (no monthly floor on PAYG tier). Volume tiers $7/$6/$5 per GB start at **$499/mo**. | **~$0.13/mo** (0.016 GB × $8). | "Start free trial" offered; **credit amount not stated on pricing page** (flag). Typically a small trial credit + KYC/business verification. | **Yes** — CDP endpoint, point Playwright/Puppeteer at it. Some KYC friction. |
| **Hyperbrowser** | Claimed "most aggressive default" vs Cloudflare Turnstile / Bot Mgmt; integrated stealth + CAPTCHA + global residential. (Resi-in-session detail thin in docs — flag.) | Credit model, **1 credit = $0.001**. Browser **$0.10/hr** (100 cr); **proxy $10/GB** (10,000 cr). Free plan; paid Startup **$30/mo+usage**, Scale $100/mo+usage. | **~$0.56/mo** (400 cr br-hr + 160 cr proxy). Free plan's **1,000 credits ($1)** could cover it. | **Free plan, 1,000 credits, 1 concurrent, no card** (whether it refills monthly vs one-time is unclear — flag). | **Yes** — CDP/websocket Playwright endpoint. |
| **Browserbase** | Yes, but **residential proxy is a paid add-on NOT in the free tier**: stealth/datacenter $0.30/GB, **residential $8–12/GB**. Managed CAPTCHA/stealth. | **Effective floor $20/mo** (Developer): free tier gives only 1 br-hr & **0 GB proxy**, so residential forces a paid plan. Developer $20 (100 br-hr, 1 GB proxy incl.); Startup $99. | **$20/mo floor** (our actual usage sits inside included allowances; you pay the plan, not usage). | Free: $0, **1 br-hr, 0 GB proxy, no card** — good for a non-proxy smoke test only, can't prove residential E2E free. | **Yes** — best-in-class DX, standard Playwright/CDP. |
| **Zyte API** | Yes — auto-escalates datacenter→residential + JS rendering + anti-bot per request; handles Cloudflare (one indep. test ~4% error on a CF target). | **PAYG, no floor**, billed per **successful** request; tiered by site difficulty (browser+residential requests cost more). PAYG spend **capped $100/mo**. | A few $/mo at most (~240–480 requests; hard browser+resi requests are pricier per call). | **$5 free trial credit, 30 days** (enterprise trial $100). | **Partial** — it's Zyte's own API w/ "browser actions," **not a raw CDP endpoint**; more lock-in, can't just point vanilla Playwright at it. |
| **ScrapingBee** | Yes (premium/stealth proxies, JS render), Cloudflare via stealth mode. | **Floor $49/mo** (Freelance). Credit model; **stealth proxy = 75 credits/request**. No free PAYG. | $49/mo floor (over-budget for us). | **1,000 credit trial, no card.** | **No** — API only, not CDP-drivable. Can't drive our react-select form natively. |
| **ScraperAPI** | Yes, but **geotargeting/global residential locked behind $299 Business plan**. | **Floor $49/mo** (100K credits); render = 5–10 credits. | $49/mo floor (and $299 for geo). | Free trial credits, no card. | **No** — API/proxy layer, not CDP. |
| **Apify** | Residential proxy PAYG **$8/GB** on all plans incl. free; 5 datacenter IPs free. | **Free plan: $5 prepaid credits EVERY billing cycle, no card** ($0.20/CU). Paid Starter $29, Scale $199. | ~$5/mo free credit likely covers compute + 0.016 GB resi (~$0.13). | **$5/mo recurring free credit, no card** (recurring, not one-time). | **Indirect** — you run a Playwright "Actor" on their platform, not a remote CDP endpoint you drive from our droplet. More re-architecture. |
| **Oxylabs Headless/Scraping Browser** *(expensive baseline)* | Yes — full residential + unblocking. | **$300/mo floor** (Starter, 50 GB, $6/GB). | $300/mo floor — **the thing we're trying to beat.** | Free trial via sales contact. | Yes — CDP. |

---

## Cloudflare track record (claims vs independent signal)

- All vendors **claim** Cloudflare/Turnstile bypass; **almost none publish reproducible benchmarks**, and stealth is adversarial + target-specific — what clears Cloudflare today can fail next week. Treat all claims as unproven until tested on `hemnet.se` itself.
- Independent signal: the **browser-use stealth benchmark (2026-03-21)** tested 23 Cloudflare sites; "Browser Use Cloud" led at ~93% on Cloudflare. Per-vendor Cloudflare breakdown for Steel/Browserbase/Hyperbrowser/Bright Data was **not extractable from the article text** (heatmap only) — flag as not independently confirmed per-vendor. Source: https://browser-use.com/posts/stealth-benchmark
- **Bright Data** has the longest commercial Cloudflare/unblocking track record of this set and bundles CAPTCHA solving by default.

---

## Ranked recommendation

We want: **(a) residential IPs that clear Cloudflare, (b) a free tier to test E2E, (c) low/no monthly floor — cheaper than Oxylabs $300/mo, ideally cheaper than the $45/mo Web Unblocker.**

**1. Steel.dev — TEST THIS FIRST (free).**
- **No monthly floor** (Launch = $0 + usage), **$30 one-time credits / 90 days** to prove end-to-end for free, residential $5/GB, browser $0.10/hr → **~$0.50/mo at our volume**.
- **Standard Playwright over CDP, open-source → lowest lock-in.** Best fit for "point our existing script at a websocket endpoint, drive the react-select form, read prices or fetch /graphql."
- $30 free covers roughly two months of our entire workload — enough to fully validate the Hemnet ad-cost capture before paying a cent.
- Sources: https://docs.steel.dev/overview/pricinglimits , https://steel.dev/#pricing , https://docs.steel.dev/overview/stealth/proxies (accessed 2026-06-30).

**2. Bright Data Scraping Browser — strongest Cloudflare pedigree, also ~pennies.**
- **PAYG $8/GB, no commitment / no monthly floor** → **~$0.13/mo** at our volume; CAPTCHA + residential + unblocking included by default; CDP-drivable.
- Caveats: free-trial credit amount **not published** (verify on signup), and Bright Data usually requires **KYC / business verification**, which adds setup friction vs Steel.
- Use as the **fallback if Steel fails to clear Hemnet's Cloudflare**.
- Sources: https://brightdata.com/pricing/scraping-browser (accessed 2026-06-30).

**Honourable mentions:**
- **Hyperbrowser** — cheapest-claimed Cloudflare aggressiveness, ~$0.56/mo, free 1,000 credits, CDP-drivable. Good third option; residential-in-session + free-credit-recurrence details were thin in docs (flag, verify on signup). https://www.hyperbrowser.ai/docs/pricing
- **Browserbase** — best DX but **$20/mo effective floor** (free tier has 0 GB proxy, so you can't prove residential for free). Still far under Oxylabs $300 and under the $45 Web Unblocker, but not free to validate. https://docs.browserbase.com/guides/plans-and-pricing
- **Apify** — **$5/mo recurring free credit, no card**, residential $8/GB; but you'd run a Playwright *Actor* on their platform rather than driving a remote CDP endpoint from our droplet — more re-architecture. https://apify.com/pricing

**Avoid for this use case:** ScrapingBee ($49 floor, API-only, not CDP), ScraperAPI ($49 floor + $299 for geotargeting, API-only), Zyte (no floor and cheap, but it's an API with browser-actions, **not a raw CDP endpoint** — more lock-in and can't drive our react-select form with vanilla Playwright).

### Bottom line
**Start with Steel.dev's free $30 credit** to prove the end-to-end Hemnet `/priser` ad-cost capture (residential IP clears Cloudflare → fill react-select + asking-price → read rendered prices / fetch GraphQL). It has **no monthly floor**, runs **standard Playwright over CDP**, and our steady-state cost is **~$0.50/month** — vs Oxylabs' **$300/mo** scraping browser and the **$45/mo** Web Unblocker. If Steel can't clear Hemnet's Cloudflare, fall back to **Bright Data Scraping Browser** (PAYG ~$0.13/mo, no floor, strongest unblocking pedigree).

---

## Flags / uncertainties
- **Bright Data** free-trial credit amount: not published on the pricing page — verify at signup. Residential explicitly bundled into Scraping Browser unblocking but page lists "website unlocking/CAPTCHA/proxy mgmt" rather than the word "residential" — confirm geo/residential coverage on trial.
- **Hyperbrowser** free-plan 1,000 credits: unclear if monthly-recurring or one-time; residential-in-session + Cloudflare specifics thin in public docs — verify on signup.
- **Steel** free-plan credit-card requirement: docs don't state whether a card is required for Launch — verify at signup.
- **Per-vendor Cloudflare pass rates** are not independently benchmarked at the granularity we'd want; the only firm independent number is browser-use's aggregate. **Must validate on hemnet.se directly during the free trial.**
- All prices captured 2026-06-30; some figures (esp. promotional per-GB rates and free-credit sizes) are from vendor pages and secondary aggregators and shift frequently.

## Sources (accessed 2026-06-30)
- Steel: https://docs.steel.dev/overview/pricinglimits • https://steel.dev/#pricing • https://docs.steel.dev/overview/stealth/proxies
- Bright Data Scraping Browser: https://brightdata.com/pricing/scraping-browser
- Browserbase: https://docs.browserbase.com/guides/plans-and-pricing • https://www.browserbase.com/pricing
- Hyperbrowser: https://www.hyperbrowser.ai/docs/pricing • https://docs.hyperbrowser.ai/reference/pricing
- Zyte API: https://docs.zyte.com/zyte-api/pricing.html • https://www.zyte.com/pricing/
- ScrapingBee: https://www.scrapingbee.com/pricing/
- ScraperAPI: https://www.scraperapi.com/pricing/
- Apify: https://apify.com/pricing
- Oxylabs Headless Browser (expensive baseline): https://oxylabs.io/pricing/unblocking-browser
- Independent Cloudflare stealth benchmark (2026-03-21): https://browser-use.com/posts/stealth-benchmark
