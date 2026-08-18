#!/usr/bin/env python3
"""adcost_steel.py — Hemnet ad-cost crawler via Steel residential browser.

Standalone (runnable as a subprocess) so it executes in a PLAIN Python
interpreter, NOT under the celery worker's eventlet loop (Playwright is
incompatible with eventlet monkey-patching). search_ad_cost_2 invokes this with
the (municipality, price) grid on stdin and reads AdCostV2-shaped rows on stdout.

Egress: selectable via ADCOST_TRANSPORT.
  unlocker (DEFAULT) — Bright Data Web Unlocker over its native proxy (port 44445).
                       NO BROWSER: a plain POST to /graphql, so Playwright, CDP,
                       sessions and Cloudflare-clearing do not enter into it.
                       Validated live 2026-08-17. Billed per SUCCESSFUL request,
                       so failed retries are free.
  brightdata         — Bright Data Browser API over CDP. FALSIFIED 2026-08-17:
                       their unlocker returns resolve_fail_cf_max_tries on both US
                       and SE and the page never clears. Kept, not recommended.
  steel              — the original egress, LAST RESORT. Clear rate had decayed to
                       ~12% by 2026-08-14 and Cloudflare refused POST /graphql even
                       on pages it did clear.

The browser transports use playwright.async_api (already in the image, v1.52) and
run the browser OFF-box at the provider. The unlocker transport uses `requests`.

Contract (validated live 2026-07-01, see 27-GRAPHQL-CONTRACT.md):
  - autocomplete op:  webAutocompleteLocations  -> locationId
  - price op:         webPricingCalculator       -> pricingCalculator[]
  - ad_price = prices.PAY_NOW.total.amountInCents / 100  (SEK)
  - composeUpgradesWithBasic:true  -> PLUS/PREMIUM/MAX already composed (no BASIC-sum)
  - offerSlug -> historical ad_type via SLUG_TO_AD_TYPE

The transport secret is read from env, else the repo-root .env; never logged.

Reliability (2026-08-14, see docs/handover/adcost-crawler-silent-failure.md):
Cloudflare starts refusing the in-page POST /graphql a few requests into a
session and the refusal LATCHES for the rest of that session. The old loop had
no retry and no abort, so it ground through every remaining cell collecting
nothing and exited 0 — Aug 2 wrote 6/420 rows and reported success. This module
now:
  - retries each cell (transient refusals recover — proven by the Jul 1 run),
  - detects the latched state and rebuilds the Steel session, resuming from the
    failed cell instead of burning the rest of the grid,
  - proves a session is usable with a real autocomplete call before trusting it
    (the old text-match on "Priser" hits Hemnet's global nav on every page, so
    Jul 5 and Jul 26 "cleared" and then silently collected nothing),
  - reports completeness on stdout so the caller can tell 35 rows from 420.

I/O contract:
  stdin : JSON  [{"name": "...", "full_name": "... kommun", "price": 5000000}, ...]
  stdout: JSON  {"rows":  [{"full_name": "... kommun", "price": 5000000,
                            "ad_type": "BASIC", "ad_price": 6820.0}, ...],
                 "stats": {"cells_total": 60, "cells_ok": 60, "cells_failed": 0,
                           "reclears": 0, "aborted": false, "expected_rows": 420}}
  exit 0 = ok ; 4 = Cloudflare not cleared ; 2 = misconfig ; 1 = error

Offline self-test (no network, no provider spend):  python adcost_steel.py --selftest
"""
import asyncio
import json
import os
import random
import re
import sys
import time

STEEL_API = "https://api.steel.dev"

OFFER_SLUGS = ["BAS", "PLUS", "PREMIUM", "MAX",
               "FORNYA_ANNONS", "RAKETEN_3_DAGAR", "RAKETEN_5_DAGAR"]
SLUG_TO_AD_TYPE = {
    "BAS": "BASIC", "PLUS": "PLUS", "PREMIUM": "PREMIUM", "MAX": "MAX",
    "FORNYA_ANNONS": "PAID_REPUBLISH",
    "RAKETEN_3_DAGAR": "TOPLISTING", "RAKETEN_5_DAGAR": "TOPLISTING_5_DAYS",
}
# Verified 2026-07-01 against Julian's historical ARPL model (v6 xlsx): the
# pre-Mar-16 AdCostV2 series uses the "pay when the listing is removed" price
# (Stockholm @5M matches BASIC 7297 / PLUS 11662 / PREMIUM 16370 / MAX 22683 exactly,
# not PAY_NOW). Required for continuity across the scrape gap.
PAYMENT_METHOD = "PAY_WHEN_LISTING_IS_REMOVED"

AUTOCOMPLETE_QUERY = (
    "query webAutocompleteLocations($query: String!, $limit: Int!, $types: [LocationType!]) {"
    "  autocompleteLocations(query: $query, limit: $limit, types: $types) {"
    "    hits { id: locationId fullName __typename } __typename } }"
)
PRICING_QUERY = (
    "query webPricingCalculator($locationId: ID!, $askingPrice: Int, "
    "$housingFormGroup: HousingFormGroup, $livingAreaInSqm: Float, "
    "$offerSlugs: [OfferSlug!]!, $composeUpgradesWithBasic: Boolean) {"
    "  pricingCalculator(locationId: $locationId, askingPrice: $askingPrice, "
    "offerSlugs: $offerSlugs, housingFormGroup: $housingFormGroup, "
    "livingAreaInSqm: $livingAreaInSqm, composeUpgradesWithBasic: $composeUpgradesWithBasic) {"
    "    offerSlug prices { PAY_NOW { total { amountInCents __typename } __typename } "
    "PAY_WHEN_LISTING_IS_REMOVED { total { amountInCents __typename } __typename } "
    "PAY_ONLY_IF_SOLD { total { amountInCents __typename } __typename } __typename } __typename } }"
)

BLOCK_RE = re.compile(
    r"just a moment|checking your browser|cf-chl|attention required|"
    r"enable javascript and cookies|verifying you are human", re.I)
CLEAR_RE = re.compile(
    r"Räkna ut priset|Gata eller kommun|Skriv område|Utgångspris|Priser", re.I)
MAX_ATTEMPTS = 5

# --- reliability tunables (see module docstring) ---
CELL_ATTEMPTS = 3           # tries per grid cell before the cell is abandoned
CELL_BACKOFF = 2.0          # seconds; attempt N waits N * CELL_BACKOFF
LATCH_AFTER = 3             # consecutive failed cells => session presumed latched
MAX_RECLEARS = 2            # session rebuilds allowed inside the grid loop
ABORT_AFTER = 8             # consecutive failures with no rebuilds left => stop
JITTER = (0.5, 1.5)         # inter-cell pause; 70 back-to-back XHRs is itself a bot signal
# TIME_BUDGET is transport-dependent and is therefore set below, immediately
# after TRANSPORT is resolved. See the note there.
MAX_PROBES = 3              # /graphql probes per session before it is written off
# Steel's residential pool defaults to UNITED STATES. Swedish exit IPs were
# TESTED 2026-08-14 (ADCOST_PROXY_COUNTRY=SE) on the theory that a US IP on a
# Swedish site scores badly — it made things WORSE (0/6 cells, 8 sessions for one
# clear, vs 1/60 on the US default), so the default stays unset. Geography is not
# the variable: Cloudflare passes the PAGE and refuses /graphql either way.
# Set ADCOST_PROXY_COUNTRY to an Alpha-2 code to re-test; Steel supports 200+.
# Under brightdata this is applied to the CDP username (see brightdata_cdp_url),
# NOT as a query parameter.
PROXY_COUNTRY = os.environ.get("ADCOST_PROXY_COUNTRY") or None

