# Phase 12: Cohort match spot-check weekly QA gate - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning
**Source:** PRD Express Path (COHORT-SPOTCHECK.md)

<domain>
## Phase Boundary

Turn the **validated manual** cohort match spot-check (tools built and run in-session against
cohort 2026-W23 on 2026-06-10) into a **weekly, automated quality gate** that runs immediately
after `cohort-create` succeeds each week.

The gate samples each new cohort, verifies sampled Booli↔Hemnet pairs are the same physical
property using the independent signals the matcher ignores (live re-fetched price/area/type +
photo confirmation), renders a per-pair verdict, computes the confirmed false-match rate with a
confidence interval, logs the run, and escalates on a high rate or on fetch failure.

**Why it matters:** the tracker treats each Booli↔Hemnet pair as one physical property for the
whole H/B view-ratio analysis. A wrong pair silently pollutes the dataset. The matcher decides
pairs on address (street + postcode) + listed-date proximity only — price/area/rooms/type narrow
the Hemnet search at seeding but are **never re-checked at pairing time**, so two different units
sharing a street+postcode+listing week (common in apartment buildings) can be paired wrongly
(caught this run: Bollmoravägen 2, Tyresö). The gate measures that false-match rate continuously.

**In scope:** the weekly automated gate — orchestration, adjudication, summary/CI, logging,
escalation — built on the **already-existing** spot-check tools (do not rebuild them).
**Out of scope (this phase):** fixing the matcher itself (see Deferred — §9 of the PRD).

</domain>

<decisions>
## Implementation Decisions

### Trigger & orchestration
- The gate runs **immediately after `cohort-create` succeeds** each week, against the
  newly-created cohort. Fresh cohort ⇒ listings are live ⇒ photo coverage near-complete and
  UNCERTAIN should be rare.
- Run under `cron-wrapper.js` so it logs to `cron_job_log` like the other scheduled jobs.

### Sampling (Layer 1) — already implemented in `cohort-spotcheck.js`
- Sample **stratified by county**, deterministic via seeded md5 ordering (same seed → same
  sample; seed defaults to `cohort_id`). Weekly default **20%** (decided 2026-06-10 — see
  Sampling rate decision below), min **2 per county**. The underlying tool supports any rate
  via `--rate`.

### Field test (Layer 2) — already implemented in `lib/spotcheck-evidence.js` + `cohort-spotcheck.js`
- Re-fetch each Hemnet listing **live** (`lib/hemnet-fetch.js fetchDetail`) for current asking
  price, living area, housing form; compare to stored Booli price/area/type; compute deltas.
- Triage (ordering only, not the verdict):
  - **area gap ALONE, price agrees** → `likely-match` (boarea-vs-total measurement convention —
    not a different unit; area-gap-alone no longer escalates).
  - **area AND price both diverge** (or price missing, apartment-vs-house, postcode mismatch) →
    `suspect`.
  - re-fetch failed + Booli fields null → `low-signal`.

### Photo confirmation (Layer 3) — already implemented in `spotcheck-photos.js` + `lib/spotcheck-photos.js`
- Pull **both galleries** and look for one shared room/exterior. Booli photos fetched from
  `https://www.booli.se/annons/<booli_id>` (our `booli_id` is always the **ad** id, so this
  always resolves to the current listing; `/bostad/<residenceId>` can show prior-sale photos).
- Confirmation rule (final):
  | Verdict | Requires |
  |---|---|
  | **CONFIRMED MATCH** | price agrees **AND** ≥1 photo clearly the same place (one shared room or exterior) |
  | **CONFIRMED MISMATCH** | area and/or price diverge **AND** no shared photo across galleries |
  | **UNCERTAIN** | no photos available, or fields agree but no shared shot, or photos ambiguous |
- **Price alone never confirms a match.** A shared photo is the unique confirmer. Logic is
  **asymmetric**: one shared photo *confirms*; a mismatch needs field divergence **plus** no
  shared photo (full-gallery "one shared room", not hero-vs-hero).

### Summary, CI & escalation
- Summarise: confirmed false-match rate + **Wilson confidence interval**, by county; list every
  mismatch with `pair_id`, both URLs, and why.
