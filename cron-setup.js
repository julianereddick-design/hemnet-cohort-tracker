const { createClient } = require('./db');

async function run() {
  const client = createClient();
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS cron_job_log (
      id              SERIAL PRIMARY KEY,
      script_name     TEXT NOT NULL,
      started_at      TIMESTAMPTZ NOT NULL,
      finished_at     TIMESTAMPTZ,
      duration_ms     INTEGER,
      status          TEXT NOT NULL DEFAULT 'running',
      error_message   TEXT,
      result_summary  JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_cron_job_log_script_started
      ON cron_job_log (script_name, started_at DESC)
  `);

  console.log('Created table: cron_job_log');
  await client.end();
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