# --- transport selection -----------------------------------------------------
# Steel was the original egress and is RETAINED as a fallback, but it is not
# viable on its own: measured 2026-08-14 its clear rate had decayed to ~12% and
# Cloudflare refused POST /graphql even on a cleared page ("page cleared but
# /graphql refused 3x", HTTP 403 "Just a moment..."). That is a managed-unlocking
# problem, not an IP-reputation one — geo=SE was tested live and was WORSE.
# Bright Data Browser API is the replacement: standard CDP, so everything below
# this seam (retry, rebuild, latch detection, the grid loop) is unchanged.
#
#   unlocker   -> BRIGHTDATA_UNLOCKER_PROXY (DEFAULT). Bright Data Web Unlocker
#                 over its native proxy, port 44445. NO BROWSER AT ALL — a plain
#                 POST to /graphql. Validated live 2026-08-17: 200s end-to-end and
#                 3 of 4 reference prices matched the historical model to the krona.
#                 Billed per SUCCESSFUL request ($1.50/CPM), so failed retries are
#                 free. ~$0.45/mo on the 60-cell grid.
#   brightdata -> BRIGHTDATA_BROWSER_URL, a wss:// CDP connect string. FALSIFIED
#                 2026-08-17: the unlocker returns resolve_fail_cf_max_tries on
#                 both US and SE exits and the page never clears. Kept only so the
#                 CDP path is not lost; do not select it without new evidence.
#   steel      -> STEEL_API_KEY, sessions created over the Steel HTTP API.
#                 Clear rate had decayed to ~12%; retained as a last resort.
TRANSPORT = (os.environ.get("ADCOST_TRANSPORT") or "unlocker").strip().lower()
TRANSPORTS = ("unlocker", "brightdata", "steel")

# --- the clock ---------------------------------------------------------------
# The unlocker is RELIABLE BUT SLOW: measured 2026-08-17 at ~21s/cell (60 cells
# + a ~35s warm-up ≈ 1,300s). A 900s budget aborted an otherwise CLEAN run at
# cell 41/60 — 41 of 41 attempted cells had succeeded, so the only thing that
# failed was the clock.
#
# ⚠ THIS IS DERIVED, NOT CHOSEN. tasks.py runs this file under
# subprocess.run(timeout=...), and on TimeoutExpired subprocess.run KILLS the
# child and DISCARDS ITS STDOUT — so overrunning that timeout loses the entire
# harvest, not the tail of it. On a monthly job with no backfill that is a
# permanent hole. The budget is therefore derived from the caller's timeout and
# DEFAULTS TO THE VALUE CURRENTLY DEPLOYED (1800s), so this file is safe to ship
# before tasks.py is updated. tasks.py should export ADCOST_SUBPROCESS_TIMEOUT.
SUBPROCESS_TIMEOUT = float(os.environ.get("ADCOST_SUBPROCESS_TIMEOUT") or 1800)
# Worst case for ONE cell: CELL_ATTEMPTS × 2 requests × (connect + read) + backoff.
# The budget is only checked between cells, so a cell that starts just under the
# line can still overrun by this much. Subtract it rather than hope.
WORST_CELL_SEC = CELL_ATTEMPTS * 2 * (15 + 120) + CELL_ATTEMPTS * CELL_BACKOFF

# Measured 2026-08-17 on the real 60-cell grid: 420/420 rows, 60/60 cells.
MEASURED_SEC_PER_CELL = 21.0
MEASURED_WARMUP_SEC = 39.0
FULL_GRID_CELLS = 60


def derive_time_budget(subprocess_timeout):
    """Budget = the caller's timeout minus the worst single cell's overrun."""
    return max(300.0, float(subprocess_timeout) - WORST_CELL_SEC)


def grid_seconds_needed(cells, sec_per_cell=MEASURED_SEC_PER_CELL):
    return MEASURED_WARMUP_SEC + cells * sec_per_cell


# To finish a full grid the CALLER's timeout must cover the grid AND the
# worst-case overrun of the last cell. 1800s (the value deployed before this
# change) does NOT: it yields a 984s budget against a ~1,299s grid, which
# truncates. tasks.py must be raised to 2700s IN THE SAME DEPLOY.
REQUIRED_SUBPROCESS_TIMEOUT = grid_seconds_needed(
    FULL_GRID_CELLS, 30.0) + WORST_CELL_SEC          # slower-month sizing
TIME_BUDGET = (derive_time_budget(SUBPROCESS_TIMEOUT)
               if TRANSPORT == "unlocker" else 900.0)
BRIGHTDATA_URL_VAR = "BRIGHTDATA_BROWSER_URL"
UNLOCKER_PROXY_VAR = "BRIGHTDATA_UNLOCKER_PROXY"
# Bright Data's unlocker can spend a while on a challenge before handing the page
# back; Steel either cleared fast or not at all.
GOTO_TIMEOUT_MS = 120000 if TRANSPORT == "brightdata" else 60000


class FetchError(RuntimeError):
    """A /graphql call that did not come back as JSON — carries the evidence.

    The whole point: the old code called r.json() in-page, so a Cloudflare
    challenge surfaced as an opaque parse error with the status and body
    discarded. Every instance of this exception names itself in the log.
    """

    def __init__(self, status, snippet):
        super().__init__(f"HTTP {status}: {snippet!r}")
        self.status = status
        self.snippet = snippet


def parse_pricing(gql_json):
    """data.pricingCalculator[] -> [{code, amount}] (amount in SEK).

    Pure function (no I/O) so it is unit-testable offline. Mirrors
    scripts/adcost-parse.js::parseProductPrices.
    """
    packages = (gql_json or {}).get("data", {}).get("pricingCalculator") or []
    rows = []
    for pkg in packages:
        slug = (pkg or {}).get("offerSlug") or ""
        if not slug:
            continue
        pm = (pkg.get("prices") or {}).get(PAYMENT_METHOD) or {}
        total = pm.get("total") or {}
        cents = total.get("amountInCents")
        if cents is None:
            continue
        rows.append({"code": SLUG_TO_AD_TYPE.get(slug, slug),
                     "amount": float(cents) / 100.0})
    return rows


def read_env_value(name):
    """`name` from the process env, else from the gitignored repo-root .env.

    The celery worker's container env does not export the transport secrets; the
    repo root is volume-mounted at /app, so the gitignored .env is readable
    there. Never logs the value.
    """
    v = os.environ.get(name)
    if v:
        return v
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    prefix = name + "="
    try:
        with open(env_path) as f:
            for raw in f:
                line = raw.strip()
                if line.startswith("export "):
                    line = line[len("export "):]
                if line.startswith(prefix):
                    v = line.split("=", 1)[1].strip()
                    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                        v = v[1:-1]
                    return v
    except OSError:
        pass
    return None


def read_steel_key():
    return read_env_value("STEEL_API_KEY")


