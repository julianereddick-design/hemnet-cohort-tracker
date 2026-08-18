# Operator Handover — Hemnet Cohort Tracker

**Start here → [`01-HANDOVER-OVERVIEW.md`](01-HANDOVER-OVERVIEW.md)** — the single cohesive overview:
what the system is, how it fits together, the weekly rhythm, the new-operator runbook, and the top risks.

Then go deeper as needed:

1. [`01-HANDOVER-OVERVIEW.md`](01-HANDOVER-OVERVIEW.md) — **master overview** (read first).
2. [`02-DATA-STREAMS-AND-JOBS.md`](02-DATA-STREAMS-AND-JOBS.md) — every scraper/job: source, method, output tables, schedule, manual run command.
3. [`03-INFRASTRUCTURE-AND-OPERATIONS.md`](03-INFRASTRUCTURE-AND-OPERATIONS.md) — droplets, database, secrets, Oxylabs cap, deploy, cron, monitoring, disk.
4. [`04-REPORTING-AND-SLACK.md`](04-REPORTING-AND-SLACK.md) — every Slack report and chart/export, with safe dry-run instructions.
5. [`05-MONITORING-AND-ALERTS.md`](05-MONITORING-AND-ALERTS.md) — **every alert you can receive, what it means, and why each job is monitored.** Read this before you are on call.

**Authoritative runbook:** [`../../deploy-instructions.md`](../../deploy-instructions.md) (per-job failure modes).
**Technical map:** [`../../.planning/codebase/`](../../.planning/codebase/) (`STACK`, `ARCHITECTURE`, `STRUCTURE`, `CONVENTIONS`, `TESTING`, `INTEGRATIONS`, `CONCERNS`).

*Generated 2026-07-28 from a full codebase examination. Doc `05` added and the monitoring
sections of `02` and `04` corrected on 2026-08-18, after the alerting rebuild shipped — treat
any monitoring claim in a pre-2026-08-17 revision as describing the previous system.*