- **Escalate via Slack** when the confirmed false-match rate exceeds the threshold (default
  **> 5%**) OR on fetch failure. (Consistent with the project's monitor-escalation practice.)
- Log the run to `cron_job_log` via `cron-wrapper.js`; retain the per-cohort artifact directory.

### Locked parameters
- Sample rate **20%** (weekly); county stratification on; price-agreement tolerance **≤ 5%**;
  area boarea-tolerance **~7–12%**; escalation threshold **> 5%** confirmed false-match rate.

### Sampling rate decision (2026-06-10)
Chose **20% weekly** (≈285 of ~1,400 pairs) over the original 8%. Rationale: at 8% the 95% Wilson
CI on the observed ~1.8% rate runs 0.5–6.3% — its upper bound sits *above* the 5% escalation
threshold, so the gate cannot certify "under 5%". 20% pulls the CI upper bound below 5%, making
the gate statistically meaningful. **Cost is not a constraint:** live Oxylabs usage (queried
2026-06-10) is ~52k Web Scraper calls/week against a ~264k/month plan (~76–85% utilized, ~55k
spare/month); the gate at 20% adds ~3.1k calls/month ≈ **+1.2% of plan** (vs ~0.5% at 8% — a
sub-1pp difference). Weekly cadence is a firm requirement (a monthly deep-sample does not help —
each new cohort must be checked the week it is created). Weekly **census rejected** (~+6% plan,
~29% of spare headroom, sqrt-law diminishing returns). Rate stays overridable via `--rate`; the
first wet-run's self-reported `oxylabs.callCount` will replace the ~2.5-calls/pair estimate.

### Reuse (do not rebuild)
- `cohort-spotcheck.js`, `lib/spotcheck-evidence.js` (`--smoke` 30 tests), `spotcheck-photos.js`,
  `lib/spotcheck-photos.js` (`--smoke` 10 tests). Shared infra: `db.js`, `lib/scrape-http.js`,
  `lib/hemnet-fetch.js`, `lib/booli-fetch.js`. Image CDNs download directly; only HTML pages use
  the scrape layer / Oxylabs.

### Claude's Discretion
- Exact wiring of the orchestration entrypoint (new wrapper script vs. extending an existing
  weekly runner), artifact retention period, Slack message format, and how the verdict/summary
  JSON schema is shaped — choose to match existing project conventions (`cron-wrapper.js`,
  existing cron jobs, existing artifact layout).

### ⚠ FLAGGED DECISIONS (defaults chosen — confirm or override at review)
- **Adjudication mode A vs B (PRD §7) — KEY FORK.** Default chosen: build the deterministic
  pipeline (sample → field evidence → photo pull → summary/CI/log/escalate) **mode-agnostic**,
  and implement **Mode B** (Claude API vision over the downloaded gallery images, **gated behind
  the deterministic field triage** so the model only judges pairs that need it) as the automated
  adjudicator — this is what makes the weekly run hands-off, the stated target. **Mode A**
  (human opens the artifact in a Claude Code session and labels pairs) remains the manual
  fallback and the deterministic pipeline must produce a complete artifact usable without the
  API. Mode B adds `@anthropic-ai/sdk` + an API key and per-run vision cost (bounded by triage).
  *Override to Mode-A-only if you'd rather defer the API integration while thresholds settle.*
- **Escalation threshold** default **> 5%** — adjust once a few weeks of baseline rates land.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The spec
- `COHORT-SPOTCHECK.md` — the full design doc and build target (§7 = weekly process design,
  §8 = confidence model, §9 = deferred matcher fix).

### Existing spot-check tools (reuse — do not rebuild)
- `cohort-spotcheck.js` — Layer 1 sample + Layer 2 field evidence; read-only; writes
  `verf-spotcheck-<cohort>-<ts>/spotcheck-<cohort>.json` + `.md`.
- `lib/spotcheck-evidence.js` — pure delta + triage logic (`--smoke` 30 tests).
- `spotcheck-photos.js` — enriches the artifact with photos; writes `PHOTOS-<cohort>.md` + `photos/`.
- `lib/spotcheck-photos.js` — hero/gallery URL extraction + image download (`--smoke` 10 tests).

### Pipeline & infra to integrate with
- `cohort-create.js` — upstream job; gate triggers after it succeeds.
- `cron-wrapper.js` — run/logging wrapper (`cron_job_log`); escalation/alerting path.
- `db.js` — DB client (note: droplet has no psql; query prod DB via committed Node script).
- `lib/scrape-http.js`, `lib/hemnet-fetch.js`, `lib/booli-fetch.js` — fetch layer (direct→Oxylabs).

</canonical_refs>

<specifics>
## Specific Ideas

- Validated baseline (cohort 2026-W23): sampled 116 of 1,434 pairs (8.1%); field-test
  false-match rate ≈ **1.8% (2/112, 95% CI 0.5–6.3%)**.
- Confirmed false match: **16347 Bollmoravägen 2** — Booli 64.5 m²/2,150,000 vs Hemnet
  75.5 m²/2,495,000, same building, different units.
- True match flagged in error: **15647 Storvretsvägen 44** — identical price + listed date; the
  61.5 vs 72.3 m² gap was boarea-vs-total convention (drove the triage refinement).
- Booli URL distribution latest cohort: 62% `/bostad/`, 38% `/annons/`. The `/annons/<booli_id>`
  fix is already applied in `spotcheck-photos.js`.

## Success criteria (from PRD §7)
- Every sampled pair gets a verdict (CONFIRMED MATCH / CONFIRMED MISMATCH / UNCERTAIN).
- Confirmed false-match rate computed with a confidence interval (Wilson), by county.
- Mismatches listed with evidence (pair_id, both URLs, why).
- Run logged (`cron_job_log` via `cron-wrapper.js`); alerts on a high rate or on fetch failure.

</specifics>

<deferred>
## Deferred Ideas

- **Fix the matcher, not just measure it (PRD §9):** add an area/price tie-break to
  `cohort-create.js` — among same-postcode+street candidates prefer the closest living area, and
  drop/flag pairs with a large area **and** price gap. Would have prevented 16347 at creation
  time. Explicitly **separate from this spot-check phase**; the gate then verifies the fix holds.

</deferred>

---

*Phase: 12-cohort-match-spot-check-weekly-qa-gate*
*Context gathered: 2026-06-10 via PRD Express Path*
