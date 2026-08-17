# Alerting Phase 4 — tiering, ladder, debounce, sweep

**Spec:** `docs/superpowers/specs/2026-08-17-alerting-structure-design.md` §4.2, §4.4, §7 Phase 4.
**Base:** master `999499d` (Phases 0–3 + 3.1 shipped and live).

Phases 0–3 made the channel **honest**. Phase 4 is what makes it **quiet**. The §8 success
measure is not met until this lands: the baseline to beat is 59 alerts in 60 days, of which 3
mattered and were missed.

---

## The four mechanisms, and what each one alone fails to fix

| Mechanism | Kills | Would be wrong alone because |
|---|---|---|
| Tier gating | ~56 of the 59 baseline alerts (`spotcheck-reaction-poller`, tier 2, warned on 93% of its runs) | a tier-1 job repeating a real failure would then be suppressed too |
| Re-notify ladder | silence on a standing tier-1 failure | without suppression it is just the old noise on a timer |
| `conditionKey` suppression | repeat alerts for the *same* condition | text-based signatures suppress nothing here — the four highest-volume validators embed pair-id lists, live counts and the week's cohort id |
| Flap debounce N=2 | a job oscillating across a threshold alerting in *both* directions | `cohort-track` straddles a hard `>50%` boundary as a cohort decays, every 2 days — without debounce this **doubles** volume |

## Decisions

1. **Tier 2 posts nothing to Slack.** Spec §4.2 is normative: "tier 2 → log row only, no Slack."
   Its standing state is already visible — Phase 3.1's liveness section renders
   `age-census-report (tier 2) last run failure: …` in the digest. Implemented behind a single
   `TIER2_ALERTS_ENABLED = false` constant so it is one line to revisit.
   ⚠️ **§7's acceptance line says a tier-2 warning repeated 5 runs should produce "exactly 1
   alert"**, which contradicts §4.2. Flagged for the operator; built to §4.2.

2. **`validate()` gains a structured return, backward-compatibly.** Today validators return a
   string or falsy. New shape `{ key, severity, message }`. A string keeps working and normalises
   to `key: null`.

3. **`key: null` never suppresses.** A validator with no key alerts every time. The safe
   direction: an un-keyed condition is unknown, and unknown must not be silently swallowed. It
   also creates pressure to add keys rather than letting them rot.

4. **State lives in a new `alert_state` table**, not in `cron_job_log`. The ladder needs "when did
   we last alert", the debounce needs a consecutive-clear counter, and the sweep needs its own
   incident scope. None of those are run-scoped facts, so they do not belong on a run row.

5. **`--sweep` is the same script, not a second one.** Spec §4.4: two scripts sharing 90% of
   their logic is how the null-view check came to be re-implemented badly in one place after
   being fixed in another.

## The `alert_state` table

```sql
CREATE TABLE IF NOT EXISTS alert_state (
  scope             TEXT        NOT NULL,   -- 'run' (cron-wrapper) | 'sweep' (watchdog)
  script_name       TEXT        NOT NULL,
  condition_key     TEXT        NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  first_alerted_at  TIMESTAMPTZ,
  last_alerted_at   TIMESTAMPTZ,
  alert_count       INTEGER     NOT NULL DEFAULT 0,
  consecutive_clear INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, script_name, condition_key)
);
```

`scope` keeps the two mechanisms apart. Spec §4.4 is explicit that incident-scoped sweep
suppression is a *different* mechanism from the per-run transition rule and must not be
conflated with it.

## The ladder

Offsets from **first alert**: `0h, +24h, +72h`, then every 24h while unresolved. Measured from
`first_alerted_at`, not from the previous alert, so a missed sweep cycle cannot slide the whole
schedule to the right.

Rationale (§4.2): the one perfectly stable error signature in the codebase —
`market-totals-daily`'s `Expected 4 rows upserted, got N` — belongs to a tier-1 **daily** job.
Naive suppression would alert on day 1 and silently eat every subsequent permanently-lost
snapshot.

## Flap debounce

A condition is cleared only after **N=2** consecutive runs without it. Re-appearing at
`consecutive_clear = 1` continues the same incident: no new alert, ladder unbroken.

## Tasks

1. `lib/alert-policy.js` — pure decision logic. No DB, no Slack, no clock. TDD.
2. `migrate-alert-state.js` + `lib/alert-state.js` — the store.
3. Wire into `cron-wrapper.js`; add `conditionKey`s to the tier-1 validators that actually fire.
4. `--sweep` in `cron-health-slack.js`; storm cap; registry cron lines at 01/11/17/23.

## Acceptance (spec §7)

- A tier-2 warning repeated 5 runs produces **0** Slack alerts (built to §4.2; see decision 1)
  and a digest line reading "continuing since X, 5 consecutive".
- A tier-1 failure repeated 5 runs produces alerts on the **ladder**, never silence.
- A simulated all-jobs-down produces **one** rolled-up sweep message, not N.
