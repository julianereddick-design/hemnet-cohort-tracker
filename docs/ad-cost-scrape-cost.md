# Hemnet ad-cost scrape — recurring-cost evidence (FEAS-03)

**Date:** 2026-06-30 · **Phase:** 26 (ad-cost-scrape-feasibility) · **Requirement:** FEAS-03
**Source docs:** `26-DIRECT-TEST-RESULT.md` (direct path), `26-OXYLABS-PROBE-RESULT.md` (Oxylabs probe), `23-VERIFICATION-CRAWL.md` (flat-plan marginal-cost framing).

> Carries only call counts, dollar figures, and crawl sizes from the result docs — **never** any Oxylabs/DB credential values (T-26-08).

---

## TL;DR — cost is NOT the obstacle; transport capability is

The recurring **dollar** cost of resuming the weekly `AdCostV2` ad-package-price crawl is **trivial** — at the list rate a full weekly pass is **~$0.29/run** (~$1.26/mo), and **≈$0 marginal** on Decade's flat $249/mo Oxylabs Advanced plan. That is far below the sold-match recurring spend benchmark (~$15–45/mo).

**But neither fetch path has actually landed a fresh row yet.** After the Phase-26 feasibility work:

- **Direct path (26-01): BLOCKED.** The direct GraphQL POST from the droplet IP gets an HTTP 403 Cloudflare "Just a moment…" challenge on the first request. `VERDICT: DIRECT_BLOCKED`.
- **Oxylabs borrowed-creds path (26-02): BLOCKED at the transport layer (D-04).** Oxylabs reliably defeats Hemnet's Cloudflare, but the borrowed cohort-tracker **Web Scraper API** creds parse-then-ignore the GraphQL POST body, so **0 `AdCostV2` rows landed**. Probe spend: **18 calls / $0.05**, no rows.

So the figures below describe what the recurring cost **would** be once a body-capable transport exists — they are the answer to FEAS-03 — while the actual blocker is a **credentials / product-scope decision**, not money. See [Current status](#current-status-blocked-on-transport-capability) for the three unblock options the operator must choose between.

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

| Option | What it is | Carries POST body? | Recurring cost note |
|--------|------------|--------------------|---------------------|
| **A. Oxylabs Web Unblocker** (`unblock.oxylabs.io:60000`) | Add/provision the Unblocker product; preserves POST bodies + beats Cloudflare. webscraper.py gains a small proxy-POST helper. | Yes | Usage-priced separately from the $249/mo Advanced plan (still tiny at ~120 calls/wk) |
| **B. Oxylabs residential/DC proxy creds** (`pr.oxylabs.io:7777`) | Raw proxy forwards the literal POST (method + body + headers); a residential IP likely clears Cloudflare as the GET rewire did. webscraper.py gains a thin proxy path. | Yes | Residential GB-priced (small at this volume) |
| **C. Refresh the droplet's OWN Web Scraper API creds** AND confirm the plan tier transmits POST bodies | v4.0 carry-over — the droplet's own creds are dead (HTTP 401). Only unblocks if that plan tier actually delivers POST bodies, which the current borrowed Advanced plan does **not** (proven). | Unknown — must verify first | Within whatever plan; verify body delivery before committing |
| ~~D. Re-express queries as GET~~ | ~~GraphQL-over-GET~~ | **No** — Hemnet Apollo returns 404 for GET on `/graphql` (method 7); not available | — |

Once a body-capable transport exists, the remaining build is **small** — Cloudflare bypass, the `search_ad_cost_2` recon, and the `AdCostV2` write path are all already solved. This is a **credentials / product-scope decision**, not an engineering blocker.

**Recommendation:** provision a body-preserving Oxylabs product — **Option A (Web Unblocker) or Option B (residential/DC proxy)** — then enable Phase 27. The recurring dollar cost is negligible either way (~$1.26/mo list, ≈$0 marginal, vs the ~$15–45/mo sold-match benchmark); the operator's real call is whether to provision the transport + accept the borrowed-creds coupling (deferred dedicated sub-user cleanup), not whether the spend is affordable.

---

*Phase 26-03 · 2026-06-30 · FEAS-03 evidence. Cost quantified = trivial; the phase gate is a transport-capability (creds/product-scope) decision, handed to the operator as the single Phase-26 checkpoint (Task 2).*
