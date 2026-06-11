# Phase 13 — Findings & open design forks (input to discuss-phase)

**Captured:** 2026-06-11. Source: live experiment during the Phase 12 close-out session
(dHash/pHash probe on real W23 photos + in-session Claude-vision adjudication of the two
suspect pairs). This doc is the evidence base for `/gsd-discuss-phase 13`.

---

## Why this phase exists — Phase 12 Mode A is incomplete on its own

The shipped Phase 12 gate (Mode A) samples, re-fetches fields, triages, pulls galleries, and
writes an artifact — but its adjudication only checks photo **presence**, not content. Concretely:

- Mode A verdict branches collapse to: `likely-match + price-agrees + photos` → **CONFIRMED_MATCH**;
  everything else (every `suspect`, no-photo, price-disagree) → **UNCERTAIN**.
- Mode A **structurally cannot emit CONFIRMED_MISMATCH** (that branch needs `sharedPhoto === false`,
  which only a vision/content check sets — Mode A leaves it `null`). So its computed
  false-match **rate is always 0**, and the `rate > 5%` Slack escalation can never fire.
- Net: run headless on cron, Mode A is **silent in Slack** (only fetch-failures alert) and just
  builds a pile of UNCERTAIN pairs in a file nobody looks at.

Phase 13 makes the gate actually detect false matches and put a human (or vision) on the
UNCERTAINs.

---

## Experiment 1 — deterministic image hash (dHash vs pHash) on real W23 galleries

Probe: `scripts/spotcheck-phash-probe.js` (jimp, installed `--no-save`). For each pair with both
galleries on disk, cross-compared every Booli image against every Hemnet image (nested loop),
kept the closest (min Hamming distance). Ground truth from the artifact JSON.

| pair | truth | dHash min | pHash min | note |
|---|---|---|---|---|
| 16130 | MATCH (likely) | 3 | 4 | shared hero photo |
| 16149 | MATCH (likely) | 6 | 8 | shared hero |
| 16086 | MATCH (likely) | 8 | 8 | shared hero |
| 16109 | MATCH (likely) | 11 | 2 | shared hero |
| 15647 | MATCH (suspect) | 19 | 20 | NO shared shot (different-era photos) |
| 16347 | MISMATCH (suspect) | 24 | 22 | genuinely different units |

**Conclusions:**
- A hash cleanly confirms pairs that **literally share a photo** (the 4 likely-match pairs, all
  ≤11; the true-mismatch far off at 22–24). This is a real, free upgrade over Mode A's
  presence-only check. **dHash chosen** (simple; pHash narrowed the safety margin, didn't help
  the hard case).
- A hash **cannot** confirm "same room, different photos" — 15647 (true match) sits at 19–20,
  only 2–5 bits from the true-mismatch at 22–24. No safe threshold separates them.
- Operating point to validate on more data: **dHash ≤ ~10 → image-confirmed**; above that the
  hash is uninformative → escalate.
- **Caveat:** n=6, one mismatch. Threshold + false-confirm rate need calibration on more pairs
  (esp. more known mismatches).

## Experiment 2 — Claude vision on the two suspects (in-session, = what Mode B would do)

- **16347 Bollmoravägen** (truth MISMATCH): Booli = brown-sofa striped-wallpaper apartment, white
  kitchen w/ pink curtains; Hemnet = bright white apartment w/ artichoke lamp + French balcony,
  ghost chairs, cast-iron balcony, different floor. **No shared room → MISMATCH confirmed.** ✓
- **15647 Storvretsvägen** (truth MATCH, identical price 1,495,000 + same address + date): Booli =
  *renovated* modern flat (marble kitchen); Hemnet = *unrenovated* flat (mint-green kitchen with
  **king penguins photoshopped in**). **No shareable room** — almost certainly Booli `/bostad/`
  showing **prior-sale photos** vs Hemnet's current listing (the trap COHORT-SPOTCHECK.md §4 warned
  of). **Vision also cannot confirm it** — the match is only knowable from field evidence.

**Key lesson:** for prior-sale-photo pairs, *neither* hash nor vision can confirm a true match.
Such pairs must rest on field evidence (price+address+date) and end **UNCERTAIN**, never MISMATCH.

URLs (for reference / re-evaluation):
- 15647 — Booli https://www.booli.se/bostad/751018 · Hemnet https://www.hemnet.se/bostad/21737846
- 16347 — Booli https://www.booli.se/bostad/336255 · Hemnet https://www.hemnet.se/bostad/21735881

---

## Bug found (must fix in this phase, before vision goes live)

`lib/spotcheck-adjudicate.js` mismatch branch is:

```
provisional === 'suspect' && sharedPhoto === false  →  CONFIRMED_MISMATCH
```

It does **not** check that price/area actually diverged. So once vision runs on suspects and
correctly returns `sharedPhoto === false` for 15647 (price-agreeing true match), the gate would
**falsely label 15647 a CONFIRMED_MISMATCH.** Spec (COHORT-SPOTCHECK.md §3) requires
*"price/area diverge AND no shared photo."* Fix: add the price-divergence guard so a price-agreeing
pair can never become a confirmed mismatch (it stays UNCERTAIN). Safe in Mode A today
(`sharedPhoto` is always `null`), so it only bites once vision is wired — fix it as part of this phase.

---

## Proposed pipeline (to confirm in discuss-phase)

```
sample 20% → fields/triage → pull galleries
  → dHash cross-compare (free):  min ≤ T  → CONFIRMED_MATCH (shared image)
  → suspect & not hash-confirmed → Claude vision → MATCH / MISMATCH (with price-divergence guard)
  → still unresolved             → UNCERTAIN → Slack review queue (human)
```

## Open design forks for discuss-phase

1. **Human feedback storage & loop** — how does a Slack verdict get back in? (CLI like
   `node spotcheck-verdict.js --pair 16347 --verdict MISMATCH`, a `spotcheck_manual_verdicts`
   table, …) and **does a confirmed MISMATCH auto-pull the pair from `cohort_pairs`** (correcting
   the H/B view-ratio dataset) or only flag it? ← biggest fork.
2. **Slack format** — one weekly digest listing all UNCERTAIN pairs (pair_id, address, both URLs)
   vs one message per pair. **Dedup**: don't re-ping the same persisting UNCERTAIN every week.
3. **Vision scope** — vision on `suspect` only (cheap) vs all-not-hash-confirmed; or skip vision
   entirely and send all unresolved straight to the human (vision just reduces manual load).
4. **dHash threshold** — start at ≤10 (provisional) and calibrate from live runs; how to log/track
   the false-confirm rate.
5. **Image lib as a real dependency** — jimp (pure-JS, used in the probe) vs sharp (faster, native).
6. **Cohort-week guard** — gate verifies the resolved cohort matches the current ISO week; warn/skip
   if cohort-create hasn't produced this week's cohort yet (the Mon 06:00 → 06:30 buffer is
   unverified; check `cohort-create` duration in `cron_job_log`).
7. **Deploy sequencing** — fold the Phase 12 gate's go-live into this phase so it ships *with* the
   review loop (vs scheduling a silent Mode-A job first).

## Artifacts from the experiment
- `scripts/spotcheck-phash-probe.js` — dHash+pHash cross-compare probe (reusable for calibration).
- `verf-spotcheck-2026-W23-20260610-131907/` — the real galleries used (untracked).
