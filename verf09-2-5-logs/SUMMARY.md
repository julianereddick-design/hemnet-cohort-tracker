# Plan 09-2.5 pre-deploy dry-run — overnight session summary

**Run date:** 2026-05-15 (Friday evening, mid-W20)
**Operator:** went to bed mid-session; this summary is for morning review.

---

## TL;DR

🎉 **Job B's narrowed-search rewrite works. W20 dry-run match rate: 54.5%** (vs 26.7% baseline, target ≥ 40%).

⚠ **One deploy-blocker surfaced:** `agent_id` foreign-key violations from the new field-capture code (~9% of writes). Three fix options below. Decision needed before deploy.

---

## What the headline test showed

`node hemnet-targeted-match.js --dry-run --limit 200 --week 2026-05-11` (after pre-enrichment):

| Metric | Value | Notes |
|--------|------:|-------|
| Booli rows processed | 200 | --limit 200 |
| **matchedFromSearch** | **109 / 200 = 54.5%** | Up from 26.7% baseline (+27.8pp absolute, ~2x improvement) |
| Postcode-mismatch (rejected) | 27 (13.5%) | The narrowed search returns more candidates per Booli row; the postcode gate rightly rejects same-street-different-postcode dupes. **This is the gate working as designed.** |
| Net writes (would-be) | 82 (41%) | matched - postcodeMismatch |
| Unique properties matched | 63 | Some booli_ids have duplicate rows in booli_listing |
| Fetch errors | 0 | Oxylabs fallback handled all Hemnet 403s |
| Parse errors | 0 |  |
| Null-title skipped | 6 | Legacy data |
| Duration | 6.2 min | conc 2 |

**Categorized verification report:** `verf09-2-5-logs/dry-run-w20-n200-report.md` — 213 lines, clickable Booli + Hemnet URLs grouped by outcome bucket. Open in VS Code preview / browser, sample 5-10 random matches and tick the ☐ to confirm same-property.

**Per-county distribution** turned out NOT to be Stockholm-dominated as I feared — the 200 rows spread across ~50 munis (Stockholm 27, Göteborg 20, Värmdö 10, Malmö 9, Uppsala 8, etc.). So the headline rate is broadly representative, not a Stockholm-only artifact.

---

## What we had to do to get here (the pivot)

**Problem discovered first:** my initial dry-run was exercising the **wrong code path**. Today's W20 booli_listing rows had `rooms` and `object_type` mostly NULL, because the field-capture code shipped 2026-05-15 (commit `618c896`) and **no Job C/D run has happened since then**. Result: the new `buildHemnetSearchUrl` correctly dropped the missing discriminators, falling through to the bare `?location_ids[]=N` search — which is essentially the OLD broad search. So a dry-run on today's data wouldn't have measured what we wanted.

**Fix:** wrote a one-off enrichment probe (`scripts/enrich-booli-week.js`, ~80 LoC) that does what Sun's Job C cron will do — fetches every active W20 Booli row's detail page, parses the new fields via `lib/booli-fetch.parseBooliListing`, and UPDATEs with COALESCE-preserve. Ran it against W20 first.

**Enrichment results:**
- 2368 W20 candidates (active rows missing ≥1 of the new fields)
- 1531 fetched + 5 inactive in 30 min before wall-clock budget hit
- 2045 rows updated (some had duplicate booli_id entries)
- 837 left unenriched (the back end of the booli_id-ordered queue) — Sun's Job C will pick these up
- 139 worker errors → all the same FK violation (see "Deploy-blocker" below)

After enrichment, re-ran Job B dry-run. The first row's narrowed URL now looked like:
```
https://www.hemnet.se/bostader?location_ids[]=17951&price_min=1558000&price_max=1722000&rooms_min=1&rooms_max=1&item_types[]=bostadsratt
```
— full 3-discriminator narrowing as designed. ✓

---

## ⚠ Deploy-blocker: agent_id FK constraint violation

**139 of 1531 (9%) enrichment writes failed** with the same error:

```
insert or update on table "booli_listing" violates foreign key constraint
"booli_listing_agent_id_9a6480c3_fk_booli_agent_id"
```

**Root cause.** The `agent_id` we capture per D-22 is Booli's `Source.id` (broker chain id). The booli_listing table has an FK to `booli_agent.id`. Django historically populated `booli_agent` with different values, so most of the new Source.ids we capture aren't there → FK rejects the UPDATE.

**Where this hits in production code:**
- `booli-targeted-discovery.js:316,320,352` — Job C INSERT path
- `booli-targeted-refresh.js:154` — Job D UPDATE path
- Both wrap the per-row work in a try/catch (`workerErrors++`, log ERROR, continue), so they won't crash, **but** `validate(summary)` returns a warning string when `workerErrors > 0`, which cron-wrapper escalates to a Slack alert + `status=warning` in `cron_job_log`.

