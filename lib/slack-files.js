'use strict';

// lib/slack-files.js — attach files to a report in Slack (2026-11-09, for the weekly pack
// GrokBot reads). Same routing as lib/slack-post.js: the JOB decides the channel, no caller
// names one. Uses Slack's external upload flow (files.upload was retired):
//   1. files.getUploadURLExternal (filename, length) -> upload_url + file_id, per file
//   2. POST the bytes to upload_url
//   3. files.completeUploadExternal once, with every file_id, into the channel / thread
// Needs the bot scope files:write (granted). Never throws: resolves { ok, uploaded, error }
// so a failed upload cannot cost the report it belongs to.
//
//   node lib/slack-files.js --smoke    (offline; fake transport)

const fs = require('fs');
const path = require('path');
const { resolveChannel, isDryRun } = require('./slack-post');

const API = 'https://slack.com/api/';

async function slackApi(fetchImpl, token, method, { form, json }) {
  const res = await fetchImpl(API + method, {
    method: 'POST',
    headers: form
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(form).toString() : JSON.stringify(json),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error || res.status}`);
  return body;
}

// uploadFiles(job, files, { threadTs, comment }) — files: [{ path, title? }]
async function uploadFiles(job, files, { threadTs = null, comment = null } = {}, deps = {}) {
  const channel = resolveChannel(job);          // throws on an unknown job, before any I/O
  const names = files.map(f => path.basename(f.path));
  if (isDryRun()) {
    console.log(`--- DRY RUN: ${job} files -> ${channel}${threadTs ? ` (thread ${threadTs})` : ''} ---\n` +
      `${comment || ''}\n${names.map(n => `  ${n}`).join('\n')}\n--- end dry run ---`);
    return { ok: true, dryRun: true, uploaded: names };
  }
  const fetchImpl = deps.fetch || fetch;
  const token = deps.token || process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, uploaded: [], error: 'SLACK_BOT_TOKEN not set' };
  try {
    const ids = [];
    for (const f of files) {
      const bytes = deps.readFile ? deps.readFile(f.path) : fs.readFileSync(f.path);
      const filename = path.basename(f.path);
      const { upload_url, file_id } = await slackApi(fetchImpl, token, 'files.getUploadURLExternal',
        { form: { filename, length: String(bytes.length) } });
      const up = await fetchImpl(upload_url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (!up.ok) throw new Error(`upload of ${filename}: HTTP ${up.status}`);
      ids.push({ id: file_id, title: f.title || filename });
    }
    const done = { files: ids, channel_id: channel };
    if (threadTs) done.thread_ts = threadTs;
    if (comment) done.initial_comment = comment;
    await slackApi(fetchImpl, token, 'files.completeUploadExternal', { json: done });
    return { ok: true, uploaded: names };
  } catch (err) {
    console.warn(`[slack-files] ${job}: ${err.message}`);
    return { ok: false, uploaded: [], error: err.message };
  }
}

module.exports = { uploadFiles };

if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = async (n, fn) => { try { await fn(); pass++; console.log(`  PASS  ${n}`); } catch (e) { fail++; console.error(`  FAIL  ${n}: ${e.message}`); } };
  process.env.SLACK_STATUS_CHANNEL = 'C_TEST';
  delete process.env.SLACK_DRY_RUN; delete process.env.DRY_RUN;
  const fake = (failAt = null) => {
    const calls = [];
    const f = async (url, opts) => {
      calls.push({ url, opts });
      const m = url.replace(API, '');
      if (failAt && m === failAt) return { ok: true, status: 200, json: async () => ({ ok: false, error: 'not_allowed' }) };
      if (m === 'files.getUploadURLExternal') {
        const n = calls.filter(c => c.url.endsWith('getUploadURLExternal')).length;
        return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: `https://files.example/u${n}`, file_id: `F${n}` }) };
      }
      if (url.startsWith('https://files.example/')) return { ok: true, status: 200 };
      if (m === 'files.completeUploadExternal') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error(`unexpected ${url}`);
    };
    return { f, calls };
  };
  const deps = (t) => ({ fetch: t.f, token: 'xoxb-test', readFile: (p) => Buffer.from(`bytes of ${p}`) });
  (async () => {
    await check('two files: two upload URLs, two uploads, one completion into the thread', async () => {
      const t = fake();
      const r = await uploadFiles('weekly-view-report', [{ path: '/x/a.csv' }, { path: '/x/b.xlsx', title: 'Pack' }],
        { threadTs: '123.45', comment: 'hi' }, deps(t));
      assert.deepStrictEqual(r, { ok: true, uploaded: ['a.csv', 'b.xlsx'] });
      assert.strictEqual(t.calls.length, 5);
      assert.match(t.calls[0].opts.body, /filename=a\.csv&length=17/);
      const done = JSON.parse(t.calls[4].opts.body);
      assert.deepStrictEqual(done, { files: [{ id: 'F1', title: 'a.csv' }, { id: 'F2', title: 'Pack' }], channel_id: 'C_TEST', thread_ts: '123.45', initial_comment: 'hi' });
      assert.strictEqual(t.calls[0].opts.headers.Authorization, 'Bearer xoxb-test');
    });
    await check('no thread ts: posts to the channel without thread_ts', async () => {
      const t = fake();
      await uploadFiles('weekly-view-report', [{ path: '/x/a.csv' }], {}, deps(t));
      assert.ok(!('thread_ts' in JSON.parse(t.calls[2].opts.body)));
    });
    await check('a Slack error resolves ok:false with the reason, never throws', async () => {
      const r = await uploadFiles('weekly-view-report', [{ path: '/x/a.csv' }], {}, deps(fake('files.completeUploadExternal')));
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /completeUploadExternal: not_allowed/);
    });
    await check('dry run uploads nothing', async () => {
      process.env.SLACK_DRY_RUN = '1';
      const t = fake();
      try {
        const r = await uploadFiles('weekly-view-report', [{ path: '/x/a.csv' }], {}, deps(t));
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(t.calls.length, 0);
      } finally { delete process.env.SLACK_DRY_RUN; }
    });
    await check('unknown job throws before any I/O (same rule as postMessage)', async () => {
      await assert.rejects(() => uploadFiles('no-such-job', [], {}, deps(fake())), /routing table/);
    });
    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
