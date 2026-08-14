'use strict';

// ---------------------------------------------------------------
// Routing table. A job's NAME decides its audience; no caller ever
// names a channel. Adding a reporter means adding a row here — a job
// missing from the table throws at call time (see resolveChannel),
// because a reporter with no declared audience is a bug, not a default.
// ---------------------------------------------------------------
const AUDIENCE = {
  // business — what the operator reads for insight, in #hemnet-status
  'weekly-view-report': 'business',
  'market-totals-weekly-report': 'business',
  'premarket-flow-weekly-report': 'business',
  'sold-match-report': 'business',
  'age-census-report': 'business',

  // ops — what the operator reads to run the system, in the ops channel
  'cron-health-slack': 'ops',
  'cohort-spotcheck-gate': 'ops',        // the per-pair human review queue
  'spotcheck-reaction-poller': 'ops',    // stale-review escalation
  'cron-wrapper': 'ops',                 // job failure/warning alerts
};

const ENV_BY_AUDIENCE = {
  business: ['SLACK_STATUS_CHANNEL'],
  // SLACK_REVIEW_CHANNEL is retired but honoured while SLACK_OPS_CHANNEL is
  // unset, so the code and the .env edit can land in either order.
  ops: ['SLACK_OPS_CHANNEL', 'SLACK_REVIEW_CHANNEL'],
};

function resolveChannel(job) {
  const audience = AUDIENCE[job];
  if (!audience) {
    throw new Error(
      `slack-post: job "${job}" is not in the routing table. Add it to AUDIENCE in lib/slack-post.js ` +
      `with an explicit 'business' or 'ops' audience.`
    );
  }
  const names = ENV_BY_AUDIENCE[audience];
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`slack-post: job "${job}" is ${audience} but ${names[0]} is not set`);
}

// dotenv re-injects tokens from .env, so `env -u` does NOT prevent a post.
// These two flags are the only reliable guards. DRY_RUN=1 is the convention
// already used by age-census-report.js and scripts/age-census-monthly.js.
function isDryRun() {
  return process.env.SLACK_DRY_RUN === '1' || process.env.DRY_RUN === '1';
}

module.exports = { AUDIENCE, resolveChannel, isDryRun };

// ---------------------------------------------------------------
// --smoke self-test (offline: no network, no DB, no Slack)
//   node lib/slack-post.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  const { AUDIENCE, resolveChannel, isDryRun } = module.exports;
  let pass = 0, fail = 0;

  function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); pass++; }
    catch (e) { console.error(`  FAIL  ${name}: ${e.message}`); fail++; }
  }

  const saved = {
    status: process.env.SLACK_STATUS_CHANNEL,
    ops: process.env.SLACK_OPS_CHANNEL,
    review: process.env.SLACK_REVIEW_CHANNEL,
    dry: process.env.SLACK_DRY_RUN,
  };

  check('every job in the table is business or ops', () => {
    for (const [job, audience] of Object.entries(AUDIENCE)) {
      assert.ok(['business', 'ops'].includes(audience), `${job} has audience "${audience}"`);
    }
  });

  check('business job resolves to SLACK_STATUS_CHANNEL', () => {
    process.env.SLACK_STATUS_CHANNEL = 'C0BUSINESS';
    assert.strictEqual(resolveChannel('sold-match-report'), 'C0BUSINESS');
  });

  check('ops job resolves to SLACK_OPS_CHANNEL', () => {
    process.env.SLACK_OPS_CHANNEL = 'C0OPS';
    assert.strictEqual(resolveChannel('cron-health-slack'), 'C0OPS');
  });

  check('ops falls back to SLACK_REVIEW_CHANNEL while SLACK_OPS_CHANNEL is unset', () => {
    delete process.env.SLACK_OPS_CHANNEL;
    process.env.SLACK_REVIEW_CHANNEL = 'C0LEGACY';
    assert.strictEqual(resolveChannel('spotcheck-reaction-poller'), 'C0LEGACY');
  });

  check('unknown job throws and names the job', () => {
    assert.throws(() => resolveChannel('not-a-real-job'), /not-a-real-job/);
  });

  check('missing channel env throws rather than posting somewhere arbitrary', () => {
    delete process.env.SLACK_OPS_CHANNEL;
    delete process.env.SLACK_REVIEW_CHANNEL;
    assert.throws(() => resolveChannel('cron-health-slack'), /SLACK_OPS_CHANNEL/);
  });

  check('SLACK_DRY_RUN=1 and DRY_RUN=1 both mean dry run', () => {
    process.env.SLACK_DRY_RUN = '1';
    assert.strictEqual(isDryRun(), true);
    delete process.env.SLACK_DRY_RUN;
    process.env.DRY_RUN = '1';
    assert.strictEqual(isDryRun(), true, 'DRY_RUN=1 is the existing convention in age-census-report.js');
    delete process.env.DRY_RUN;
    assert.strictEqual(isDryRun(), false);
  });

  process.env.SLACK_STATUS_CHANNEL = saved.status || '';
  process.env.SLACK_OPS_CHANNEL = saved.ops || '';
  process.env.SLACK_REVIEW_CHANNEL = saved.review || '';
  if (saved.dry) process.env.SLACK_DRY_RUN = saved.dry;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