def read_credential():
    """The secret for the ACTIVE transport. Never logged.

    brightdata -> the full CDP connect string (it carries user+password).
    steel      -> the Steel API key.
    """
    if TRANSPORT == "unlocker":
        return read_env_value(UNLOCKER_PROXY_VAR)
    if TRANSPORT == "brightdata":
        return read_env_value(BRIGHTDATA_URL_VAR)
    return read_steel_key()


def brightdata_cdp_url(base):
    """Apply optional country targeting to a Bright Data connect string.

    Bright Data encodes targeting in the USERNAME, not a query string:
    `brd-customer-<id>-zone-<zone>` becomes `...-zone-<zone>-country-se`.
    Returns `base` unchanged when no country is configured.
    """
    if not PROXY_COUNTRY:
        return base
    marker = "-zone-"
    at = base.rfind("@")
    if at == -1 or marker not in base[:at]:
        return base
    userinfo, rest = base[:at], base[at:]
    colon = userinfo.rfind(":")
    if colon == -1 or colon < userinfo.rfind(marker):
        return base
    user, password = userinfo[:colon], userinfo[colon:]
    suffix = "-country-" + PROXY_COUNTRY.lower()
    if user.endswith(suffix):
        return base
    return user + suffix + password + rest


def _steel_headers(key):
    return {"Steel-Api-Key": key, "content-type": "application/json"}


def create_session(key):
    if TRANSPORT == "brightdata":
        # No session endpoint to call: connecting over CDP allocates the session
        # and closing the browser frees it. Shaped like a Steel session so
        # open_cleared_page / _teardown stay transport-agnostic.
        print(f"session brightdata geo={PROXY_COUNTRY or 'default'}", file=sys.stderr)
        return {"id": "brightdata", "cdp_url": brightdata_cdp_url(key),
                "proxySource": "brightdata", "region": "managed"}

    import requests

    use_proxy = {"geolocation": {"country": PROXY_COUNTRY}} if PROXY_COUNTRY else True
    r = requests.post(
        f"{STEEL_API}/v1/sessions",
        headers=_steel_headers(key),
        json={"useProxy": use_proxy, "solveCaptcha": True, "sessionTimeout": 300000},
        timeout=60,
    )
    if r.status_code >= 400:
        print(f"create_session {r.status_code}: {r.text[:300]}", file=sys.stderr)
    r.raise_for_status()
    s = r.json()
    print(f"session {s.get('id','?')[:8]} proxy={s.get('proxySource')} "
          f"geo={PROXY_COUNTRY or 'default(US)'} region={s.get('region')}", file=sys.stderr)
    return s


def cdp_endpoint(session, key):
    """The CDP URL for a session, whichever transport created it.

    brightdata carries its own fully-formed connect string; Steel returns a bare
    websocketUrl that needs the API key appended.
    """
    return session.get("cdp_url") or f'{session["websocketUrl"]}&apiKey={key}'


def release_session(key, session_id):
    if TRANSPORT == "brightdata":
        return  # the browser close in _teardown already ended it

    import requests

    try:
        requests.post(f"{STEEL_API}/v1/sessions/{session_id}/release",
                      headers=_steel_headers(key), timeout=30)
    except Exception:
        pass


async def in_page_fetch(page, query, variables):
    """POST /graphql from inside the page. Raises FetchError with the evidence.

    Reads the response as text and parses here rather than calling r.json() in
    the page, so a challenge/rate-limit body reaches the log instead of being
    reduced to an unhelpful parse error.
    """
    res = await page.evaluate(
        """async ({q, v}) => {
            const r = await fetch('/graphql', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({query: q, variables: v})
            });
            return {status: r.status, body: await r.text()};
        }""",
        {"q": query, "v": variables},
    )
    status = (res or {}).get("status")
    body = (res or {}).get("body") or ""
    try:
        parsed = json.loads(body)
    except ValueError:
        raise FetchError(status, body[:200])
    if status != 200:
        raise FetchError(status, body[:200])
    return parsed


async def probe_usable(page, probe_name):
    """One cheap autocomplete call. Valid hits[] proves the session really works.

    Replaces trusting CLEAR_RE alone: it matches a bare "Priser", which appears
    in Hemnet's global nav on essentially every page — including pages that are
    not usably cleared. Jul 5 and Jul 26 both "cleared" and then wrote 0 rows.
    """
    try:
        res = await in_page_fetch(page, AUTOCOMPLETE_QUERY,
                                  {"query": probe_name, "limit": 5, "types": ["MUNICIPALITY"]})
    except Exception as e:
        print(f"probe failed: {e}", file=sys.stderr)
        return False
    hits = (((res or {}).get("data") or {}).get("autocompleteLocations") or {}).get("hits")
    if not hits:
        print(f"probe returned no hits: {json.dumps(res)[:200]}", file=sys.stderr)
        return False
    return True


async def wait_for_usable(page, probe_name):
    """Poll until the page is past Cloudflare AND /graphql actually answers.

    The probe is capped at MAX_PROBES per session. Observed live 2026-08-14:
    the page HTML clears normally while /graphql stays 403 — probing on every
    poll then fires 16 challenged calls per attempt, which is itself pressure on
    an already-degraded pool. If the page is clear and the endpoint refuses a
    few times, this session's /graphql is blocked; give up on it quickly.
    """
    probes = 0
    for _ in range(16):
        await page.wait_for_timeout(3000)
        try:
            st = await page.evaluate(
                "() => ({title: document.title, "
                "body: document.body ? document.body.innerText.slice(0,4000) : ''})")
        except Exception:
            st = {"title": "", "body": ""}
        is_block = bool(BLOCK_RE.search(st["title"]) or BLOCK_RE.search(st["body"][:600]))
        looks_clear = (bool(CLEAR_RE.search(st["body"])
                            or (st["title"][:6].lower() == "priser" and len(st["body"]) > 200))
                       and not is_block)
        if not looks_clear:
            continue
        if await probe_usable(page, probe_name):
            return True
        probes += 1
        if probes >= MAX_PROBES:
            print(f"page cleared but /graphql refused {probes}x — abandoning session",
                  file=sys.stderr)
            return False
    return False


async def _teardown(browser, key, session):
    if browser is not None:
        try:
            await browser.close()
        except Exception:
            pass
    if session is not None:
        release_session(key, session["id"])


