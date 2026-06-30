VERDICT: DROPLET_HEADLESS_BLOCKED_CF

# Droplet in-image headless Chromium vs Cloudflare on /priser

Date: 2026-06-30
Box: price-scraper droplet 170.64.181.89 (s-1vcpu-2gb, zero swap)

## Question
Does the box's own in-image headless Chromium load https://www.hemnet.se/priser
and CLEAR Cloudflare from the droplet's datacenter IP, or does it hit a
"Just a moment…" / Turnstile challenge? (Single open question for the ad-cost scrape.)

## Method (least-disruptive — as specified)
- Ran a one-off Playwright (sync API) probe via `docker exec` inside the
  ALREADY-RUNNING `hemnet-crawler` container (the default-queue celery worker,
  same `hemnet` image). Did NOT start the parked 8-worker
  `hemnet-crawler-playwright` container.
- Probe written to `/tmp/cf_probe.py` in the container via heredoc, executed
  with `docker exec hemnet-crawler python /tmp/cf_probe.py`, then deleted.
- Launch mirrored the repo (`apps/hemnet/tasks.py` `init_browser`):
  `chromium.launch(headless=True)` + Windows Chrome/113 desktop UA.
- Navigated to https://www.hemnet.se/priser, `wait_until=domcontentloaded`,
  +5s settle, captured response status / title / body text / markers, closed
  browser immediately. ONE browser, ONE page.
- Playwright present; chromium-1169 bundled in image (verified).

## Result — BLOCKED
- HTTP status: **403**
- Page title: **"Just a moment..."**
- Body (first ~300 chars): "www.hemnet.se / Performing security verification /
  This website uses a security service to protect against malicious bots.
  This page is displayed while the website verifies you are not a bot.
  Ray ID: a13c23f0bc2a7177 / Performance and Security by Cloudflare …"
- PASS marker ("Räkna ut priset" / "Gata eller kommun"): **false**
- BLOCK markers: `just a moment` = true, `http_403` = true
  (cf-chl / challenge-platform / checking-your-browser / turnstile not present
  in the served HTML, but the 403 + "Just a moment…" Cloudflare interstitial is
  unambiguous).

## Memory note
Fit comfortably. No OOM, no crash. `available` memory was 1143 MB before and
1158 MB after the probe; one headless Chromium + one page used a few hundred MB
transiently and was reclaimed on close. The s-1vcpu-2gb / zero-swap box handled
a single one-off navigation without issue.

## Bonus (form-fill end-to-end)
Skipped — step 1 was BLOCKED, so per instructions the form-fill / package-price
capture was not attempted.

## Cleanup / box state
- Temp probe `/tmp/cf_probe.py` deleted.
- Parked `hemnet-crawler-playwright` was never started (still
  state=exited, restart=no). All running containers (hemnet-writer, -beat,
  -crawler, -django, -redis) unchanged. Box left exactly as found.
- No writes to AdCostV2, no PeriodicTask enabled, no Oxylabs calls, no repo edits.

## Implication
The droplet's datacenter IP is challenged by Cloudflare on /priser → the
"near-$0 headless Chromium on the box as-is" path is NOT viable. Capturing
ad-cost package prices needs residential/managed egress (e.g. Oxylabs Web
Unblocker / SERP-style rendering, or a residential-proxy path) rather than the
box's own outbound IP. This closes the single open feasibility question with a
negative verdict for the cheap path.
