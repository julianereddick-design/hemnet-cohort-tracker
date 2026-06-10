// lib/spotcheck-vision.js
//
// Mode B Claude-vision adjudicator for the cohort-match spot-check weekly QA gate.
// Given a pair (with photos.hemnet_gallery / photos.booli_gallery already downloaded
// by spotcheck-photos.js --gallery), asks Claude to decide whether the two listings
// show the SAME physical property.
//
// Design principles:
//   * The Anthropic SDK is loaded LAZILY inside getClient() — not at module top-level.
//     This means the module loads cleanly even when @anthropic-ai/sdk is absent or
//     ANTHROPIC_API_KEY is unset (offline --smoke, Mode A fallback both work).
//   * adjudicateWithVision(pair, opts) returns null when the key is missing OR on any
//     API/parse error — the caller (cohort-spotcheck-gate.js) treats null as Mode A
//     for that pair. The gate NEVER crashes because of a vision failure.
//   * Vision is called ONLY for pairs the deterministic triage flagged as needing it
//     (provisional === 'suspect' or 'low-signal'). The gate enforces this; this module
//     does not filter.
//
// Model: process.env.ANTHROPIC_MODEL (overridable, e.g. claude-opus-4-8 for higher
//        accuracy) or 'claude-sonnet-4-6' (default — current vision-capable Claude 4.x).
//
// Usage:
//   const { adjudicateWithVision } = require('./lib/spotcheck-vision');
//   node lib/spotcheck-vision.js --smoke

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
// getClient() — lazy SDK load (T-12-09: key only from env)
// Returns an Anthropic client or null when the key is absent.
// ---------------------------------------------------------------
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // Lazy require: keeps the module loadable without @anthropic-ai/sdk at top level.
  // This is intentional — supports --smoke offline path and Mode A fallback.
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------
// buildImageBlock(filePath) — read + base64-encode one gallery file
// Returns an Anthropic image content block or null on any I/O error.
// ---------------------------------------------------------------
function buildImageBlock(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const b64 = data.toString('base64');
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: b64,
      },
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------
// adjudicateWithVision(pair, opts = {}) — main export
//
//   pair: one record from artifact.pairs (post-spotcheck-photos.js enrichment):
//     {
//       pair_id,
//       provisional: 'suspect' | 'low-signal' | 'likely-match',
//       photos: {
//         hemnet_gallery: [{ file, label }, ...],  // file = path RELATIVE to artifactDir
//         booli_gallery:  [{ file, label }, ...],
//       },
//       ...
//     }
//
//   opts:
//     artifactDir       — base dir to resolve gallery file paths against (required)
//     maxImagesPerSide  — max images sent per listing side; default 6 (cost control, T-12-11)
//
// Returns:
//   { sharedPhoto: true|false|null, confidence: 'high'|'medium'|'low', reasoning: string }
//   OR null when:
//     - ANTHROPIC_API_KEY is absent (caller falls back to Mode A)
//     - API or parse error (caller falls back to Mode A for this pair; never crashes)
//     - Either gallery side has 0 readable images
// ---------------------------------------------------------------
async function adjudicateWithVision(pair, opts = {}) {
  const client = getClient();
  if (!client) return null;  // no key → Mode A fallback

  const artifactDir = opts.artifactDir || '';
  const maxImagesPerSide = opts.maxImagesPerSide || 6;

  const p = pair || {};
  const photos = p.photos || {};
  const hemnetGallery = Array.isArray(photos.hemnet_gallery) ? photos.hemnet_gallery : [];
  const booliGallery  = Array.isArray(photos.booli_gallery)  ? photos.booli_gallery  : [];

  // Slice to budget cap
  const hemnetSlice = hemnetGallery.slice(0, maxImagesPerSide);
  const booliSlice  = booliGallery.slice(0, maxImagesPerSide);

  // Build image content blocks — skip unreadable files
  const booliBlocks  = booliSlice.map((g)  => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);
  const hemnetBlocks = hemnetSlice.map((g) => buildImageBlock(path.join(artifactDir, g.file))).filter(Boolean);

  if (booliBlocks.length === 0 || hemnetBlocks.length === 0) {
    // Cannot compare without images on both sides — no API call
    return { sharedPhoto: null, confidence: 'low', reasoning: 'insufficient images' };
  }

  // Model selection — ANTHROPIC_MODEL overrides for higher-accuracy runs.
  // Default: claude-sonnet-4-6 (Claude 4.x, vision-capable).
  // Override example: ANTHROPIC_MODEL=claude-opus-4-8
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  // Build the prompt content array:
  //   [label text] [booli image 1] ... [booli image N] [label text] [hemnet image 1] ...
  // Booli images are sent first, then Hemnet — consistent labelling helps the model.
  const promptText = `Here are interior and exterior photos from two listings.

Booli listing: ${booliBlocks.length} image(s) follow.`;

  const hemnetIntroText = `Hemnet listing: ${hemnetBlocks.length} image(s) follow.`;

  const questionText = `Decide if these two listings show the SAME physical property.

IMPORTANT: Look for ONE clearly shared room or exterior feature across BOTH galleries — a matching kitchen, a recognisable living room layout, a distinctive facade, a unique balcony view. Hero/cover photos alone are unreliable and should not be the sole basis for a decision. Find a shared interior or exterior detail.

Respond with strict JSON only (no markdown fencing, no other text):
{"sharedPhoto": true or false or null, "confidence": "high" or "medium" or "low", "reasoning": "one sentence explaining the key evidence"}

Use null for sharedPhoto when the galleries are ambiguous (different angles of generic rooms with no clear shared feature).`;

  const content = [
    { type: 'text', text: promptText },
    ...booliBlocks,
    { type: 'text', text: hemnetIntroText },
    ...hemnetBlocks,
    { type: 'text', text: questionText },
  ];

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    });

    const raw = (msg.content && msg.content[0] && msg.content[0].text) || '';

    // Parse the JSON reply — strip any accidental markdown fencing
    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (_) {
      console.warn(`[spotcheck-vision] parse error for pair ${p.pair_id}: raw="${raw.slice(0, 120)}"`);
      return null;  // T-12-12: parse error → Mode A fallback, never crash
    }

    const sharedPhoto = (parsed.sharedPhoto === true || parsed.sharedPhoto === false) ? parsed.sharedPhoto : null;
    const confidence  = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
    const reasoning   = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

    return { sharedPhoto, confidence, reasoning };
  } catch (err) {
    console.warn(`[spotcheck-vision] API error for pair ${p.pair_id}: ${err.message}`);
    return null;  // T-12-12: API error → Mode A fallback, never crash
  }
}

