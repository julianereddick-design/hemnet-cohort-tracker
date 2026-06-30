---
phase: 25-right-size
plan: 02
status: complete
completed: 2026-06-30
requirements: [SIZE-01]
---

# 25-02 SUMMARY — Peak-RAM profile + slug decision

## What was done

**Task 1 — D-03 peak-RAM profiling crawl (operator-approved, PASS):** Ran the real `WebScraper`/`fetch_via_webscraper` path inside `hemnet-crawler` (Metabase gated) over 205 recent Hemnet `/bostad/` detail pages at concurrency 5, URLs harvested from `/bostader` search pages (261 unique harvested). A host `free -m` sampler (every 3s, 113 samples) captured peak RAM under load.
- Result: `ok=183, blocked_403=0, auth_401=0, exc=0, empty_other=22`, 205 attempted, 300s. **0% HTTP-403** — scraper authenticates and is not blocked.
- **Peak `used` RAM = 1033 MiB** (idle 979 → peak 1033, +54 MiB; idle 964 post-crawl). The 5-concurrent burst barely moves the working set.
- Cost ~211 Oxylabs calls ≈ $0.53. Staged harness/sampler scripts removed after the run (24-05 hygiene). No creds logged.

**Task 2 — Slug decision (operator-confirmed):** Peak 1033 MiB ≪ ~1536 MiB D-03 threshold → **`s-1vcpu-2gb`** (~$12/mo), ~1 GiB headroom on a 2 GB box. Operator confirmed. Fallback `s-2vcpu-4gb` not needed.

## Key files
- `.planning/phases/25-right-size/25-VERIFICATION.md` — `## D-03 peak-RAM profile` + `## Slug decision` (appended)

## Deviations / notes
- URLs sourced by harvesting `/bostader?page=N` search pages (54 `/bostad/` URLs each) rather than a pre-curated list — self-contained, time-robust, +5 Oxylabs calls. The 24-05 run used a fixed list; the harness here is the same `WebScraper` path.
- 22 `empty_other` (no `__NEXT_DATA__`) are removed-listing tombstones / slow Oxylabs jobs, NOT blocks (403/401 both 0). Does not affect the RAM measurement or the not-blocked conclusion.
- Peak measured on the 16 GB box; 25-04 post-resize crawl + OOM watch is the real-size confirmation, with reversible re-resize-up as rollback.

## Self-Check: PASSED
- N≥200 crawl ran only after explicit operator approval ✓
- 0 HTTP-403 / 0 auth-401, peak RAM captured (1033 MiB) ✓
- Slug chosen by D-03 rule + operator-confirmed (s-1vcpu-2gb) ✓
- Verifier script removed; cost recorded; no creds logged ✓
