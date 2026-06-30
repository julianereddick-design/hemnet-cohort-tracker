VERDICT: OXYLABS_REWIRE_BLOCKED_D04 — Cloudflare defeated, but borrowed Web Scraper API creds cannot deliver a POST body to hemnet.se/graphql

EXACT_SPEND_USD: 0.05
OXYLABS_CALLS: 18

# Phase 26-02 — Oxylabs ad-cost rewire: bounded-probe result (D-04 escape hatch)

**Run:** 2026-06-30. Plan 26-02 ACTIVATED (26-01 `VERDICT: DIRECT_BLOCKED`, re-read line 1 as the Task-0 gate — confirmed `DIRECT_BLOCKED`).
**Operator authorization:** explicit go-ahead for the prod feature-branch edit + borrowed-creds install + bounded Oxylabs probe (HARD CAP 200 calls / ~$0.49).
**Outcome:** The bounded probe was used to validate the Oxylabs transport BEFORE any droplet mutation. It uncovered a hard product-capability wall (D-04): the borrowed cohort-tracker Oxylabs **Web Scraper API** credentials **defeat Hemnet's Cloudflare block** but **cannot transmit the GraphQL POST request body** through any available Oxylabs integration method. No working rerouted path that lands fresh `AdCostV2` rows could be produced with these creds. Per the plan's D-04 escape hatch + the orchestrator's STOP-don't-thrash guidance, I stopped before mutating the droplet and bring an informed operator checkpoint.

**Spend:** 18 Oxylabs calls, **$0.05** at the list rate ($2.4 / 1,000 results = $0.0024/call); **marginal ≈ $0** on Decade's flat $249/mo Advanced Web Scraper API plan (same basis as the P23 verification crawl). Well under the 200-call / ~$0.49 cap. **No fresh `AdCostV2` rows were written** (the POST body could not be delivered, so the GraphQL query never executed with content).

---

## What this plan was supposed to do