module.exports = { adjudicateWithVision };

// ---------------------------------------------------------------
// --smoke self-test (OFFLINE — no API key, no network required).
//   node lib/spotcheck-vision.js --smoke
//
// Asserts:
//   (a) adjudicateWithVision with no ANTHROPIC_API_KEY returns null
//   (b) a pair with empty galleries returns null or { sharedPhoto: null }
//   (c) module loads without requiring @anthropic-ai/sdk at top level
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  // Ensure no key is active for the smoke run
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try { fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }
  async function checkAsync(name, fn) {
    try { await fn(); pass++; }
    catch (e) { console.error(`SMOKE FAIL [${name}]: ${e.message}`); fail++; }
  }

  // (c) Module load purity: @anthropic-ai/sdk must NOT be at top-level require.
  // We verify by confirming the module loaded and exports adjudicateWithVision
  // without needing the SDK present at module evaluation time.
  check('module exports adjudicateWithVision', () => {
    assert.strictEqual(typeof adjudicateWithVision, 'function');
  });

  // (a) No ANTHROPIC_API_KEY → adjudicateWithVision returns null (no API call)
  (async () => {
    await checkAsync('no key → returns null (Mode A fallback)', async () => {
      const result = await adjudicateWithVision(
        { pair_id: 1, photos: { hemnet_gallery: [], booli_gallery: [] } },
        { artifactDir: '/tmp' }
      );
      assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
    });

    // (b) Pair with empty galleries → null or { sharedPhoto: null } (no API call possible anyway)
    // When no key, getClient() returns null first, so result is null.
    await checkAsync('empty galleries + no key → null', async () => {
      const pair = {
        pair_id: 2,
        photos: { hemnet_gallery: [], booli_gallery: [] },
      };
      const result = await adjudicateWithVision(pair, { artifactDir: '/tmp' });
      // Either null (no key) or { sharedPhoto: null } (insufficient images)
      const valid = result === null || (result && result.sharedPhoto === null);
      assert.ok(valid, `expected null or { sharedPhoto: null }, got ${JSON.stringify(result)}`);
    });

    // (b2) When key IS set but galleries are empty → returns insufficient-images sentinel
    // We simulate this by temporarily providing a key but pointing to files that don't exist.
    // getClient() would succeed, but image reading fails → { sharedPhoto: null }.
    // We test this path with a dummy key (no real network call — both sides produce 0 blocks
    // because the files don't exist, so we return before calling the API).
    await checkAsync('empty galleries (with dummy key) → { sharedPhoto: null } (no API call)', async () => {
      // Temporarily set a dummy key
      process.env.ANTHROPIC_API_KEY = 'sk-ant-smoke-test-dummy';
      try {
        const pair = {
          pair_id: 3,
          photos: { hemnet_gallery: [], booli_gallery: [] },
        };
        const result = await adjudicateWithVision(pair, { artifactDir: '/tmp' });
        // Either null or { sharedPhoto: null, confidence: 'low' }
        // (null only if key-check fails before image path, but with dummy key getClient succeeds;
        //  0 readable images → { sharedPhoto: null, confidence: 'low', reasoning: 'insufficient images' })
        const valid = result === null ||
          (result && result.sharedPhoto === null && result.confidence === 'low');
        assert.ok(valid, `expected null or insufficient-images sentinel, got ${JSON.stringify(result)}`);
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    // Restore saved key if any
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;

    console.log(`smoke: ${pass} pass, ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
