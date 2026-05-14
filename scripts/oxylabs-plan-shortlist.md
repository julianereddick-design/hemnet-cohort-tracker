# Oxylabs paid-plan shortlist — Plan 09-1.5 procurement artifact

**Author:** planner (Task 1 of plan 09-1.5)
**Audience:** the operator who will subscribe via the Oxylabs dashboard
**Status:** awaiting operator pick — write `verf09-1-5-logs/chosen-plan.txt` to close this checkpoint
**Source of truth for pricing:** the Oxylabs dashboard at the time of subscription. The numbers in section 2 are 2024–2025 published-rate anchors so the operator knows what TYPE of plan to look at; **verify them against the live dashboard before clicking subscribe** and overwrite this file if they are stale.

---

## 1. Per-cycle Oxylabs request volume

This is the volume estimate that drives the plan-tier pick. Anchored on the VERF-09-1 (attempt 2) wet-run: `verf09-1-logs/wet-run.log` line 2701 reports `oxylabsCallCount:339` for one full Job C cycle (16 search calls + 323 detail-fetch attempts across all 4 counties).

| Job | Cycle frequency (D-06) | Per-cycle calls | Source |
|---|---|---|---|
| Job C (`booli-targeted-discovery`) | every 2 days | **339** (16 search + 323 detail) | `verf09-1-logs/wet-run.log` line 2701 — actual observed |
| Job D (`booli-targeted-refresh`) | every 2 days | ~600 (pair-only refresh; conservative estimate) | 09-CONTEXT.md D-02 SELECT shape — count of `cohort_pairs` with active Booli leg in last 12-week window |
| Job A (`hemnet-targeted-refresh`) | every 2 days | ~600 (pair mirror — same SELECT shape as Job D, just the Hemnet leg) | mirror of Job D |
| Job B (`hemnet-weekly-seeding`) | weekly | ~50–100 | renumbered 09-03 (light) |

Job D / Job A volume estimate uses the conservative `~600 cohort_pairs in the last 12 weeks` ballpark (the actual count would come from running the SQL below; the planner does not execute it inside Task 1 to avoid blocking on DB credentials):

```sql
SELECT COUNT(*) AS estimated_per_cycle_calls
  FROM cohort_pairs cp
  JOIN cohorts c ON c.cohort_id = cp.cohort_id
 WHERE c.week_start >= CURRENT_DATE - INTERVAL '12 weeks'
   AND cp.dropped_booli_on IS NULL;
```

**Per-month projection** at ~15 cycles/month (every-2-days = ~15 fires/month):

- Job C: 339 × 15 ≈ **5,085 calls/month**
- Job D: 600 × 15 ≈ **9,000 calls/month**
- Job A: 600 × 15 ≈ **9,000 calls/month**
- Job B: 100 × 4 ≈ **400 calls/month**
- **Subtotal: ~23,500 calls/month** (without retry / Oxylabs-fallback headroom)
- **With ~1.5x retry + fallback headroom: ~35,000 calls/month**

**Headline target: budget for 25k–40k Oxylabs Web Scraper API requests/month.**

### Volume estimate — explicit assumptions

- The 339-calls/cycle anchor is for the steady state AFTER 09-04 cutover, NOT the one-time historical-backfill burst — the backfill runs through this same pipeline only once and is a separate cost line.
- Job D and Job A use the ~600 conservative estimate without running the SQL probe (operator can refine at first wet-run when the actual `cohort_pairs` count is known).
- Cadence multiplier ~15/month comes from the `*/2 day-of-month` cron expression locked in 09-CONTEXT D-06 — i.e. one fire every two days.
- Retry/fallback headroom of 1.5x covers transient 403/429/5xx retries and the Oxylabs-fallback path's 1-internal-retry (lib/scrape-http.js#fallbackViaOxylabs).

---

## 2. Oxylabs paid plans researched

Three options spanning the cost/feature spectrum. Each lists a 2024–2025 published-rate anchor; **the operator MUST verify current pricing on the Oxylabs dashboard at https://oxylabs.io/products/web-scraper-api and overwrite this section if the numbers are stale before subscribing.**

### Option A — Web Scraper API, entry tier (Micro / Starter)