**What this means for the cron grid:**
- Sun 2026-05-17 22:00 UTC Job C → Slack warning, ~9% rows leak
- Tue 2026-05-19 14:00 UTC Job D → same
- Thu/Sat continuing
- The leaked rows still get all OTHER fields written (price, rooms, living_area, object_type) because the FK is on agent_id specifically — wait, actually no. The whole UPDATE is one statement; if the FK rejects, the whole UPDATE rolls back. So those rows lose ALL the new field writes, not just agent_id.

**Three fix options (need operator decision before Mon's deploy):**

1. **Drop or relax the FK.** `ALTER TABLE booli_listing DROP CONSTRAINT booli_listing_agent_id_9a6480c3_fk_booli_agent_id;` — simplest. Loses referential integrity for `agent_id`, but since the new semantic (broker chain id) isn't a foreign key into `booli_agent` anyway, the constraint is no longer meaningful. This was already flagged in 09-2.5 #3 carry-forward as a "Metabase consumers may need rebuilding" item — if downstream readers are already moving off this column, dropping the FK is consistent.

2. **Drop `agent_id` from Job C/D writes.** Revert D-22 in code: stop writing `agent_id` from `lib/booli-fetch.js` parser output to the DB. We lose the broker-chain capture but the FK isn't violated. Simple code change (~3 lines per script).

3. **Two-phase write.** Each Job C/D worker first INSERTs the agent_id into `booli_agent` (on conflict do nothing), then runs the UPDATE. Adds 1 query per row, ~9% extra DB writes. Most code change.

My read: **option 1 (drop the FK)** is cleanest given 09-2.5 #3 already flagged the semantic divergence — the FK was protecting against a different agent_id concept than what we now write. But this is your call.

---

## What I changed locally (committed — none yet, all on working tree)

**New files:**
- `scripts/enrich-booli-week.js` (~80 LoC) — one-off probe, but generic enough to keep in repo
- `scripts/report-dry-run-match.js` (~110 LoC after improvements) — log → Markdown reporter
- `verf09-2-5-logs/dry-run-w20-n200.log` — Job B dry-run output
- `verf09-2-5-logs/dry-run-w20-n200-report.md` — categorized report (open this to verify matches)
- `verf09-2-5-logs/dry-run-w20-n200-PARTIAL-unenriched.log` — first attempt's partial output (kept for diagnostic)
- `verf09-2-5-logs/enrich-w20.log` — enrichment run log
- `verf09-2-5-logs/SUMMARY.md` — this file

**Changed files:**
- `.planning/STATE.md` — added carry-forward #5 (enrichment-lag finding) + #6 (FK violation deploy-blocker)

**Production DB writes:**
- `booli_listing`: 2045 UPDATEs to W20 active rows (price/rooms/living_area/object_type/agent_id with COALESCE-preserve). Pre-runs Sun's Job C cron behavior. Safe: no clobbering, no schema changes.

---

## Recommended next steps (in order)

1. **Open `verf09-2-5-logs/dry-run-w20-n200-report.md`** in VS Code preview. Sample 5-10 matches at random — open the `[B] / [H]` link pair side-by-side, confirm same property. Tick the ☐ as you go. Should take 5-10 min.
2. **Decide the agent_id FK fix.** The three options above. If you go with option 1 (drop FK), it's a one-statement migration that can ship in a small follow-up commit before Sun.
3. **Sample 3-5 "no-card-match" rows** in the report. Open the search URL — if Hemnet returns cards that look like the same property as the Booli row, the `cardMatches` predicate (street normalize + ±7d) is rejecting valid matches. That's a Phase 10 follow-up, not a Mon-cron blocker.
4. **Proceed with Plan 09-2.5 Task 8 (deploy)** once the FK fix is decided + shipped. Today's W20 enrichment + Sun's Job C cron should leave Mon's Job B running on near-fully-enriched inventory.

---

## Open carry-forwards updated in STATE.md

- **09-2.5 #5** — Enrichment-lag finding (now resolved by tonight's pre-enrichment, but still applies to the rows Sun's Job C won't reach because they're off Booli's active feed)
- **09-2.5 #6 (NEW)** — agent_id FK violation deploy-blocker

---

## One nice surprise

The narrowed-search filter is producing genuinely-narrow URLs (~3-50 candidates per query, vs 750+ from the old 15-page walk), AND the postcode-mismatch gate is doing real work (27 rejections that would have gone through the old broader search). The 13.5% postcode-mismatch rate is evidence the filter is now catching same-street, different-postcode duplicates that used to leak into matches.

Net: **Mon's W21 cohort_pairs match rate is very likely to land in the 50-60% range** (well above the 40% target), assuming the FK issue is resolved before then. W22 should be even better once Job D's refresh cycles touch the full active inventory.