async def open_cleared_page(pw, key, probe_name, tag=""):
    """Create sessions until one is past Cloudflare and answering /graphql.

    Returns (session, browser, page), or (None, None, None) if every attempt
    was refused. create_session errors are deliberately NOT caught: a 401/429
    from the Steel API should still exit 1 loudly rather than masquerade as a
    Cloudflare block. Under brightdata create_session cannot fail (it builds the
    connect string locally); a bad credential surfaces as a CDP connect error on
    the line below, which IS caught and retried — so a wrong password would burn
    MAX_ATTEMPTS and then report BLOCKED_CF. The connect error text is logged.
    """
    for attempt in range(1, MAX_ATTEMPTS + 1):
        session = create_session(key)
        browser = None
        try:
            browser = await pw.chromium.connect_over_cdp(cdp_endpoint(session, key))
            ctx = browser.contexts[0]
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            try:
                await page.goto("https://www.hemnet.se/priser",
                                wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
            except Exception as e:
                print(f"goto{tag}: {e}", file=sys.stderr)
            if await wait_for_usable(page, probe_name):
                print(f"Cloudflare CLEARED{tag} (attempt {attempt})", file=sys.stderr)
                return session, browser, page
            print(f"attempt {attempt}{tag}: still challenged", file=sys.stderr)
        except Exception as e:
            print(f"session setup failed{tag} (attempt {attempt}): {e}", file=sys.stderr)
        await _teardown(browser, key, session)
    return None, None, None


async def resolve_location_id(gql, name, full_name, cache):
    if full_name in cache:
        return cache[full_name]
    res = await gql(AUTOCOMPLETE_QUERY,
                    {"query": name, "limit": 5, "types": ["MUNICIPALITY"]})
    hits = (((res or {}).get("data") or {}).get("autocompleteLocations") or {}).get("hits") or []
    hit = next((h for h in hits if h.get("fullName") == full_name), None)
    if not hit:
        raise RuntimeError(f"no autocomplete hit for {full_name!r}")
    cache[full_name] = hit.get("id")
    return cache[full_name]


async def fetch_cell(gql, cell, cache):
    """Resolve + price one grid cell. Raises on any failure.

    An empty parse_pricing() result is treated as a failure, not as a cell that
    happened to have no prices: a 200 with no pricingCalculator is another way
    for a refusal to look like success.

    `gql(query, variables)` is the transport seam — an in-page fetch under the
    browser transports, a proxied HTTP POST under the unlocker. Identical below.
    """
    location_id = await resolve_location_id(gql, cell["name"], cell["full_name"], cache)
    pr = await gql(PRICING_QUERY, {
        "locationId": location_id,
        "askingPrice": cell["price"],
        "offerSlugs": OFFER_SLUGS,
        "composeUpgradesWithBasic": True,
    })
    rows = parse_pricing(pr)
    if not rows:
        raise RuntimeError(f"no prices in response: {json.dumps(pr)[:200]}")
    return rows


async def run_grid(grid, fetch, reclear, sleep=None, clock=None):
    """Walk the grid with per-cell retry and latched-session recovery.

    Dependency-injected so the state machine is testable with no browser and no
    Steel spend — see selftest().

      fetch(cell, cache) -> [{code, amount}]; raises on failure
      reclear()          -> True once a fresh cleared session is ready

    Returns (out_rows, stats).
    """
    sleep = sleep or asyncio.sleep
    clock = clock or time.monotonic
    started = clock()

    out_rows = []
    stats = {"cells_total": len(grid), "cells_ok": 0, "cells_failed": 0,
             "reclears": 0, "aborted": False}
    cache = {}
    consecutive = 0
    streak_start = None  # first cell of the current failure run; rewind target on rebuild
    i = 0

    while i < len(grid):
        if clock() - started > TIME_BUDGET:
            print(f"time budget {TIME_BUDGET}s exhausted at cell {i}", file=sys.stderr)
            stats["aborted"] = True
            break

        cell = grid[i]
        rows, err = None, None
        for attempt in range(1, CELL_ATTEMPTS + 1):
            try:
                rows = await fetch(cell, cache)
                break
            except Exception as e:  # noqa: BLE001 - every failure mode is reported
                err = e
                if attempt < CELL_ATTEMPTS:
                    await sleep(attempt * CELL_BACKOFF)

        if rows is not None:
            for row in rows:
                out_rows.append({"full_name": cell["full_name"], "price": cell["price"],
                                 "ad_type": row["code"], "ad_price": row["amount"]})
            stats["cells_ok"] += 1
            consecutive = 0
            streak_start = None
            i += 1
            await sleep(random.uniform(*JITTER))
            continue

        print(f"cell {i} failed {cell['full_name']}@{cell['price']} "
              f"after {CELL_ATTEMPTS} attempts: {err}", file=sys.stderr)
        consecutive += 1
        if streak_start is None:
            streak_start = i

        # Latched session: stop burning the rest of the grid on a dead session.
        if consecutive >= LATCH_AFTER and stats["reclears"] < MAX_RECLEARS:
            print(f"latched after {consecutive} consecutive failures — rebuilding session "
                  f"(reclear {stats['reclears'] + 1}/{MAX_RECLEARS}), rewinding to cell "
                  f"{streak_start}", file=sys.stderr)
            if not await reclear():
                print("could not re-clear — stopping with a partial grid", file=sys.stderr)
                stats["aborted"] = True
                break
            # Counted only on SUCCESS. Incrementing before the call reported a
            # rebuild that never happened whenever reclear() failed, which made
            # `reclears` a false statistic in exactly the runs someone would
            # investigate.
            stats["reclears"] += 1
            cache.clear()
            # Rewind to the first cell of this failure run: those cells were not
            # individually bad, they were collateral of an already-latched session.
            i = streak_start
            streak_start = None
            consecutive = 0
            continue

        if consecutive >= ABORT_AFTER:
            print(f"{consecutive} consecutive failures and no rebuilds left — "
                  f"stopping at cell {i}", file=sys.stderr)
            stats["aborted"] = True
            break

        i += 1
        await sleep(random.uniform(*JITTER))

    stats["cells_failed"] = stats["cells_total"] - stats["cells_ok"]
    return out_rows, stats


UNLOCKER_GQL_URL = "https://www.hemnet.se/graphql"
# Bright Data's unlocker terminates TLS, so certificate verification must be off
# (their own sample uses `curl -k`). This is a proxy we authenticate to, not an
# open one, and the payload carries no secrets.
UNLOCKER_VERIFY = False
# (connect, read). Read is bounded deliberately: a cold unlock can stall for a
# very long time and requests' read timeout is PER SOCKET READ, not a total
# deadline, so an unbounded value lets one call hang the whole run. Measured
# 2026-08-17: a warm /graphql POST returns in 4-21s, so 120s is generous.
UNLOCKER_TIMEOUT = (15, 120)
# The warm-up GET gets its own, longer budget — it is the call that PAYS the
# cold-unlock cost for the whole run.
UNLOCKER_WARMUP_TIMEOUT = (15, 240)
UNLOCKER_WARMUP_URL = "https://www.hemnet.se/priser"
# The warm-up is the run's single point of failure and Bright Data bills only
# SUCCESSFUL requests, so retrying it is close to free.
WARMUP_ATTEMPTS = 3
WARMUP_BACKOFF = 5.0
UNLOCKER_HEADERS = {
    "content-type": "application/json",
    "accept": "*/*",
    "origin": "https://www.hemnet.se",
    "referer": "https://www.hemnet.se/priser",
}


def warmup_unlocker(session):
    """GET the pricing page so the unlocker solves the domain before the grid.

    Returns True on a 200 that is not a challenge page. Never raises — a failed
    warm-up is a warning, not a run-ending error.
    """
    t0 = time.time()
    try:
        r = session.get(UNLOCKER_WARMUP_URL, headers={"accept": "text/html"},
                        timeout=UNLOCKER_WARMUP_TIMEOUT, verify=UNLOCKER_VERIFY)
    except Exception as e:
        print(f"warm-up {type(e).__name__} after {time.time()-t0:.0f}s: {str(e)[:150]}",
              file=sys.stderr)
        return False
    challenged = bool(BLOCK_RE.search(r.text[:2000]))
    # Requiring CLEAR_RE, not merely "a 200 that isn't a challenge": a Bright
    # Data soft-error page or a 200 interstitial would otherwise count as warm
    # and we would enter the grid believing the domain was unlocked. This is the
    # same positive check the browser path uses in wait_for_usable.
    cleared = bool(CLEAR_RE.search(r.text))
    print(f"warm-up HTTP {r.status_code} in {time.time()-t0:.0f}s "
          f"len={len(r.text)} challenged={challenged} cleared={cleared}",
          file=sys.stderr)
    return r.status_code == 200 and not challenged and cleared


def warmup_unlocker_retrying(session, attempts=WARMUP_ATTEMPTS):
    """Warm up, retrying. The cold unlock is the run's single point of failure.

    Cheap insurance: Bright Data bills only SUCCESSFUL requests, so a failed
    warm-up attempt costs nothing, while skipping the warm-up walks straight
    into the cold-POST stall this whole change exists to avoid.
    """
    for i in range(1, attempts + 1):
        if warmup_unlocker(session):
            return True
        if i < attempts:
            time.sleep(WARMUP_BACKOFF * i)
            print(f"warm-up retry {i + 1}/{attempts}", file=sys.stderr)
    return False


def make_unlocker_gql(get_session, opnames):
    """Build the `gql` seam for the unlocker transport.

    A plain proxied POST — no browser, no Cloudflare page to clear. Raises
    FetchError with the evidence on anything that is not a 200 carrying JSON, so
    run_grid's existing per-cell retry treats it exactly like a refused in-page
    fetch.

    `get_session` is a CALLABLE, not a Session, and is resolved per request. That
    is load-bearing: reclear() swaps the session underneath, and binding the
    object here would leave every later request on the dead one — the same
    late-binding trap the browser path avoids by reading state["page"] at
    call time.
    """
    async def gql(query, variables):
        if query not in opnames:
            # A wrong operationName is rejected server-side in a way that looks
            # like a transport failure. Fail here instead, where it is obvious.
            raise ValueError("gql: unknown query, refusing to guess operationName")
        opname = opnames[query]
        body = {"operationName": opname, "variables": variables, "query": query}

        def _post():
            return get_session().post(UNLOCKER_GQL_URL, json=body,
                                      headers=UNLOCKER_HEADERS,
                                      timeout=UNLOCKER_TIMEOUT,
                                      verify=UNLOCKER_VERIFY)

        r = await asyncio.to_thread(_post)
        if r.status_code != 200:
            raise FetchError(r.status_code, f"{opname}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError:
            raise FetchError(200, f"{opname} non-JSON: {r.text[:200]}")

    return gql


def default_session_factory(proxy):
    """Build a proxied requests.Session. Split out so tests can inject a fake."""
    def make():
        import requests
        s = requests.Session()
        s.proxies = {"http": proxy, "https": proxy}
        return s
    return make


async def crawl_unlocker(grid, proxy, session_factory=None, run=None):
    """Grid walk over Bright Data Web Unlocker. No browser is involved.

    Reuses run_grid unchanged, so per-cell retry, the abort budget and the
    honest completeness stats are identical to the browser transports.

    reclear() DOES REAL WORK here. It closes the session, opens a fresh one
    (a new proxy connection, hence a new Bright Data session) and re-warms.
    That matters: run_grid's latch branch fires at LATCH_AFTER=3 consecutive
    failures and BREAKS THE WHOLE GRID if reclear() returns False, which would
    make the deliberate ABORT_AFTER=8 budget unreachable and discard every
    remaining cell after a transient blip. A constant False here was measured
    throwing away 350 recoverable rows on a 3-cell blip.

    session_factory/run are injection seams for the offline selftest ONLY.
    """
    opnames = {AUTOCOMPLETE_QUERY: "webAutocompleteLocations",
               PRICING_QUERY: "webPricingCalculator"}
    make_session = session_factory or default_session_factory(proxy)
    run = run or run_grid
    try:
        import urllib3
        # Scoped: a blanket disable_warnings() would silence unrelated urllib3
        # warnings process-wide.
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass

    state = {"session": make_session()}

    def _rebuild():
        old = state["session"]
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        state["session"] = make_session()
        print("unlocker session rebuilt — re-warming", file=sys.stderr)
        return warmup_unlocker_retrying(state["session"])

    gql = make_unlocker_gql(lambda: state["session"], opnames)

    # WARM-UP — do not remove, and do not downgrade to best-effort.
    # Evidence 2026-08-17: a 60-cell run that went straight to POST /graphql on a
    # COLD domain hung 30 minutes on its first call and never tripped its own read
    # timeout; the validated probe, which did this GET first, worked from cold.
    # A normal page load is what Web Unlocker is built to unlock; once it has,
    # /graphql POSTs return in 4-21s and the warm-up itself costs ~31-39s.
    #
    # Confidence note: this is inference from n=1 cold failure vs n=1 cold
    # success. The corroborating 3-cell POST-only run was taken WARM, so it does
    # not independently establish the cold-stall mechanism. Ship it regardless —
    # it costs one request and Bright Data bills only successful ones — but if
    # this stops working, re-test the mechanism rather than trusting this comment.
    #
    # Monthly cadence means EVERY production run starts cold, so this is the only
    # path that ever executes.
    if not await asyncio.to_thread(warmup_unlocker_retrying, state["session"]):
        # Hard fail. "Warn and continue" is the one response the cold-stall
        # finding forbids: it walks the grid into the exact documented failure
        # mode and burns ~20 minutes producing nothing.
        print("VERDICT: WARMUP_FAILED", file=sys.stderr)
        sys.exit(4)

    async def fetch(cell, cache):
        return await fetch_cell(gql, cell, cache)

    async def reclear():
        return await asyncio.to_thread(_rebuild)

    try:
        return await run(grid, fetch, reclear)
    finally:
        if state["session"] is not None:
            try:
                state["session"].close()
            except Exception:
                pass


async def crawl(grid, key):
    if TRANSPORT == "unlocker":
        return await crawl_unlocker(grid, key)

    from playwright.async_api import async_playwright

    probe_name = grid[0]["name"] if grid else "Stockholm"

    async with async_playwright() as pw:
        state = {"session": None, "browser": None, "page": None}

        async def reclear():
            await _teardown(state["browser"], key, state["session"])
            state["session"] = state["browser"] = state["page"] = None
            s, b, p = await open_cleared_page(
                pw, key, probe_name, tag=" [rebuild]")
            state["session"], state["browser"], state["page"] = s, b, p
            return p is not None

        async def gql(query, variables):
            return await in_page_fetch(state["page"], query, variables)

        async def fetch(cell, cache):
            return await fetch_cell(gql, cell, cache)

        try:
            s, b, p = await open_cleared_page(pw, key, probe_name)
            state["session"], state["browser"], state["page"] = s, b, p
            if p is None:
                print("VERDICT: BLOCKED_CF", file=sys.stderr)
                sys.exit(4)
            return await run_grid(grid, fetch, reclear)
        finally:
            await _teardown(state["browser"], key, state["session"])


def main():
    if TRANSPORT not in TRANSPORTS:
        print(f"ADCOST_TRANSPORT={TRANSPORT!r} unknown ({'|'.join(TRANSPORTS)})",
              file=sys.stderr)
        sys.exit(2)
    key = read_credential()
    if not key:
        var = {"unlocker": UNLOCKER_PROXY_VAR,
               "brightdata": BRIGHTDATA_URL_VAR}.get(TRANSPORT, "STEEL_API_KEY")
        print(f"{var} not set (env or repo-root .env)", file=sys.stderr)
        sys.exit(2)
    print(f"transport={TRANSPORT}", file=sys.stderr)
    grid = json.load(sys.stdin)
    # Truncation used to be silent: a 900s budget aborted a run in which 41 of 41
    # attempted cells had SUCCEEDED, and the only evidence was aborted=True. Say
    # so up front, with the numbers, so a short deploy is obvious in the log
    # rather than inferred from a short harvest a month later.
    if TRANSPORT == "unlocker":
        need = grid_seconds_needed(len(grid))
        print(f"budget={TIME_BUDGET:.0f}s (subprocess_timeout={SUBPROCESS_TIMEOUT:.0f}s) "
              f"need~{need:.0f}s for {len(grid)} cells", file=sys.stderr)
        if TIME_BUDGET < need:
            print(f"WARNING: time budget {TIME_BUDGET:.0f}s is BELOW the ~{need:.0f}s this "
                  f"grid needs — the run WILL truncate. Raise tasks.py's "
                  f"subprocess.run(timeout=) to >= {REQUIRED_SUBPROCESS_TIMEOUT:.0f}s and "
                  f"export ADCOST_SUBPROCESS_TIMEOUT to match.", file=sys.stderr)
    rows, stats = asyncio.run(crawl(grid, key))
    stats["expected_rows"] = len(grid) * len(OFFER_SLUGS)
    print(f"crawl complete rows={len(rows)}/{stats['expected_rows']} "
          f"cells={stats['cells_ok']}/{stats['cells_total']} "
          f"reclears={stats['reclears']} aborted={stats['aborted']}", file=sys.stderr)
    json.dump({"rows": rows, "stats": stats}, sys.stdout)
    # A run that collected NOTHING is a dead transport, not an empty result. The
    # browser paths already exit 4 for "could not get through"; without this the
    # unlocker reports total failure — including a malformed proxy URL — as
    # exit 0, which is exactly the silent-success class of bug this module was
    # rewritten to eliminate. Dump the JSON first so the caller keeps the stats.
    if stats.get("cells_total") and not stats.get("cells_ok"):
        sys.stdout.flush()
        print("VERDICT: NO_CELLS_COLLECTED", file=sys.stderr)
        sys.exit(4)


# ---------------------------------------------------------------------------
# Offline self-test. No network, no browser, no Steel spend.
#   python adcost_steel.py --selftest
# ---------------------------------------------------------------------------

def _fake_grid(n_muni=10, n_price=6):
    return [{"name": f"M{m}", "full_name": f"M{m} kommun", "price": 1000000 * (p + 1)}
            for m in range(n_muni) for p in range(n_price)]


def _priced_ok():
    return [{"code": SLUG_TO_AD_TYPE[s], "amount": 1000.0} for s in OFFER_SLUGS]


async def _run_case(grid, behaviour, reclear_results):
    """behaviour(index, call_n, generation) -> True to succeed, else raise."""
    calls = {}
    gen = {"n": 0}
    reclears = list(reclear_results)

    async def fetch(cell, cache):
        idx = grid.index(cell)
        calls[idx] = calls.get(idx, 0) + 1
        if behaviour(idx, calls[idx], gen["n"]):
            return _priced_ok()
        raise RuntimeError(f"refused cell {idx}")

    async def reclear():
        if not reclears:
            return False
        ok = reclears.pop(0)
        if ok:
            gen["n"] += 1
        return ok

    async def nosleep(_):
        return None

    return await run_grid(grid, fetch, reclear, sleep=nosleep)


def selftest():
    failures = []

    def check(name, cond, detail=""):
        if cond:
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name} {detail}")
            failures.append(name)

    grid = _fake_grid()
    expected_rows = len(grid) * len(OFFER_SLUGS)
    print(f"grid={len(grid)} cells, expected_rows={expected_rows}")

    # 1. Happy path.
    rows, stats = asyncio.run(_run_case(grid, lambda i, c, g: True, []))
    check("happy path fills the grid", len(rows) == expected_rows and stats["cells_ok"] == 60,
          f"rows={len(rows)} ok={stats['cells_ok']}")
    check("happy path needs no rebuild", stats["reclears"] == 0 and not stats["aborted"])

    # 2. Jul-1 pattern: scattered transient refusals that succeed on retry.
    #    The old loop dropped these cells outright.
    rows, stats = asyncio.run(_run_case(
        grid, lambda i, c, g: not (i in (0, 1, 2, 3, 4, 7) and c == 1), []))
    check("per-cell retry recovers transient refusals",
          len(rows) == expected_rows and stats["cells_failed"] == 0,
          f"rows={len(rows)} failed={stats['cells_failed']}")
    check("transient recovery does not rebuild the session", stats["reclears"] == 0)

    # 3. Aug-2 latch: everything from cell 6 on is refused until a rebuild.
    #    Old behaviour = 6/60 cells and exit 0. New = full grid after one rebuild.
    rows, stats = asyncio.run(_run_case(
        grid, lambda i, c, g: i < 6 or g >= 1, [True]))
    check("latched session is rebuilt and the grid completes",
          len(rows) == expected_rows and stats["cells_ok"] == 60,
          f"rows={len(rows)} ok={stats['cells_ok']}")
    check("rebuild happens exactly once", stats["reclears"] == 1, f"reclears={stats['reclears']}")
    check("rebuild resumes from the failed cell, not the next one",
          any(r["full_name"] == grid[6]["full_name"] and r["price"] == grid[6]["price"]
              for r in rows), "cell 6 missing from output")

    # 4. Latch that never clears: bounded, partial, and honestly flagged.
    rows, stats = asyncio.run(_run_case(
        grid, lambda i, c, g: i < 6, [False]))
    check("unrecoverable latch stops early", stats["aborted"] is True)
    check("unrecoverable latch keeps what it collected",
          stats["cells_ok"] == 6 and len(rows) == 6 * len(OFFER_SLUGS),
          f"ok={stats['cells_ok']} rows={len(rows)}")
    check("unrecoverable latch reports the shortfall",
          stats["cells_failed"] == 54, f"failed={stats['cells_failed']}")

    # 5. Rebuild budget is finite — no infinite reclear loop.
    rows, stats = asyncio.run(_run_case(
        grid, lambda i, c, g: i < 6, [True] * 10))
    check("rebuilds are capped at MAX_RECLEARS", stats["reclears"] == MAX_RECLEARS,
          f"reclears={stats['reclears']}")
    check("run terminates after the cap", stats["aborted"] is True)

    # 6. A 200 carrying no pricingCalculator is a failure, not an empty success.
    check("empty pricing payload parses to nothing", parse_pricing({"data": {}}) == [])
    check("empty pricing payload is not silently accepted",
          _priced_ok() and len(parse_pricing(
              {"data": {"pricingCalculator": [
                  {"offerSlug": "BAS",
                   "prices": {PAYMENT_METHOD: {"total": {"amountInCents": 729700}}}}]}})) == 1)

    # 7. parse_pricing still honours the historical payment method.
    parsed = parse_pricing({"data": {"pricingCalculator": [
        {"offerSlug": "BAS", "prices": {
            "PAY_NOW": {"total": {"amountInCents": 682000}},
            PAYMENT_METHOD: {"total": {"amountInCents": 729700}}}}]}})
    check("parse_pricing uses PAY_WHEN_LISTING_IS_REMOVED",
          parsed == [{"code": "BASIC", "amount": 7297.0}], f"got {parsed}")

    # 8. Transport seam (brightdata). All offline — no connect, no spend.
    import io
    import contextlib

    g = globals()
    saved = (g["TRANSPORT"], g["PROXY_COUNTRY"])
    BRD = ("wss://brd-customer-CUST-zone-ZONE:SECRET@brd.superproxy.io:9222")
    try:
        g["TRANSPORT"], g["PROXY_COUNTRY"] = "brightdata", None

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            s = create_session(BRD)
        check("brightdata session needs no HTTP call", s["cdp_url"] == BRD)
        check("brightdata session has no websocketUrl", "websocketUrl" not in s)
        check("brightdata session never logs the secret", "SECRET" not in err.getvalue(),
              err.getvalue().strip())
        check("brightdata release is a no-op", release_session(BRD, s["id"]) is None)
        check("cdp_endpoint prefers the brightdata connect string",
              cdp_endpoint(s, BRD) == BRD)
        check("cdp_endpoint still builds the steel URL",
              cdp_endpoint({"websocketUrl": "wss://s/x?a=1"}, "K") == "wss://s/x?a=1&apiKey=K")
        check("no country targeting when unset", brightdata_cdp_url(BRD) == BRD)

        g["PROXY_COUNTRY"] = "SE"
        tgt = brightdata_cdp_url(BRD)
        check("country goes in the username, not a query string",
              tgt.startswith("wss://brd-customer-CUST-zone-ZONE-country-se:SECRET@")
              and "country=" not in tgt, tgt)
        check("country targeting is idempotent", brightdata_cdp_url(tgt) == tgt)
        check("country targeting preserves the password",
              tgt.endswith(":SECRET@brd.superproxy.io:9222"), tgt)
        check("a non-brightdata URL is left alone",
              brightdata_cdp_url("wss://steel/x") == "wss://steel/x")
    finally:
        g["TRANSPORT"], g["PROXY_COUNTRY"] = saved

    # 9. Unlocker transport seam. Offline — a fake session, no proxy, no spend.
    class _Resp:
        def __init__(self, status, text, payload=None):
            self.status_code, self.text, self._payload = status, text, payload

        def json(self):
            if self._payload is None:
                raise ValueError("not json")
            return self._payload

    class _Session:
        def __init__(self, resp, get_resp=None):
            self.resp, self.get_resp, self.calls = resp, get_resp, []

        def post(self, url, json=None, headers=None, timeout=None, verify=None):
            self.calls.append({"url": url, "body": json, "headers": headers,
                               "verify": verify, "timeout": timeout})
            return self.resp

        def get(self, url, headers=None, timeout=None, verify=None):
            self.calls.append({"url": url, "get": True, "timeout": timeout})
            if isinstance(self.get_resp, Exception):
                raise self.get_resp
            return self.get_resp

    opnames = {AUTOCOMPLETE_QUERY: "webAutocompleteLocations",
               PRICING_QUERY: "webPricingCalculator"}

    ok_payload = {"data": {"pricingCalculator": [
        {"offerSlug": "BAS",
         "prices": {PAYMENT_METHOD: {"total": {"amountInCents": 729700}}}}]}}
    sess = _Session(_Resp(200, "{}", ok_payload))
    gql = make_unlocker_gql(lambda: sess, opnames)
    got = asyncio.run(gql(PRICING_QUERY, {"locationId": "1"}))
    check("unlocker returns parsed JSON on 200", got == ok_payload)
    check("unlocker posts to hemnet /graphql", sess.calls[0]["url"] == UNLOCKER_GQL_URL)
    check("unlocker names the operation",
          sess.calls[0]["body"]["operationName"] == "webPricingCalculator")
    asess = _Session(_Resp(200, "{}", {"data": {}}))
    asyncio.run(make_unlocker_gql(lambda: asess, opnames)(AUTOCOMPLETE_QUERY, {}))
    check("unlocker names the autocomplete op",
          asess.calls[0]["body"]["operationName"] == "webAutocompleteLocations",
          f'got {asess.calls[0]["body"]["operationName"]!r}')

    def _unknown_query_raises():
        try:
            asyncio.run(make_unlocker_gql(lambda: asess, opnames)("some other query", {}))
        except ValueError:
            return True
        except Exception:
            return False
        return False

    check("unlocker refuses to guess an operationName", _unknown_query_raises())
    check("unlocker disables TLS verify (BD terminates TLS)",
          sess.calls[0]["verify"] is False)

    def _raises(resp):
        try:
            s = _Session(resp)
            asyncio.run(make_unlocker_gql(lambda: s, opnames)(PRICING_QUERY, {}))
        except FetchError:
            return True
        except Exception:
            return False
        return False

    check("unlocker raises FetchError on non-200", _raises(_Resp(403, "<html>nope")))
    check("unlocker raises FetchError on non-JSON", _raises(_Resp(200, "<html>nope")))

    # A refusal must look like a refused in-page fetch so run_grid RETRIES it.
    # Asserting the base class was a proxy for the invariant, not the invariant:
    # run_grid catches Exception, so the base class is not what makes it
    # retryable, and the old check false-failed on a harmless base-class change.
    # Drive the real run_grid instead.
    def _fetch_flaky_once():
        seen = {}

        async def fetch(cell, cache):
            n = seen.get(id(cell), 0) + 1
            seen[id(cell)] = n
            if n == 1:
                raise FetchError(403, "refused")
            return _priced_ok()
        return fetch

    async def _no_reclear():
        return False

    async def _nosleep(_):
        return None

    rows_r, stats_r = asyncio.run(run_grid(
        _fake_grid(2, 1), _fetch_flaky_once(), _no_reclear, sleep=_nosleep))
    check("a FetchError refusal is retried, not fatal",
          stats_r["cells_ok"] == 2 and stats_r["reclears"] == 0
          and not stats_r["aborted"], f"stats={stats_r}")

    # The gql seam refactor: fetch_cell must work against ANY gql callable.
    async def _fake_gql(query, variables):
        if query is AUTOCOMPLETE_QUERY:
            return {"data": {"autocompleteLocations": {
                "hits": [{"id": "18031", "fullName": "Stockholms kommun"}]}}}
        return ok_payload

    cache = {}
    rows = asyncio.run(fetch_cell(
        _fake_gql, {"name": "Stockholm", "full_name": "Stockholms kommun",
                    "price": 5000000}, cache))
    check("fetch_cell works through the gql seam",
          rows == [{"code": "BASIC", "amount": 7297.0}], f"got {rows}")
    check("resolve_location_id caches per municipality",
          cache == {"Stockholms kommun": "18031"}, f"cache={cache}")

    # 10. Warm-up. The cold-start stall that hung a 60-cell run for 30 minutes.
    #     A monthly cadence means EVERY run is cold, so this is the only path
    #     that runs in production — it must not regress.
    ws = _Session(None, _Resp(200, "<html>Räkna ut priset ... Utgångspris</html>"))
    check("warm-up returns True on a clean 200", warmup_unlocker(ws) is True)
    check("warm-up GETs the pricing page", ws.calls[0]["url"] == UNLOCKER_WARMUP_URL)

    wc = _Session(None, _Resp(200, "<title>Just a moment...</title>"))
    check("warm-up returns False on a challenge page", warmup_unlocker(wc) is False)
    check("warm-up returns False on a non-200",
          warmup_unlocker(_Session(None, _Resp(403, "nope"))) is False)
    check("warm-up swallows transport errors rather than killing the run",
          warmup_unlocker(_Session(None, RuntimeError("read timed out"))) is False)

    # The bug was an unbounded stall. Both budgets must be finite (connect, read),
    # because requests' read timeout is per-read, not a total deadline.
    check("gql read timeout is bounded",
          isinstance(UNLOCKER_TIMEOUT, tuple) and all(
              isinstance(x, (int, float)) and x > 0 for x in UNLOCKER_TIMEOUT),
          f"{UNLOCKER_TIMEOUT!r}")
    check("warm-up timeout is bounded and >= the per-call read budget",
          isinstance(UNLOCKER_WARMUP_TIMEOUT, tuple)
          and UNLOCKER_WARMUP_TIMEOUT[1] >= UNLOCKER_TIMEOUT[1],
          f"{UNLOCKER_WARMUP_TIMEOUT!r} vs {UNLOCKER_TIMEOUT!r}")
    check("gql passes the bounded timeout through",
          sess.calls[0]["timeout"] == UNLOCKER_TIMEOUT, f"{sess.calls[0]['timeout']!r}")

    # 11. The clock. A 900s budget aborted a run in which every attempted cell
    #     SUCCEEDED (41/41) — the grid was truncated purely by the timer, and
    #     stats said aborted=True on a healthy crawl. Guard both ends of it.
    need = grid_seconds_needed(FULL_GRID_CELLS)
    # The budget is DERIVED from the caller's timeout, so test the derivation at
    # both the value that is deployed today and the value the deploy must reach.
    check("at the required timeout the budget covers the measured grid",
          derive_time_budget(REQUIRED_SUBPROCESS_TIMEOUT) >= need,
          f"budget={derive_time_budget(REQUIRED_SUBPROCESS_TIMEOUT)} need={need}")
    check("at the required timeout the budget carries a slower month",
          derive_time_budget(REQUIRED_SUBPROCESS_TIMEOUT)
          >= grid_seconds_needed(FULL_GRID_CELLS, 30.0),
          f"budget={derive_time_budget(REQUIRED_SUBPROCESS_TIMEOUT)}")
    # Documents WHY tasks.py must change: the old 1800s cannot fit the grid.
    check("the pre-change 1800s timeout is provably too small",
          derive_time_budget(1800) < need,
          "1800s would now be sufficient — re-derive REQUIRED_SUBPROCESS_TIMEOUT")
    check("tasks.py's 2700s satisfies the requirement",
          2700 >= REQUIRED_SUBPROCESS_TIMEOUT,
          f"need >= {REQUIRED_SUBPROCESS_TIMEOUT}")
    # Safety invariant, whatever the timeout: never overrun the caller, because
    # subprocess.run DISCARDS stdout on TimeoutExpired — total loss, not partial.
    for t in (1800, 2700, 3600):
        check(f"budget leaves room for the worst cell at timeout={t}",
              derive_time_budget(t) + WORST_CELL_SEC <= t or derive_time_budget(t) == 300.0,
              f"{derive_time_budget(t)}+{WORST_CELL_SEC} vs {t}")

    # 12. crawl_unlocker WIRING. Previously uncovered: a review proved the
    #     warm-up call could be DELETED and this suite stayed green — i.e. the
    #     single change this transport exists to make was untested.
    warm_page = _Resp(200, "<html>Räkna ut priset — Utgångspris</html>")

    class _FakeSess:
        def __init__(self, log, idx):
            self.log, self.idx, self.closed = log, idx, False

        def get(self, url, headers=None, timeout=None, verify=None):
            self.log.append(("warmup", self.idx))
            return warm_page

        def post(self, url, json=None, headers=None, timeout=None, verify=None):
            self.log.append(("post", self.idx))
            return _Resp(200, "{}", ok_payload)

        def close(self):
            self.closed = True

    def _factory(log, made):
        def make():
            s = _FakeSess(log, len(made))
            made.append(s)
            return s
        return make

    # (a) the warm-up must happen BEFORE any grid request.
    log, made = [], []
    asyncio.run(crawl_unlocker(
        _fake_grid(1, 1), "proxy", session_factory=_factory(log, made),
        run=lambda g, f, r: run_grid(g, f, r, sleep=_nosleep)))
    check("warm-up runs before the first grid request",
          log and log[0][0] == "warmup", f"log={log[:3]}")
    check("crawl_unlocker closes its session", made[0].closed)

    # (b) reclear must REBUILD — a constant False turns LATCH_AFTER into an
    #     abort at 3 and strands the rest of the grid.
    log2, made2 = [], []

    async def _capture_run(g, f, r):
        rebuilt = await r()
        return ([], {"rebuilt": rebuilt})

    _, res = asyncio.run(crawl_unlocker(
        _fake_grid(1, 1), "proxy", session_factory=_factory(log2, made2),
        run=_capture_run))
    check("reclear rebuilds the session and re-warms", res["rebuilt"] is True)
    check("reclear opens a NEW session", len(made2) == 2, f"sessions={len(made2)}")
    check("reclear closes the old session", made2[0].closed is True)
    check("reclear re-warms the new session",
          log2.count(("warmup", 1)) >= 1, f"log={log2}")

    # (c) a failed warm-up must abort, not proceed into the cold-stall path.
    class _ColdSess(_FakeSess):
        def get(self, url, headers=None, timeout=None, verify=None):
            self.log.append(("warmup-fail", self.idx))
            return _Resp(200, "<title>Just a moment...</title>")

    def _cold_factory(log, made):
        def make():
            s = _ColdSess(log, len(made))
            made.append(s)
            return s
        return make

    def _warmup_failure_exits():
        try:
            asyncio.run(crawl_unlocker(
                _fake_grid(1, 1), "proxy",
                session_factory=_cold_factory([], []),
                run=lambda g, f, r: run_grid(g, f, r, sleep=_nosleep)))
        except SystemExit as e:
            return e.code == 4
        return False

    check("a failed warm-up exits 4 instead of walking into the grid",
          _warmup_failure_exits())

    # (d) the TIME_BUDGET abort must actually fire — use run_grid's clock seam,
    #     which existed but was never exercised by any test.
    ticks = {"t": 0.0}

    def _clock():
        ticks["t"] += TIME_BUDGET  # second cell is already over budget
        return ticks["t"]

    async def _ok_fetch(cell, cache):
        return _priced_ok()

    _, stats_b = asyncio.run(run_grid(
        _fake_grid(4, 1), _ok_fetch, _no_reclear, sleep=_nosleep, clock=_clock))
    check("the time budget aborts the walk", stats_b["aborted"] is True,
          f"stats={stats_b}")
    check("the budget abort keeps what it collected",
          0 < stats_b["cells_ok"] < 4, f"ok={stats_b['cells_ok']}")

    print()
    if failures:
        print(f"SELFTEST FAILED: {len(failures)} check(s): {', '.join(failures)}")
        return 1
    print("SELFTEST PASSED")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    main()