- **Cost:** $49–$99/month (verify on Oxylabs dashboard — pricing typical of 2024–2025 published rates; entry tiers historically include ~17.5k–50k results/month)
- **Included quota:** ~17,500–50,000 successful results/month (vendor counts successful results, not raw API calls)
- **Source flag:** `source: 'universal'` — same as the current default in `lib/scrape-http.js:118`. No code change to the source name if this tier is picked.
- **Render:** none (HTML-only — JavaScript rendering NOT included on the entry tier)
- **Premium pool:** not included (uses Oxylabs' datacenter IPs by default)
- **Geo-targeting:** typically included (we already pass `geo_location: 'Sweden'`)
- **Verdict:** cheapest. **Works IF** the 16-search-successes-then-100%-failure pattern in VERF-09-1 is genuinely trial-credit exhaustion (the most likely hypothesis per D-13 evidence) AND Booli detail pages can be parsed from HTML without JavaScript execution. The 339-calls/cycle workload fits comfortably inside the entry-tier quota even after retry headroom.
- **Risk if picked:** if Booli detail pages need JS rendering to populate `__NEXT_DATA__` (currently believed unlikely — the existing `extractNextData` works on detail-page HTML from successful direct-curl calls), Option A still hits OXYLABS_API_NON_200 and we escalate to Option B.

### Option B — Web Scraper API, mid tier (Advanced / Pro)

- **Cost:** $99–$249/month (verify on Oxylabs dashboard — pricing typical of 2024–2025 published rates; mid-tier historically includes ~50k–200k results/month)
- **Included quota:** ~50,000–200,000 successful results/month
- **Source flag:** `source: 'universal'` (with `render: 'html'` enabled) OR `source: 'web_scraper'` if the chosen tier exposes the dedicated `web_scraper` source name on this account
- **Render:** **`render: 'html'` available** — this is the key Option B add-on. If Option A fails because Booli detail pages serve a Cloudflare/JS-only shell over HTTP (and only populate `__NEXT_DATA__` after client JS runs), `render: 'html'` makes Oxylabs run a headless browser on the target page and return the rendered HTML.
- **Premium pool:** optional add-on (extra $/month if enabled)
- **Verdict:** middle ground. Targets the "Booli detail pages need JS render" hypothesis. Probably overkill IF Option A would have worked — but the marginal cost is bounded and the quota headroom is comfortable for the 25k–40k projected volume.

### Option C — Web Scraper API + Residential Premium / Enterprise

- **Cost:** $249–$499/month (verify on Oxylabs dashboard — pricing typical of 2024–2025 published rates; premium/residential tiers and enterprise quotes vary; sales call may be required for true Enterprise)
- **Included quota:** ~100,000–500,000 successful results/month + residential proxy add-on
- **Source flag:** `source: 'universal_ecommerce'` OR `source: 'universal'` with `premium: true` (the residential / premium-pool flag — name varies by plan)
- **Render:** `render: 'html'` included
- **Premium pool:** **included** — uses Oxylabs' residential / mobile proxy pool instead of datacenter IPs
- **Verdict:** most expensive. Targets the "Booli IP-bans Oxylabs datacenter pool for detail URLs" hypothesis. This would explain a per-endpoint-shape failure (search via datacenter works, detail via datacenter doesn't) — but the VERF-09-1 evidence is more consistent with credit exhaustion than per-endpoint IP banning (search ALSO started failing after page 16, not just detail). Only escalate here if Options A and B both fail.

### Pricing-source caveats (do this BEFORE clicking subscribe)

The dollar amounts above are anchors from 2024–2025 published rates and Oxylabs marketing pages. Pricing has historically been:

- Often quote-driven for higher tiers (Enterprise / Residential frequently requires a sales call)
- Sometimes restructured (request-count tiers vs. successful-result tiers; some plans bundle "Web Scraper API" with other Oxylabs products)
- Subject to promotional pricing at sign-up

**Mandatory step before subscribing:** open the Oxylabs dashboard, find the current Web Scraper API page, screenshot the live pricing/quota for the three tiers above, and overwrite the dollar/quota anchors in this file with the real numbers if they differ. The shortlist's RANKING (A < B < C) is the load-bearing output — the absolute dollar values are just to set expectations.

---

## 3. Recommended pick (planner's reasoning)

**Recommend Option A first** — escalate to B or C only if the probe (Task 2 / scripts/probe-oxylabs-booli.js) still surfaces `OXYLABS_API_NON_200` after Task 3's request-body edit lands on the cheap tier.

Reasoning (3 lines):

1. The VERF-09-1 failure signature — **16 successful Oxylabs-fallback calls followed by 100% `OXYLABS_API_NON_200`** including the search endpoint that previously succeeded — is the textbook trial-credit-exhausted pattern (the API itself rejects further requests, regardless of the target URL shape). This is the D-13 single-root-cause hypothesis.
2. Trial-credit exhaustion is fixed by ANY paid plan; we do not yet have evidence that the failure is per-endpoint-shape (which would point at IP banning and justify Option C) or JS-render-dependent (which would point at Option B).
3. Iteration is cheap with the Task 2 probe: ~12 paid Oxylabs requests/probe-run × at most 3 config-tweak iterations = ~36 paid requests to confirm whether Option A is sufficient. If the probe passes on Option A, we have spent the minimum money to validate D-13. If it doesn't, the `OXYLABS_API_NON_200 body=...` excerpt in the probe log will tell us whether to escalate to Option B (`render: 'html'`) or Option C (`premium: true`).

**Override clause:** if the operator has independent reason to expect Option B/C is required (e.g., dashboard support chat confirms the entry tier doesn't include `geo_location: 'Sweden'`, or prior Booli scraping experience indicates detail pages need JS), skip the probe-on-A step and pick the higher tier directly. Document the override reasoning in `verf09-1-5-logs/chosen-plan.txt`.

---

## 4. What the user does next

Numbered list. Section 5 (below) lists what is OUT of scope so the operator doesn't get sidetracked.

1. **Read sections 1–3 above.** Verify the volume estimate matches the operator's expectation; verify the Oxylabs pricing anchors against the dashboard at https://oxylabs.io/products/web-scraper-api and overwrite this file if any anchor is stale.
2. **Pick A / B / C** (or override with another Oxylabs tier — document the reasoning in `verf09-1-5-logs/chosen-plan.txt`). The recommendation is Option A first per section 3.
3. **Subscribe via the Oxylabs dashboard.** Capture the dashboard's documented `source` / `render` / `premium` flag names for the chosen tier (Oxylabs occasionally renames these — e.g., `web_scraper` vs. `universal_ecommerce` — and Task 3 needs the exact value).
4. **Update `.env` on the dev machine** with the new credentials:
   - `OXYLABS_USERNAME=<new>` (replaces the trial username)
   - `OXYLABS_PASSWORD=<new>` (replaces the trial password)
   - If the chosen plan exposes a dedicated subdomain endpoint (rather than the shared `https://realtime.oxylabs.io/v1/queries`), capture the override URL for Task 3 (Task 3 will edit `lib/scrape-http.js:37` `OXYLABS_ENDPOINT` if needed — this is a constant, not env-driven).
5. **Write `verf09-1-5-logs/chosen-plan.txt`** with EXACTLY this shape (Task 3 reads this file and parses these five fields deterministically):
   ```
   plan=<A|B|C>
   source=<universal|web_scraper|universal_ecommerce>
   render=<none|html>
   premium=<true|false>
   endpoint_override=<none|https://...>
   ```
   Example for the recommended Option A pick:
   ```
   plan=A
   source=universal
   render=none
   premium=false
   endpoint_override=none
   ```
6. **Signal pick to the planner:** re-run `/gsd-execute-phase 9 --plan 09-1.5`. Execution resumes at Task 3, which reads `verf09-1-5-logs/chosen-plan.txt` to know what request-body edit to apply to `lib/scrape-http.js#fetchViaOxylabs`.

---

## 5. Out of scope

These are deliberately NOT part of 09-1.5; do not let them block this procurement decision.

- **Vendor swap** (BrightData, ScrapingBee, residential-only proxies) — D-14c locks Oxylabs for 09-1.5. If paid Oxylabs still fails the Task 4 wet-run after a reasonable tier escalation, **re-open the plan** rather than silently substituting vendors.
- **Post-cutover Oxylabs cost optimization** — `[[oxylabs-cost-optimization]]` is deferred per 09-1.5-CONTEXT.md. The first paid wet-run is the first real billing data point; revisit tier sizing after one full observation week.
- **Tightening the wet-run gate thresholds** (e.g., `oxylabsFailureCount / oxylabsCallCount < 0.2` instead of `< 0.5`) — explicitly declined per 09-1.5-CONTEXT.md "Verification bar".
- **Optimizing Job D / Job A volume below the conservative ~600/cycle estimate** — possible but not blocking; the steady-state cost will be measured at the first paid wet-run.
