# Hemnet ad-cost scrape — recurring-cost evidence (FEAS-03)

**Date:** 2026-06-30 · **Phase:** 26 (ad-cost-scrape-feasibility) · **Requirement:** FEAS-03
**Source docs:** `26-DIRECT-TEST-RESULT.md` (direct path), `26-OXYLABS-PROBE-RESULT.md` (Oxylabs POST probe), `26-GET-FEASIBILITY-PROBE.md` (GET reuse), `26-RENDER-FEASIBILITY-PROBE.md` (headless render), `23-VERIFICATION-CRAWL.md` (flat-plan marginal-cost framing).

> Carries only call counts, dollar figures, and crawl sizes from the result docs — **never** any Oxylabs/DB credential values (T-26-08).

---

## TL;DR — usage is pennies, but the cheapest WORKING transport has a ~$45/mo plan floor

Two cost numbers, don't conflate them:

1. **Usage cost** of the weekly `AdCostV2` crawl is genuinely **trivial** — ~120 calls/run ≈ **~$0.29/run** (~$1.26/mo) at list, **≈$0 marginal** on the existing flat $249/mo Web Scraper API plan, **~16 MB/month** of traffic.
2. **But no existing-creds path can actually carry the request**, and the cheapest *working* transport — Oxylabs **Web Unblocker** — has a **flat ~$45/mo entry-plan floor** (8 GB included; we'd use ~0.2% of it). At our volume the floor *is* the cost: **~$45/mo ≈ $540/yr**, which is **roughly equal to the entire sold-match recurring spend** (~$15–45/mo) for a ~50-cell/week dataset. So the real recurring number for the working path is **~$45/mo**, not ~$1.26/mo — **a genuine value call, not a rounding error.**

**Every existing-creds path is exhausted (all proven, ~$0.05 total spend):**

- **Direct POST (26-01): BLOCKED** — droplet IP gets HTTP 403 Cloudflare on the first request. `VERDICT: DIRECT_BLOCKED`.
- **Oxylabs Web Scraper API POST (26-02): BLOCKED (D-04)** — defeats Cloudflare but **parses-then-drops the POST body** → "Must provide query string". 18 calls / $0.05, 0 rows.
- **GET + `__NEXT_DATA__` reuse (this repo's method): BLOCKED** — `hemnet.se/priser` is the new Next.js App Router build; prices are fetched client-side after hydration, never server-rendered. `VERDICT: GET_BLOCKED`.
- **`render:'html'` + browser_instructions: ONE interaction short** — render runs the client JS; `input`/`click`/`wait` work and it typed the price + opened the autocomplete to the exact "Göteborgs kommun" option, but react-select won't commit (no keyboard/Enter/mousedown action exists; `click` doesn't fire it) so the price query never runs. `VERDICT: RENDER_PARTIAL`.

**UPDATE 2026-06-30 (post-`claude -p` reframe + live browser test) — the $45/mo Web Unblocker is now LAST-RESORT, not the plan.** An independent review pointed out the whole transport fight was downstream of a wrong assumption (replay a bare POST, or drive the UI via a proxy). The right unit of work is *"a real browser that has cleared Cloudflare."* A **live in-browser test proved it**: a real Chrome at `hemnet.se/priser` passed Cloudflare automatically, committed the react-select (Göteborg), and rendered the prices (Bas 6 820 / Plus 10 900 / Premium 15 300 / Max 21 200 kr @ 5M; add-ons Raketen 1 580 / Förnya 6 210 kr) — the full grid, parameterizable, **$0**. See `26-BROWSER-RENDER-PROBE-RESULT.md`.

**UPDATE 2026-06-30 (open question now ANSWERED — droplet-as-is path is dead).** Tested the box's own in-image headless Chromium against `/priser` from the droplet IP: **HTTP 403, "Just a moment…" Cloudflare challenge** (`26-DROPLET-CHROMIUM-TEST.md`). This confirms the droplet recon's negative signal — their original local-headless Hemnet scrape was Cloudflare-blocked from this same Sydney DC IP, which is why P23 moved to Oxylabs. **The blocker is the datacenter IP, not the browser.** The ~$0 "headless on the droplet as-is" path is ruled out.

**Every viable path needs a residential/managed egress.** Ranked by cost:

| Rank | Path | Cost | Status |
|------|------|------|--------|
| 1 | **Oxylabs render + `execute_javascript`** (in-page `/graphql` fetch on the rendered `/priser`) | **$0 extra** (existing $249 plan) | Oxylabs render already clears Cloudflare + loads `/priser` (proven in `26-RENDER-FEASIBILITY-PROBE`); only missing piece is firing the query, which a JS-eval action solves. **Pivotal free question → `26-OXYLABS-INQUIRY.md` Q1.** |
| 2 | **Hosted scraping browser** (Browserbase / Steel / Bright Data) | ~pennies/week | Residential IP + managed anti-bot + CDP endpoint; drive a real browser (commits react-select, reads prices). Needs operator to sign up for a (free-tier) account. |
| 3 | **Droplet's existing Chromium image + residential proxy front** | ~$2–10/mo | Reuse the dormant in-image Chromium (no reinstall), route its egress through a residential proxy so it presents a residential IP + the browser solves the JS challenge. |
| 4 | **Oxylabs Web Unblocker** | ~$45/mo | Works (residential + managed) but flat floor; **last-resort**. |

**Next step: send the Oxylabs inquiry** — its (revised) Q1 "does render support `execute_javascript` / an in-page fetch returning its result?" is now the **highest-leverage free question**: a YES means a $0 solution on the plan we already pay for. Pursue rank 2/3 only if it's NO.

---

## Crawl shape (from 26-01 recon, unchanged)

A full weekly pass of `apps/hemnet/tasks.py::search_ad_cost_2`:

- **60 price points** = 10 municipalities × 6 asking-price levels (2M / 5M / 7.5M / 10M / 15M / 20M SEK).
- **2 GraphQL POSTs per price point** — one `AutocompleteLocations` (resolve `locationId`) + one `SellerMarketingProductPrices` (the ad-package prices).
- **≈ 120 Oxylabs calls per full run** (60 × 2), each call billed at the list rate **$0.0024/call** ($2.4 / 1,000 results).
- Writes one `AdCostV2` row per ad tier per price point (7 product codes).
- Cadence: the dormant weekly `PeriodicTask` cron is **`0 6 * * 1`** (weekly, Australia/Sydney) — so **per-week == per-run**, and **per-month ≈ 4.33 × per-run**.

---

## Recurring-cost table (what it WOULD cost once unblocked)

| Window | Oxylabs calls | List-rate cost ($0.0024/call) | Marginal on flat $249/mo plan |
|--------|---------------|-------------------------------|-------------------------------|
| **Per-run** (one full weekly crawl) | ~120 | **~$0.29** | **≈$0** |
| **Per-week** (= per-run; weekly `0 6 * * 1` cron) | ~120 | **~$0.29** | **≈$0** |
| **Per-month** (≈ 4.33 runs) | ~520 | **~$1.26** | **≈$0** |

**Arithmetic:** 120 calls × $0.0024 = **$0.288 ≈ $0.29/run**. Per-week = per-run (one run per week). Per-month = 4.33 × $0.29 = **$1.26/mo** at list, or **≈$0 marginal** within the flat $249/mo Advanced Web Scraper API quota (same basis as the P23 verification crawl in `23-VERIFICATION-CRAWL.md`, which ran 205–410 calls at ≈$0 marginal / ~$0.49–$0.98 list).

**Actually spent so far:** the 26-02 bounded probe cost **$0.05** (18 Oxylabs calls) and landed **0 rows** — it was spent characterising the transport wall, not crawling. No full crawl has run.

> The ~$0.29/run figure is **list-rate**, body-capable-transport-assuming, and per-call-extrapolated from the recon crawl shape — NOT measured per-row, because no row has yet been produced through either path (direct = Cloudflare-blocked; Oxylabs = POST body dropped).

**Benchmark:** the sold-match pipeline recurring spend is **~$15–45/mo** (thousands of records/fortnight). This ad-cost crawl is **~50–60 cells/week** — roughly **two orders of magnitude cheaper** (~$1.26/mo list, ≈$0 marginal). On dollars alone it is a rounding error against the existing flat plan.

---

## Current status: BLOCKED on transport capability

The real decision is **not** cost — it is **which body-capable transport to provision**. `search_ad_cost_2` is a body-bearing GraphQL POST; the borrowed Web Scraper API creds (Advanced plan) defeat Cloudflare but **silently drop the POST body** (proven across every integration method in 26-02: universal `context.content` base64 validated-then-emptied → "Must provide query string"; proxy endpoint strips the body; Web Unblocker 401; residential/DC proxy 407; GraphQL-over-GET 404). Unblock options:

| Option | What it is | Carries POST body? | Recurring cost |
|--------|------------|--------------------|----------------|
| **0. Free inquiry first** ← chosen next step | Ask Oxylabs (a) for a render action that commits a react-select (Enter/mousedown/JS injection) so the existing `render:'html'` path works on the current $249/mo plan, and (b) whether any no-floor/PAYG body-capable option exists | — | **$0** — could unblock at $0 if (a) lands |
| **A. Oxylabs Web Unblocker** (`unblock.oxylabs.io:60000`) | Add/provision the Unblocker product; preserves POST bodies + beats Cloudflare in one. webscraper.py gains a small proxy-POST helper. | Yes | **~$45/mo flat** (entry plan, 8 GB; we'd use ~0.2%). The floor dominates — usage itself is pennies. **Recommended product IF we provision** (solves body + Cloudflare together) |
| **B. Oxylabs residential/DC proxy creds** (`pr.oxylabs.io:7777`) | Raw proxy forwards the literal POST (method + body + headers); a residential IP *might* clear Cloudflare (not managed/guaranteed). webscraper.py gains a thin proxy path. | Yes | PAYG GB-priced (cents at this volume) **if no floor and if it clears Cloudflare** — both unconfirmed; DC variant likely still 403s |
| **C. Refresh the droplet's OWN Web Scraper API creds** AND confirm the plan tier transmits POST bodies | v4.0 carry-over — the droplet's own creds are dead (HTTP 401). Only unblocks if that plan tier actually delivers POST bodies, which the current borrowed Advanced plan does **not** (proven). | Unknown — must verify first | Within whatever plan; verify body delivery before committing |
| ~~D. Re-express queries as GET~~ | ~~GraphQL-over-GET~~ / GET-page `__NEXT_DATA__` | **No** — Hemnet Apollo returns 404 for GET on `/graphql`; and `/priser` renders prices client-side only (GET probe). | — |
| ~~E. Headless render form automation~~ | ~~`render:'html'` + browser_instructions drive the calculator~~ | **No** (as shipped) — react-select can't be committed with the available actions (render probe). Reopens to viable **at $0** if inquiry option (a) yields a commit action. | $0 if unblocked |

Once a body-capable transport exists, the remaining build is **small** — Cloudflare bypass, the `search_ad_cost_2` recon, and the `AdCostV2` write path are all already solved. This is a **credentials / product-scope decision**, not an engineering blocker.

**Recommendation:** run the **free Oxylabs inquiry (Option 0)** before paying anything — it targets two ~$0 unblocks. If both dead-end, the cheapest *reliable* working transport is **Web Unblocker (A) at ~$45/mo**, and the operator's call becomes a value judgment: is fresh weekly ad-cost data worth ~$45/mo (≈ the whole sold-match budget) for ~50 cells/week? Inquiry pending → `26-OXYLABS-INQUIRY.md` (draft for the operator to send).

---

*Phase 26-03 · 2026-06-30 (updated post-checkpoint). FEAS-03 evidence. Usage cost trivial (~$1.26/mo) but the cheapest working transport (Web Unblocker) floors at ~$45/mo; the phase gate is a transport-capability (creds/product-scope) value decision. All free existing-creds paths exhausted; free Oxylabs inquiry is the chosen next step before any provisioning.*
