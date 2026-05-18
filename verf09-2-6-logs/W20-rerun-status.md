# Plan 09-2.6 W20 recovery — rerun outcome

**Resolution:** ✅ **SUCCESS.** W20 cohort_pairs rebuilt 441 (partial) → **1,535** (target 1,200–1,800).

---

## TL;DR

| Stage | Outcome |
|-------|---------|
| **First attempt** (Mon 11:21 UTC) | FAILED via SIGHUP on DigitalOcean web console disconnect. cron_job_log row 418 left ghost-running for 3+ hours. No code bug — deploy-process gap (cron-wrapper has no SIGHUP handler; operator launched without nohup/tmux). |
| **Rerun** (Mon 21:14:51 UTC, nohup) | Job 419 completed in 40.7 min, status=`warning`, **945 matches (60.8% rate)**, **0 worker errors**, 0 fetch errors, 277 fresh INSERTs + 502 UPDATEs to hemnet_listingv2. All go/no-go gates passed. |
| **W20 cohort rebuild** (Mon 23:23 UTC, local) | DELETE 441 partial pairs / 4,806 unmatched / 441 daily_views in one tx, then `node cohort-create.js 2026-05-11`. Result: **1,535 cohort_pairs at 47.7% join rate** (Stockholms 813 / Västra Götalands 334 / Skåne 263 / Uppsala 125). |

## Why the first attempt failed (root cause)

Operator kicked off `node hemnet-targeted-match.js` (no nohup, no tmux) via DigitalOcean's web console. When the console session disconnected, the TTY sent SIGHUP to the node process. `cron-wrapper.js:79-80` only registers handlers for `uncaughtException` and `unhandledRejection` — no SIGHUP / SIGTERM / SIGINT — so the process died without running its finalize block. `cron_job_log.id = 418` stayed on `status='running'` forever. Cleaned up via `scripts/unstick-cron-row-418.js`.

The autonomous monitor watched the ghost row for 3h 14min with 0 INSERTs before triggering its 3h stall ceiling. **Should have escalated at the 1h mark** — captured as `feedback_loops_escalate_anomalies` memory.

## Why the rerun succeeded

Launched as:
```bash
nohup node hemnet-targeted-match.js > /tmp/hemnet-match-w20-rerun.log 2>&1 &
disown
```

`nohup` makes the process ignore SIGHUP, `disown` removes it from the shell's job table. Process survives any console disconnect.

## Headline numbers

```
hemnet-targeted-match cron_job_log.id = 419
  status:      warning      ("high postcode-mismatch rate: 157/1553 (10.1%)" — gate working as designed; same finding as 09-2.5 dry-run at 13.5%)
  started_at:  2026-05-18T21:14:51.671Z
  finished_at: 2026-05-18T21:55:32.818Z
  duration:    40.7 min

result_summary excerpt:
  booliCount:         1553   (delta filter shrunk scope from ~5500 → 1553)
  matchedFromSearch:  945    (60.8% match rate; beats validated 54.5% baseline)
  workerErrors:       0
  fetchErrors:        0
  parseErrors:        9
  rowsInserted:       277    (new hemnet_listingv2 rows)
  rowsUpdated:        502    (existing rows refreshed)
  budgetExceeded:     false
  postcodeMismatch:   157
  detailFetched:      936

W20 cohort (post-rebuild):
  cohorts:            1
  cohort_pairs:       1535   (was 441 pre-recovery; in 1200-1800 target band ✓)
  cohort_unmatched:   1682
  cohort_daily_views: 1535   (one per pair)
```

## What's next

- **Mon 2026-05-25 03:00 UTC** — Next Hemnet match cohort cron firing. First production exercise of 09-2.6 code on its natural schedule. Verification gate: status=success/warning, duration < 90 min, budgetExceeded=false, summary.booliCount >= 1500, summary.workerErrors == 0.
- **Phase 10 carry-forwards opened by this recovery:**
  - **09-2.6 #1** — Add SIGHUP/SIGTERM/SIGINT handlers to cron-wrapper.js (~5 lines)
  - **09-2.6 #2** — Add functional index on hemnet_listingv2(LOWER(TRIM(street_address))) to unlock the fuller delta filter

## Files of note

- `verf09-2-6-logs/cohort-create-w20-recovery.log` — cohort rebuild log (this dir)
- `scripts/check-hemnet-match-w20.js` — reusable monitor probe (use for next recovery)
- `scripts/unstick-cron-row-418.js` — one-shot ghost-row cleanup (template for next SIGHUP victim)
- `scripts/delete-w20-cohort.js` — one-shot W20 wipe across all four cohort tables (in one tx)
- `verf09-2-5-logs/W20-recovery-overnight.md` — first-attempt failure post-mortem
- `.planning/phases/09-production-cutover-self-hosted-scraper-launch/09-2.6-SUMMARY.md` — full plan summary