Reroute `apps/hemnet/tasks.py::search_ad_cost_2`'s two-step Hemnet GraphQL **POST** (`AutocompleteLocations` → `SellerMarketingProductPrices`) through the droplet's Oxylabs `apps/core/webscraper.py` path (mirroring the P23 GET rewire), install this repo's working Oxylabs creds into the droplet's gitignored `.env` (D-07, since the droplet's own creds are dead/401), rebuild only the hemnet image, and run a bounded probe to land fresh `AdCostV2` rows + measure spend.

## Why it is blocked (the D-04 finding)

`search_ad_cost_2` issues **POST requests with a JSON body** (the GraphQL query). The P23 rewire only ever needed **GET** page fetches (`WebScraper(url=...).run()` → universal source, no body). Routing a body-bearing POST is the "may be large/destabilizing" risk the plan flagged for D-04 — and it materialised as a credential/plan-scope wall, not a code-size problem.

I validated the Oxylabs transport empirically (off-box, on this repo's creds — representative because Oxylabs routes via its own proxy pool, so the source IP is Oxylabs' regardless of where the caller runs; the droplet IP only mattered for the 26-01 *direct* test). Results:

| # | Oxylabs integration method (borrowed Web Scraper API creds) | Cloudflare? | POST method? | POST body delivered? | Net result |
|---|---|---|---|---|---|
| 1 | Web Scraper API **universal** source, `/v1/queries`, top-level `http_method`+`content` | **Defeated** | No — silently does GET | n/a | `/graphql` GET → **404**; httpbin/post → **405** (proves GET) |
| 2 | Web Scraper API **universal** source, `context:[{http_method:post},{content:base64},{headers}]` | **Defeated** | **Yes** (httpbin → **200**, not 405) | **No** — body silently dropped | Hemnet → **200** but `{"errors":[{"message":"Must provide query string","code":"BAD_REQUEST"}]}`; httpbin `data:""` |
| 3 | Web Scraper API **proxy endpoint** `realtime.oxylabs.io:60000` | **Defeated** | Yes | **No** — body stripped (request rewritten as a browser navigation; injects its own `Sec-Ch-Ua`/`Referer`) | Hemnet → "Must provide query string"; httpbin `Content-Length:0` |
| 4 | **Web Unblocker** `unblock.oxylabs.io:60000` (the product that *does* preserve POST bodies) | n/a | n/a | n/a | **401** CONNECT — not in this subscription |
| 5 | **Residential proxy** `pr.oxylabs.io:7777` (raw proxy forwards full request) | n/a | n/a | n/a | **407** Proxy-Auth — creds invalid for this product |
| 6 | **Datacenter proxy** `dc.oxylabs.io:8001` | n/a | n/a | n/a | **407** Proxy-Auth — creds invalid for this product |
| 7 | **GraphQL-over-GET** (`?query=…&variables=…`) through the working universal source | **Defeated** | GET | n/a (no body needed) | Hemnet `/graphql` → **404** (Apollo GET disabled on Hemnet) |

**Two decisive, reproducible facts:**
1. **Cloudflare is NOT the blocker.** Every Oxylabs method that reached Hemnet returned an *origin-level* response (HTTP 404 for GET, or a GraphQL `BAD_REQUEST` JSON for POST) — **never** the 403 "Just a moment…" challenge the droplet IP hit directly in 26-01. Oxylabs reliably gets past Cloudflare.
2. **The POST body cannot be delivered with the borrowed Web Scraper API creds.** Method-2 proves it cleanly: `context.content` (base64) is *accepted and validated* by Oxylabs (it errors `"Context content parameter invalid, should be base64 encoded string"` when not base64), the request is performed as a real POST (httpbin returns 200, Hemnet's Apollo parses it), **but the body arrives empty** (`data:""` / "Must provide query string"). The Advanced Web Scraper API plan parses-then-ignores the POST body. The two products that *would* carry a raw POST body (Web Unblocker, residential/datacenter proxies) reject these credentials (401/407) — they are scoped to the Web Scraper API only.

## Guardrail compliance

- **No droplet mutation.** No feature branch was created, **no creds were written to the droplet `.env`**, the hemnet image was **not** rebuilt, and no container was recreated. All 5 lean containers retain their pre-existing state (verified: `hemnet-redis` CreatedAt 2026-04-18 untouched; `hemnet-crawler`/`-django`/`-beat`/`-writer` unchanged). The P24 `docker-compose.override.yml` was left untouched. This is the correct reversible-first outcome: installing creds that provably cannot work onto a malware-remediated box would be needless secret exposure.
- **Secrets:** the borrowed cred *values* were read only into ephemeral local probe processes / a gitignored local curl config (deleted after use) on the operator workstation — **never printed, never sent to the droplet, never logged, never committed.**
- **Spend:** 18 calls / $0.05 (list) — under the 200-call / $0.49 cap. Marginal ≈ $0 on the flat Advanced plan.

## Per-call yield note for 26-03

Not measurable here — the rerouted path did not execute the GraphQL query (body undelivered), so 0 `AdCostV2` rows landed and there is no observed per-call row yield. The *intended* shape (recon from 26-01, unchanged) remains: a full pass = 60 `AdCostPricePointV2` rows (10 munis × 6 asking prices) × 2 POSTs each ≈ **120 Oxylabs calls/run** if a working POST transport existed; at $0.0024/call (or ≈$0 marginal on the flat plan) that is **~$0.29/run at list, ≈$0 marginal** — i.e. cost is NOT the obstacle. The obstacle is *transport capability*. 26-03's recurring-cost write-up should be framed around the unblock options below, not a per-call extrapolation.

## Options for the operator (the informed checkpoint)

To deliver a working Oxylabs ad-cost path (FEAS-02), one of:

- **A. Add Oxylabs Web Unblocker** (`unblock.oxylabs.io:60000`) to the account, or provision creds for it. It preserves POST bodies + defeats Cloudflare — the cleanest fit. webscraper.py gains a small proxy-POST helper. (Recurring: Web Unblocker is usage-priced separately from the $249/mo Advanced plan.)
- **B. Provision Oxylabs residential/datacenter proxy creds** (`pr.oxylabs.io:7777`). A raw proxy forwards the literal POST (method+body+headers); a residential IP likely passes Cloudflare for the POST just as the GET rewire did. webscraper.py gains a thin proxy path. (Recurring: residential GB-priced.)
- **C. Refresh the droplet's OWN Web Scraper API creds AND confirm the plan includes POST-body delivery** — the v4.0 carry-over (droplet creds are 401). Only unblocks if that plan tier actually transmits POST bodies, which the *current borrowed Advanced plan does not* (proven above). Verify before committing.
- **D. Re-express the two queries as GET** — BLOCKED here: Hemnet's Apollo server returns 404 for GET on `/graphql` (method 7), so GraphQL-over-GET is not available.

**Recommendation:** A or B (a body-preserving Oxylabs product). The build is small once a body-capable transport exists — Cloudflare, the recon, and the write path are all already solved. This is a **credentials/product-scope decision**, not an engineering blocker, and it is the natural input to 26-03's single recurring-cost go/no-go.

---

*Phase 26-02 · 2026-06-30 · D-04 escape hatch invoked: confirmed-blocked + transport wall fully characterised; STOPPED before droplet mutation per orchestrator guidance; $0.05 spent / 18 calls (cap 200 / $0.49).*
