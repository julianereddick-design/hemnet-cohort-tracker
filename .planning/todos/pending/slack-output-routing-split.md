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
