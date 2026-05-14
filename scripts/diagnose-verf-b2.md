# VERF-B2 EXIT=1 diagnostic — booli-targeted-discovery.js

Investigation note for Plan 09-01 Task 1. No code changes here — the fix lives in Task 2 (hardened worker pool + wall-clock budget + stack-capturing log line in `booli-targeted-discovery.js`).

## Observed (verified from verf-b2-logs/wet-run.log)

- Run started 05:36:10.585Z (DB connect, line 2)
- County walks begin 05:36:10.615Z (line 3-4)
- FIRST per-detail-fetch activity: 06:00:01.132Z (a 403 retry, line 1028)
- "processed 25/3419 (inserted: 25, updated: 0, errors: 0)" logged 06:01:27.224Z (line 1147)
- Earlier /annons/ URL (/annons/5435257) parsed successfully 06:02:12.448Z (lines 1212-1213) — rules out deterministic /annons/ parser bug
- Final 4 log lines (1228-1231) show TWO CONCURRENT workers on /annons/ URLs:
  - 06:02:20.404Z /annons/6082242 attempt 1/3 (line 1228)
  - 06:02:20.419Z /annons/6116621 attempt 1/3 (line 1229) — 15ms apart
  - 06:02:21.592Z /annons/6082242 attempt 2/3 (line 1230)
  - 06:02:21.609Z /annons/6116621 attempt 2/3 (line 1231)
- NO attempt 3/3 for either URL. NO oxylabs-fallback line for either. NO "Final:" summary line. NO ERROR line.
- File ends with literal "EXIT=1" written on its own line (line 1232) — this is the `echo EXIT=$? >> wet-run.log` from the dev shell wrapper, NOT the script's own output.

## Phase breakdown

- Search-walk phase: ~24 min (05:36 → ~06:00) — county walks, no per-detail-fetch activity
- Per-detail-fetch phase: ~2m20s (06:00:01 → 06:02:21) before EXIT=1
- Total runtime: ~26 min (this is the headline number, but the death window is the 2m20s detail-fetch tail, NOT the 24-min walk)

## Hypotheses ranked (revised from prior version which assumed progressive resource exhaustion)

1. **Primary: synchronous throw inside lib/booli-fetch.js's /annons/ handling path.** Evidence: log lines 1228-1231 show two concurrent workers hitting /annons/ URLs at the moment of death, both at attempt 2/3 of the direct-curl retry. The script has NO emit for attempt 3/3 or for oxylabs-fallback on either URL — death occurred BETWEEN the attempt-2 log line and the next would-be log line. EXIT=1 has no preceding "Final:" summary line, indicating runJob's main() try/catch (cron-wrapper.js:108-112) never completed. An earlier /annons/ URL (/annons/5435257) parsed successfully, so this is NOT a deterministic /annons/ parser bug — the trigger is the CONCURRENT pair on the same URL prefix, suggesting either (a) a parser path that mutates shared state when two concurrent calls land on the same code branch, (b) the Oxylabs-fallback wrapper synchronously throwing when invoked twice in <20ms, or (c) the worker-pool exception path itself throwing when both workers reject simultaneously.

2. **Secondary: unhandled Promise.reject inside one of the worker tasks** that escapes processDetailFetch's inner try/catch (booli-targeted-discovery.js:234-305) and rejects the outer worker promise. processDetailFetch wraps every step but the worker function itself (line 464-479) is NOT wrapped — if processDetailFetch synchronously throws (e.g. typo, undefined property access on its outer try, or rejection bubbling from a sub-promise the inner catch didn't bind), the worker rejects, Promise.all([worker(), worker()]) rejects, escapes main(), and is caught by cron-wrapper's handleFatal (cron-wrapper.js:67-78) which process.exit(1)'d before the buffered "ERROR: Uncaught" line flushed. This is the hypothesis Task 2's edit addresses (wrapping the worker while-loop body in try/catch with stack capture).

3. **Tertiary (formerly primary in pre-correction plan): DB connection death mid-run.** Downgraded because the run died after only ~2m20s of detail-fetch activity, NOT the full 26-min runtime — TCP keepalive lapse is implausible on that timeline. The cron-wrapper sets statement_timeout=120s. processDetailFetch:298 catches upsert errors inside its outer try, BUT the rejection could escape from the `await sleep(jitter())` on line 469 (sleep can't reject under normal conditions but documents the pattern).

4. **Quaternary: external SIGKILL.** A wrapper timeout or operator Ctrl-C. cron-wrapper.js has no SIGINT/SIGTERM handler, so a SIGKILL/SIGINT would terminate silently with no ERROR line. Implausible given the wet-run was unattended overnight per the operator's notes; included for completeness.

## Read this log to investigate further

- `verf-b2-logs/wet-run.log` lines 1147-1232 — the full per-detail-fetch tail. The 80 lines preceding EXIT=1 show all in-flight worker state at the moment of death.
- `lib/booli-fetch.js` /annons/ branch — any code path that diverges from /bostad/ handling is the suspect for hypothesis #1.

## Fix direction

Both hypotheses #1 and #2 are addressed by the SAME fix: wrap worker()'s while-loop body in a try/catch that captures `err.stack`, increments summary.workerErrors, and continues. Add wall-clock budget check at top of while-loop. Force a Final: summary write before any process exit path. (Implemented in Task 2.) The captured stack trace from the worker-uncaught log line will identify WHICH hypothesis is correct on the first VERF-09-1 wet-run that fires it.

## Out of scope

- DB keepalive tuning (separate phase if it surfaces again)
- Forensic investigation of WHICH specific /annons/ code path triggers the rejection (Task 2 captures the stack trace; analyze on first incident)
