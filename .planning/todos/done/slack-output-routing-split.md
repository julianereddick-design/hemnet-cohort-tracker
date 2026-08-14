---
title: Split Slack outputs — business reports to #hemnet-status, ops + human review to an ops channel
priority: high
area: reporting/slack
status: pending
created: 2026-08-13
resolves_phase: null
---
Today every Slack output is split by **transport**, not by **audience**, and the split is
backwards for the review queue.

**Current state (verified 2026-08-13):**
- `SLACK_REVIEW_CHANNEL = C0B9X2WDC4C = #hemnet-status`. So the bot-token stream — the
  spot-check per-pair review queue AND the sold-match match-rate report — both land in
  #hemnet-status.
- The webhook stream (`SLACK_WEBHOOK_URL`: cron failure alerts, daily health report, market
  supply pulse, pre-market flow pulse, weekly cohort view report) lands somewhere else —
  Julian sees it in the Claude Code app. No health report or market pulse appears in
  #hemnet-status going back to 2026-07-06.

**Desired state (Julian, 2026-08-13):**
- **#hemnet-status** — business outputs: sold-match match rate, market supply pulse,
  pre-market flow pulse, weekly cohort view report.
- **Ops channel** — job failure/warning alerts, daily health report, AND the spot-check
  review queue (the pairs needing human eyes) + its stale-review escalation.

**The blocker:** a Slack incoming webhook posts only to the channel it was created against —
it cannot be re-pointed in code, so it can never serve two destinations. Worse, if the ops
destination is the Claude Code **app DM** rather than a real channel, the bot cannot post
there and cannot read reactions there — which would break the ✅/❌/❓ mechanism the review
queue depends on (`spotcheck-reaction-poller.js` → `getReactions`).

**Proposed approach:** retire `SLACK_WEBHOOK_URL` entirely and route everything through
`lib/spotcheck-slack-bot.js` (bot token, `chat.postMessage`) with two env vars —
`SLACK_REPORTS_CHANNEL` and `SLACK_OPS_CHANNEL`. Four scripts (`cron-health-slack.js`,
`market-totals-weekly-report.js`, `premarket-flow-weekly-report.js`, `weekly-view-report.js`)
drop their duplicated `sendSlack()` in favour of the shared helper; `cron-wrapper.js`'s
`sendSlackAlert` follows. Side benefit: unblocks Slack file upload (needs `files:write`),
which is what currently strands the ad-cost heat map and market-totals dashboard —
see [[reports-built-but-not-delivered]].

**Needs from Julian:** the ops channel's `C0…` ID (a real channel, not an app DM), and a
`/invite` of the bot into it. Recommendation on file: create a new `#hemnet-ops`.

Blocks nothing, but should ship together with [[sfpl-retirement-and-health-window-fix]] so the
droplet takes one deploy rather than two.

---

**Closed 2026-08-14.** Shipped as designed in `docs/superpowers/specs/2026-08-14-slack-reporting-routing-design.md`
§3 (D), approved by Julian 2026-08-14, implemented across commits `f95617a..90b75e8` on
`worktree-reporting-ops-design-efg` (Tasks 1-7 of `docs/superpowers/plans/2026-08-14-slack-routing.md`).
`lib/slack-post.js` is now the sole outbound path (`postMessage`/`postAlert`), routing every job
by name through a single `AUDIENCE` table instead of by credential — business reports
(`weekly-view-report`, `market-totals-weekly-report`, `premarket-flow-weekly-report`,
`sold-match-report`, `age-census-report`) go to `#hemnet-status`; ops output
(`cron-health-slack`, `cohort-spotcheck-gate`, `spotcheck-reaction-poller`, `cron-wrapper`) goes
to the new `#hemnet-ops` (`C0BQ66YQX8S`, created 2026-08-14). `SOLD_MATCH_SLACK_CHANNEL` was
dropped outright; `SLACK_REVIEW_CHANNEL` is retained only as `SLACK_OPS_CHANNEL`'s fallback.
Operator actions (channel creation, bot invite, new ops-bound webhook) and the droplet `.env`
update are done; `files:write` remains a separate, not-yet-needed follow-up (see
`docs/handover/04-REPORTING-AND-SLACK.md` §5). See `deploy-instructions.md` "Slack routing
(audience split)" for the operator runbook.
