import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlparse

import lxml.html
import pydash
import requests
from celery import Task, group
from celery.exceptions import SoftTimeLimitExceeded
from celery.signals import worker_process_init, worker_process_shutdown
from django.db import models
from django.utils import timezone
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from config.celery import app
from apps.core import models as core_models
from apps.core.webscraper import WebScraper
from apps.hemnet.constants import (
    BASE_URL,
    GRAPHQL_URL,
    PRICE_RANGES,
    SEARCH_PARAMS,
    TIMEOUT,
    USER_AGENT,
)
from apps.hemnet.models import (
    AdCostV2,
    AdCostPricePointV2,
    BrokerV2,
    BrokerAgencyV2,
    ListingV2,
    MunicipalityV2,
    ScrapeError,
)

logger = logging.getLogger(__name__)
playwright = None
browser = None
context = None
redis_client = None

HEMNET_PLAYWRIGHT_QUEUE_NAME = "playwright_queue"
HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_THRESHOLD = int(
    os.getenv("HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_THRESHOLD", "20000")
)
HEMNET_PLAYWRIGHT_QUEUE_RESUME_THRESHOLD = int(
    os.getenv("HEMNET_PLAYWRIGHT_QUEUE_RESUME_THRESHOLD", "12000")
)
HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_SLEEP = int(
    os.getenv("HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_SLEEP", "15")
)
HEMNET_SCRAPE_DEDUPE_TTL_SECONDS = int(
    os.getenv("HEMNET_SCRAPE_DEDUPE_TTL_SECONDS", str(6 * 60 * 60))
)
HEMNET_RUN_TRACKING_TTL_SECONDS = int(
    os.getenv("HEMNET_RUN_TRACKING_TTL_SECONDS", str(7 * 24 * 60 * 60))
)
HEMNET_INTERRUPT_PREVIOUS_RUN = os.getenv("HEMNET_INTERRUPT_PREVIOUS_RUN", "true").lower() in {
    "1",
    "true",
    "yes",
}
HEMNET_DETAIL_PAGE_TIMEOUT_SECONDS = int(
    os.getenv("HEMNET_DETAIL_PAGE_TIMEOUT_SECONDS", "120")
)
HEMNET_DETAIL_SOFT_TIME_LIMIT_SECONDS = int(
    os.getenv("HEMNET_DETAIL_SOFT_TIME_LIMIT_SECONDS", str(HEMNET_DETAIL_PAGE_TIMEOUT_SECONDS + 15))
)
HEMNET_DETAIL_HARD_TIME_LIMIT_SECONDS = int(
    os.getenv("HEMNET_DETAIL_HARD_TIME_LIMIT_SECONDS", str(HEMNET_DETAIL_SOFT_TIME_LIMIT_SECONDS + 15))
)
WEBSCRAPER_FAILED_HTML_MAX_CHARS = int(
    os.getenv("WEBSCRAPER_FAILED_HTML_MAX_CHARS", "12000")
)


def get_redis_client():
    global redis_client
    if redis_client is not None:
        return redis_client
    try:
        import redis  # type: ignore
    except Exception:
        logger.warning("redis package not available, queue backpressure/dedupe disabled")
        redis_client = False
        return None

    try:
        broker_url = app.conf.broker_url or "redis://redis:6379/0"
        parsed = urlparse(broker_url)
        if parsed.scheme != "redis":
            logger.warning("non-redis broker detected, queue backpressure/dedupe disabled [url=%s]", broker_url)
            redis_client = False
            return None
        redis_client = redis.Redis(
            host=parsed.hostname or "redis",
            port=parsed.port or 6379,
            db=int((parsed.path or "/0").strip("/") or "0"),
            password=parsed.password,
            socket_timeout=5,
            socket_connect_timeout=5,
            decode_responses=False,
        )
        redis_client.ping()
        return redis_client
    except Exception as ex:
        logger.warning("failed to init redis client for queue controls: %s", ex)
        redis_client = False
        return None


def get_queue_length(queue_name: str) -> int | None:
    client = get_redis_client()
    if not client:
        return None
    try:
        return int(client.llen(queue_name))
    except Exception as ex:
        logger.warning("failed to read queue length [queue=%s]: %s", queue_name, ex)
        return None


def maybe_wait_for_playwright_queue_capacity():
    while True:
        queue_length = get_queue_length(HEMNET_PLAYWRIGHT_QUEUE_NAME)
        if queue_length is None:
            return
        if queue_length <= HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_THRESHOLD:
            return
        logger.warning(
            "playwright queue above threshold [length=%s] [threshold=%s], sleeping %ss",
            queue_length,
            HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_THRESHOLD,
            HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_SLEEP,
        )
        time.sleep(HEMNET_PLAYWRIGHT_QUEUE_BACKPRESSURE_SLEEP)
        queue_length = get_queue_length(HEMNET_PLAYWRIGHT_QUEUE_NAME)
        if queue_length is not None and queue_length <= HEMNET_PLAYWRIGHT_QUEUE_RESUME_THRESHOLD:
            logger.info(
                "playwright queue resumed below threshold [length=%s] [resume_threshold=%s]",
                queue_length,
                HEMNET_PLAYWRIGHT_QUEUE_RESUME_THRESHOLD,
            )
            return


def acquire_hemnet_scrape_dedupe(url: str) -> bool:
    client = get_redis_client()
    if not client:
        return True
    key = f"hemnet:scrape_listing_2:dedupe:{url}"
    try:
        return bool(client.set(key, b"1", ex=HEMNET_SCRAPE_DEDUPE_TTL_SECONDS, nx=True))
    except Exception as ex:
        logger.warning("failed dedupe check [url=%s]: %s", url, ex)
        return True


def _hemnet_run_pending_key(run_id: int) -> str:
    return f"hemnet:run:{run_id}:pending"


def _hemnet_run_parent_done_key(run_id: int) -> str:
    return f"hemnet:run:{run_id}:parent_done"


def _hemnet_run_parent_failed_key(run_id: int) -> str:
    return f"hemnet:run:{run_id}:parent_failed"


def _hemnet_run_failure_reason_key(run_id: int) -> str:
    return f"hemnet:run:{run_id}:failure_reason"


def _hemnet_run_finalized_key(run_id: int) -> str:
    return f"hemnet:run:{run_id}:finalized"


def _format_failure_reason(reason: str | None) -> str:
    if not reason:
        return ""
    return reason.strip()[:2000]


def _maybe_finalize_hemnet_run(run_id: int):
    client = get_redis_client()
    if not client:
        return
    try:
        parent_done = int(client.get(_hemnet_run_parent_done_key(run_id)) or 0)
        pending = int(client.get(_hemnet_run_pending_key(run_id)) or 0)
        if parent_done != 1 or pending > 0:
            return

        if not client.set(_hemnet_run_finalized_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS, nx=True):
            return

        parent_failed = int(client.get(_hemnet_run_parent_failed_key(run_id)) or 0)
        status = (
            core_models.WebScraperRun.STATUS_FAILED
            if parent_failed
            else core_models.WebScraperRun.STATUS_FINISHED
        )
        failure_reason_raw = client.get(_hemnet_run_failure_reason_key(run_id))
        failure_reason = (
            failure_reason_raw.decode("utf-8", errors="replace")
            if isinstance(failure_reason_raw, (bytes, bytearray))
            else ""
        )
        update_kwargs = {
            "status": status,
            "finished_at": timezone.now(),
            "failure_reason": _format_failure_reason(failure_reason) if parent_failed else "",
        }
        core_models.WebScraperRun.objects.filter(id=run_id).update(
            **update_kwargs,
        )
    except Exception as ex:
        logger.warning("failed to finalize hemnet run [run_id=%s]: %s", run_id, ex)


def init_hemnet_run_tracking(run_id: int):
    client = get_redis_client()
    if not client:
        return
    try:
        client.set(_hemnet_run_pending_key(run_id), b"0", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        client.set(_hemnet_run_parent_done_key(run_id), b"0", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        client.set(_hemnet_run_parent_failed_key(run_id), b"0", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        client.delete(_hemnet_run_failure_reason_key(run_id))
        client.delete(_hemnet_run_finalized_key(run_id))
    except Exception as ex:
        logger.warning("failed to initialize hemnet run tracking [run_id=%s]: %s", run_id, ex)


def increment_hemnet_run_pending(run_id: int):
    client = get_redis_client()
    if not client:
        return
    try:
        client.incr(_hemnet_run_pending_key(run_id))
        client.expire(_hemnet_run_pending_key(run_id), HEMNET_RUN_TRACKING_TTL_SECONDS)
    except Exception as ex:
        logger.warning("failed to increment hemnet run pending [run_id=%s]: %s", run_id, ex)


def mark_hemnet_run_child_finished(run_id: int | None):
    if not run_id:
        return
    client = get_redis_client()
    if not client:
        return
    try:
        pending = int(client.decr(_hemnet_run_pending_key(run_id)))
        if pending <= 0:
            client.set(_hemnet_run_pending_key(run_id), b"0", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        else:
            client.expire(_hemnet_run_pending_key(run_id), HEMNET_RUN_TRACKING_TTL_SECONDS)
        _maybe_finalize_hemnet_run(run_id)
    except Exception as ex:
        logger.warning("failed to decrement hemnet run pending [run_id=%s]: %s", run_id, ex)


def mark_hemnet_run_parent_done(run_id: int, failed: bool, reason: str | None = None):
    reason = _format_failure_reason(reason)
    client = get_redis_client()
    if not client:
        status = core_models.WebScraperRun.STATUS_FAILED if failed else core_models.WebScraperRun.STATUS_FINISHED
        core_models.WebScraperRun.objects.filter(id=run_id).update(
            status=status,
            finished_at=timezone.now(),
            failure_reason=reason if failed else "",
        )
        return
    try:
        client.set(_hemnet_run_parent_done_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        if failed:
            client.set(_hemnet_run_parent_failed_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
            if reason:
                client.set(
                    _hemnet_run_failure_reason_key(run_id),
                    reason.encode("utf-8", errors="replace"),
                    ex=HEMNET_RUN_TRACKING_TTL_SECONDS,
                )
        _maybe_finalize_hemnet_run(run_id)
    except Exception as ex:
        logger.warning("failed to mark hemnet parent done [run_id=%s]: %s", run_id, ex)


def is_hemnet_run_active(run_id: int | None) -> bool:
    if not run_id:
        return True
    return core_models.WebScraperRun.objects.filter(
        id=run_id,
        status=core_models.WebScraperRun.STATUS_ACTIVE,
    ).exists()


def clear_hemnet_playwright_queue() -> int:
    client = get_redis_client()
    if not client:
        return 0
    try:
        return int(client.delete(HEMNET_PLAYWRIGHT_QUEUE_NAME))
    except Exception as ex:
        logger.warning("failed to clear playwright queue [queue=%s]: %s", HEMNET_PLAYWRIGHT_QUEUE_NAME, ex)
        return 0


def interrupt_hemnet_run(run_id: int):
    core_models.WebScraperRun.objects.filter(id=run_id).update(
        status=core_models.WebScraperRun.STATUS_INTERRUPTED,
        finished_at=timezone.now(),
        failure_reason="",
    )
    client = get_redis_client()
    if client:
        try:
            client.set(_hemnet_run_finalized_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
            client.set(_hemnet_run_parent_done_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
            client.set(_hemnet_run_parent_failed_key(run_id), b"1", ex=HEMNET_RUN_TRACKING_TTL_SECONDS)
        except Exception as ex:
            logger.warning("failed to mark interrupted hemnet run in redis [run_id=%s]: %s", run_id, ex)


def parse_search_listing_price(listing: dict) -> int:
    raw_price = listing.get("askingPrice")
    if isinstance(raw_price, (int, float)):
        return int(raw_price)
    if isinstance(raw_price, dict):
        amount = raw_price.get("amount")
        if isinstance(amount, (int, float)):
            return int(amount)
        raw_price = raw_price.get("formatted")
    if not raw_price:
        raw_price = listing.get("formattedLowestPrice")
    if not raw_price and isinstance(listing.get("adTargeting"), str):
        try:
            ad_targeting = json.loads(listing["adTargeting"])
            if isinstance(ad_targeting.get("property_price"), (int, float)):
                return int(ad_targeting["property_price"])
        except Exception:
            pass
    if not raw_price:
        return 0
    cleaned = (
        str(raw_price)
        .replace("kr", "")
        .replace("/mån", "")
        .replace(" ", "")
        .replace("\xa0", "")
    )
    digits = "".join(ch for ch in cleaned if ch.isdigit())
    return int(digits) if digits else 0


def parse_search_listing_images_count(listing: dict) -> int:
    images_results = (
        listing.get('images({"limit":300})')
        or listing.get('images({"limit":0})')
        or {}
    )
    if isinstance(images_results, dict):
        if isinstance(images_results.get("total"), int):
            return images_results["total"]
        images = images_results.get("images")
        if isinstance(images, list):
            return len(images)
    images = listing.get("images")
    if isinstance(images, list):
        return len(images)
    return 0


def parse_search_listing_type(listing: dict) -> str:
    listing_type = listing.get("activePackage", "") or ""
    if listing_type:
        return listing_type

    if listing.get("isProject"):
        labels = listing.get("labels") or []
        if isinstance(labels, list):
            for label in labels:
                identifier = (label or {}).get("identifier")
                if identifier == "NEW_CONSTRUCTION_PROJECT":
                    return identifier
            for label in labels:
                identifier = (label or {}).get("identifier")
                if identifier:
                    return identifier
        return "NEW_CONSTRUCTION_PROJECT"

    return ""


def parse_active_listing_price(active_listing_data: dict) -> int:
    amount = pydash.get(active_listing_data, "askingPrice.amount")
    if isinstance(amount, (int, float)):
        return int(amount)

    formatted_price = (
        pydash.get(active_listing_data, "formattedLowestPrice")
        or pydash.get(active_listing_data, "askingPrice.formatted")
        or ""
    )
    if formatted_price:
        digits = "".join(ch for ch in str(formatted_price) if ch.isdigit())
        if digits:
            return int(digits)

    ad_targeting = active_listing_data.get("adTargeting")
    if isinstance(ad_targeting, str):
        try:
            ad_targeting_data = json.loads(ad_targeting)
            property_price = ad_targeting_data.get("property_price")
            if isinstance(property_price, (int, float)):
                return int(property_price)
        except Exception:
            pass

    return 0


def extract_next_f_listing_data(page_source: str) -> dict | None:
    if not page_source:
        return None

    variants = (
        {
            "start_token": '\\"listing\\":{',
            "end_token": '},\\"listingId\\":\\"',
            "escaped": True,
        },
        {
            "start_token": '"listing":{',
            "end_token": '},"listingId":"',
            "escaped": False,
        },
    )

    for variant in variants:
        start = page_source.find(variant["start_token"])
        if start < 0:
            continue
        obj_start = page_source.find("{", start)
        if obj_start < 0:
            continue
        obj_end = page_source.find(variant["end_token"], obj_start)
        if obj_end < 0:
            continue

        raw_obj = page_source[obj_start:obj_end + 1]
        if variant["escaped"]:
            raw_obj = raw_obj.encode("utf-8", errors="ignore").decode("unicode_escape")
        try:
            listing_data = json.loads(raw_obj)
            if isinstance(listing_data, dict):
                return listing_data
        except Exception:
            continue

    return None


def save_listing_from_next_f(
    url: str,
    listing_data: dict,
    is_pre_market: bool,
    run_id: int | None,
):
    listing_id = listing_data.get("id") or listing_data.get("listingId")
    if not listing_id:
        raise RuntimeError(f"missing listing id in __next_f payload [url={url}]")
    listing_id = str(listing_id)

    published_at = listing_data.get("publishedAt")
    if isinstance(published_at, (int, float)):
        listed = datetime.fromtimestamp(float(published_at))
    else:
        listed = datetime.now()

    def resolve_name(value):
        if isinstance(value, dict):
            return value.get("fullName") or value.get("name") or ""
        if isinstance(value, str):
            return value
        return ""

    districts = listing_data.get("districts")
    district = ""
    if isinstance(districts, list) and districts:
        district = resolve_name(districts[0])
    elif districts:
        district = resolve_name(districts)

    municipality = resolve_name(listing_data.get("municipality")) or listing_data.get("searchableCity") or ""
    county = resolve_name(listing_data.get("region") or listing_data.get("county"))

    listing_type = pydash.get(listing_data, "activePackage") or ""
    if not listing_type and listing_data.get("isProject"):
        listing_type = (
            pydash.get(listing_data, "labels[1].identifier")
            or pydash.get(listing_data, "labels[0].identifier")
            or "NEW_CONSTRUCTION_PROJECT"
        )

    images_data = listing_data.get("images")
    if isinstance(images_data, dict):
        images = len(images_data.get("images") or [])
    elif isinstance(images_data, list):
        images = len(images_data)
    else:
        images = 0

    fields = {
        "is_active": True,
        "removed": None,
        "hemnet_id": listing_id,
        "listed": listed,
        "type": listing_type,
        "status": "",
        "title": listing_data.get("title") or "",
        "street_address": listing_data.get("streetAddress") or "",
        "district": district,
        "city": "",
        "municipality": municipality.replace(" kommun", ""),
        "county": county.replace(" län", ""),
        "postcode": listing_data.get("postCode") or None,
        "price": parse_active_listing_price(listing_data),
        "currency": pydash.get(listing_data, "askingPrice.currency.code") or "SEK",
        "housing_form": pydash.get(listing_data, "housingForm.name") or pydash.get(listing_data, "housingForm.symbol") or "",
        "tenure": pydash.get(listing_data, "tenure.name") or "",
        "land_area": listing_data.get("landArea") or None,
        "living_area": listing_data.get("livingArea") or None,
        "rooms": listing_data.get("numberOfRooms") or None,
        "amenities": ", ".join(
            [amenity.get("title", "") for amenity in (listing_data.get("relevantAmenities") or []) if amenity]
        ),
        "construction_year": listing_data.get("legacyConstructionYear") or "",
        "water_distance": listing_data.get("closestWaterDistanceMeters") or None,
        "coastline_distance": listing_data.get("coastlineDistanceMeters") or None,
        "broker": None,
        "broker_agency": None,
        "is_pre_market": is_pre_market,
        "images": images,
        "times_viewed": listing_data.get("timesViewed") or 0,
    }

    ListingV2.objects.update_or_create(url=url, defaults=fields)

    municipality_name = fields["municipality"]
    if municipality_name:
        MunicipalityV2.objects.get_or_create(name=municipality_name, full_name=municipality)

    if run_id:
        core_models.WebScraperRun.objects.filter(id=run_id).update(
            successful_records=models.F("successful_records") + 1
        )


def should_skip_existing_hemnet_listing(
    listing: dict, existing_data: dict | None, is_pre_market: bool
) -> bool:
    if not existing_data:
        return False

    current_price = parse_search_listing_price(listing)
    current_type = parse_search_listing_type(listing)
    current_images = parse_search_listing_images_count(listing)

    return (
        current_price == (existing_data.get("price") or 0)
        and current_type == (existing_data.get("type") or "")
        and bool(is_pre_market) == bool(existing_data.get("is_pre_market"))
        and current_images == (existing_data.get("images") or 0)
    )


def run_async(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


async def init_browser():
    global playwright, browser, context
    if not playwright:
        playwright = await async_playwright().start()
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                " AppleWebKit/537.36 (KHTML, like Gecko)"
                " Chrome/113.0.0.0 Safari/537.36"
            )
        )
        logger.info("Playwright browser launched")


async def close_browser():
    global context, browser, playwright
    if context:
        await context.close()
        context = None
    if browser:
        await browser.close()
        browser = None
    if playwright:
        await playwright.stop()
        playwright = None
    logger.info("Playwright browser closed")



@worker_process_init.connect
def celery_worker_init(**kwargs):
    from celery import current_app
    if "playwright_queue" in current_app.amqp.queues:
        run_async(init_browser())


@worker_process_shutdown.connect
def celery_worker_shutdown(**kwargs):
    run_async(close_browser())


async def _get_page_source_inner(url: str):
    if context is None:
        await init_browser()
    page = await context.new_page()
    try:
        response = await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        status = response.status if response else None
        try:
            await page.wait_for_load_state("networkidle", timeout=15000)
        except PlaywrightTimeoutError:
            # Hemnet pages may keep network activity open; keep current DOM.
            logger.warning("networkidle timeout for [url=%s], continuing with current content", url)
        try:
            # Most listing pages expose payload in __NEXT_DATA__; wait briefly before reading DOM.
            await page.wait_for_selector("script#__NEXT_DATA__", timeout=8000)
        except PlaywrightTimeoutError:
            logger.warning("missing __NEXT_DATA__ after wait [url=%s], continuing with current content", url)
        content = await page.content()
        return status, content
    finally:
        await page.close()


async def get_page_source(url: str):
    try:
        return await asyncio.wait_for(
            _get_page_source_inner(url),
            timeout=HEMNET_DETAIL_PAGE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as ex:
        raise RuntimeError(
            f"Timed out scraping listing [url={url}] "
            f"[timeout={HEMNET_DETAIL_PAGE_TIMEOUT_SECONDS}s]"
        ) from ex


def fetch_via_webscraper(url: str):
    """Fetch a page through the Oxylabs Web Scraper API (apps/core/webscraper.py).

    Phase 23 (FETCH-01): replaces the local headless-Chromium fetch
    (init_browser / get_page_source) for the Hemnet listing/search pages,
    ending the Hemnet 403 blocking. Returns (status, content) to preserve the
    previous get_page_source contract -- callers treat status >= 400 as a block
    and 2xx / 404 as terminal. Mirrors apps/booli/tasks.py, which already
    fetches via WebScraper(...).run() and extracts __NEXT_DATA__ from the HTML.

    max_wait_s is capped under scrape_listing_2's soft time limit so a slow
    Oxylabs job fails gracefully through the callers' retry/error paths rather
    than being hard-killed by celery. A returned body means Oxylabs delivered
    the page (status 200); challenge/interstitial pages are caught downstream by
    detect_interstitial_reason() / missing __NEXT_DATA__, exactly as in booli.

    The local-Chromium path (init_browser / get_page_source) is intentionally
    left in place as a one-line revert per the Phase 23 reversible-first rule.
    """
    content = WebScraper(url=url, max_wait_s=110, poll_interval_s=3.0).run()
    status = 200 if content else None
    return status, content


def detect_interstitial_reason(page_source: str) -> str | None:
    lower = (page_source or "").lower()
    markers = (
        "cdn-cgi/challenge-platform",
        "challenges.cloudflare.com",
        "turnstile",
        "verify you are human",
        "confirm you are human",
        "must review the security of your connection",
        "challenge-error-text",
    )
    if any(marker in lower for marker in markers):
        return "challenge/interstitial page detected"
    return None


def clip_failed_html(page_source: str | None) -> str:
    if not page_source:
        return ""
    try:
        root = lxml.html.fromstring(page_source)
        # Remove JS/CSS payload noise to keep diagnostic snapshots small.
        for node in root.xpath("//script|//style"):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
        text = root.text_content()
    except Exception:
        text = page_source
    # collapse whitespace so diagnostics remain compact
    text = " ".join((text or "").split())
    if len(text) <= WEBSCRAPER_FAILED_HTML_MAX_CHARS:
        return text
    half = WEBSCRAPER_FAILED_HTML_MAX_CHARS // 2
    return f"{text[:half]} ... {text[-half:]}"


def reset_browser():
    try:
        run_async(close_browser())
    except Exception as ex:
        logger.warning("failed to close browser during reset: %s", ex)
    try:
        run_async(init_browser())
    except Exception as ex:
        logger.warning("failed to re-init browser during reset: %s", ex)


class BaseTask(Task):
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        self.log_failure(exc, task_id, args, kwargs, einfo)
        super().on_failure(exc, task_id, args, kwargs, einfo)

    def log_failure(self, exc, task_id, args, kwargs, einfo):
        del exc, task_id, args, kwargs

        # self.request.url only exists for tasks that take a url. For any other
        # task (search_ad_cost_2, for one) Context raises AttributeError here,
        # which fired INSIDE celery's error path and stopped the row ever being
        # written — ScrapeError had zero rows from 2026-06-25 onward. The
        # handler must never be able to swallow the failure it is reporting.
        try:
            ScrapeError.objects.create(
                url=getattr(self.request, "url", None) or f"task:{self.name}",
                trace=einfo.traceback,
            )
        except Exception:
            logger.exception("failed to record ScrapeError for %s", self.name)

    def run(self, *args, **kwargs):
        pass


#=======================================================================================================================
#
# V2
#
#=======================================================================================================================


@app.task(bind=True, base=BaseTask)
def save_listing_2(
    self, data: dict, is_pre_market: bool = False, run_id: int | None = None
):
    url = data["url"]
    self.request.url = url

    if run_id and not is_hemnet_run_active(run_id):
        logger.info("skip save for non-active hemnet run [run_id=%s] [url=%s]", run_id, url)
        return

    logger.info("Saving listing [url=%s]...", url)

    def record_run_failure(error_message: str):
        if not run_id:
            return
        core_models.WebScraperRunResult.objects.create(
            run_id=run_id,
            url=url,
            status=core_models.WebScraperRunResult.STATUS_FAIL,
            error_message=error_message,
        )
        core_models.WebScraperRun.objects.filter(id=run_id).update(
            failed_records=models.F("failed_records") + 1
        )

    raw_data = data.get("raw_data")
    if not raw_data:
        message = "missing raw_data"
        record_run_failure(message)
        logger.warning("%s [url=%s]", message, url)
        return

    listing_id = pydash.get(raw_data, "props.pageProps.listingId")
    apollo_state = pydash.get(raw_data, "props.pageProps.__APOLLO_STATE__")
    if not isinstance(apollo_state, dict):
        message = "missing apollo state in raw_data"
        record_run_failure(message)
        logger.warning("%s [url=%s]", message, url)
        return

    if not listing_id:
        new_construction_project_id = pydash.get(raw_data, "props.pageProps.newConstructionProjectId")
        if new_construction_project_id:
            listing_id = str(new_construction_project_id)
            logger.info(
                "using new construction project id as listing id [url=%s] [project_id=%s]",
                url,
                new_construction_project_id,
            )
        else:
            debug_path = f"/tmp/hemnet_raw_{int(time.time())}.json"
            try:
                with open(debug_path, "w", encoding="utf-8") as fh:
                    json.dump(raw_data, fh)
                logger.warning(
                    "missing listing_id in raw_data saved raw_data [url=%s] [path=%s]",
                    url,
                    debug_path,
                )
            except Exception as ex:
                logger.warning(
                    "missing listing_id in raw_data failed to save raw_data [url=%s]: %s",
                    url,
                    ex,
                )
            record_run_failure("missing listing_id in raw_data")
            return

    root_query = apollo_state.get("ROOT_QUERY", {})
    listing_ref_entry = root_query.get(f'listing({{"id":"{listing_id}"}})')
    if isinstance(listing_ref_entry, dict):
        listing_ref = listing_ref_entry.get("__ref")
    else:
        listing_ref = listing_ref_entry

    active_listing_data = None
    if listing_ref:
        active_listing_data = apollo_state.get(listing_ref)
    if not active_listing_data:
        active_listing_data = apollo_state.get(f"ActivePropertyListing:{listing_id}")

    if not active_listing_data:
        debug_path = f"/tmp/hemnet_apollo_{listing_id}.json"
        try:
            with open(debug_path, "w", encoding="utf-8") as fh:
                json.dump(apollo_state, fh)
            logger.warning(
                "missing listing ref in apollo state [listing_id=%s] saved apollo state [path=%s]",
                listing_id,
                debug_path,
            )
        except Exception as ex:
            logger.warning(
                "missing listing ref in apollo state [listing_id=%s] failed to save apollo state: %s",
                listing_id,
                ex,
            )
        record_run_failure(f"missing listing ref in apollo state [listing_id={listing_id}]")
        return

    if broker_agency_data := [v for k, v in apollo_state.items() if k.startswith("BrokerAgency:")]:
        broker_agency_data = broker_agency_data[0]
        broker_agency, _ = BrokerAgencyV2.objects.get_or_create(
            hemnet_id=int(broker_agency_data["id"]),
            defaults={"name": broker_agency_data.get("name", "") or ""},
        )
    else:
        broker_agency = None

    if broker_data := [v for k, v in apollo_state.items() if k.startswith("Broker:")]:
        broker_data = broker_data[0]
        broker, _ = BrokerV2.objects.get_or_create(
            hemnet_id=int(broker_data["id"]),
            defaults={
                "name": broker_data.get("name", "") or "",
                "email": broker_data.get("email", "") or "",
                "phone": broker_data.get("phoneNumber", "") or "",
                "agency": broker_agency,
            }
        )
    else:
        broker = None

    # active_listing_data resolved via ROOT_QUERY listing ref

    if published_at := pydash.get(active_listing_data, "publishedAt"):
        published_at = datetime.fromtimestamp(float(published_at))
    else:
        published_at = datetime.now()

    if districts := pydash.get(active_listing_data, "districts"):
        district = pydash.get(apollo_state, f"{districts[0]['__ref']}.fullName") or ""
    else:
        district = ""

    if municipality := pydash.get(active_listing_data, "municipality"):
        municipality = pydash.get(apollo_state, f"{municipality['__ref']}.fullName") or ""
    else:
        municipality = ""

    if county := (pydash.get(active_listing_data, "region") or pydash.get(active_listing_data, "county")):
        county = pydash.get(apollo_state, f"{county['__ref']}.fullName") or ""
    else:
        county = ""

    listing_type = pydash.get(active_listing_data, "activePackage") or ""
    if not listing_type and active_listing_data.get("isProject"):
        listing_type = (
            pydash.get(active_listing_data, "labels[1].identifier")
            or pydash.get(active_listing_data, "labels[0].identifier")
            or "NEW_CONSTRUCTION_PROJECT"
        )

    fields = {
        "is_active": True,
        "removed": None,
        "hemnet_id": listing_id,
        "listed": published_at,
        "type": listing_type,
        "status": "",
        "title": pydash.get(active_listing_data, "title") or "",
        "street_address": pydash.get(active_listing_data, "streetAddress") or "",
        "district": district,
        "city": "",
        "municipality": municipality.replace(" kommun", ""),
        "county": county.replace(" län", ""),
        "postcode": pydash.get(active_listing_data, "postCode") or None,
        "price": parse_active_listing_price(active_listing_data),
        "currency": pydash.get(active_listing_data, "askingPrice.currency.code") or "SEK",
        "housing_form": pydash.get(active_listing_data, "housingForm.name") or "",
        "tenure": pydash.get(active_listing_data, "tenure.name") or "",
        "land_area": pydash.get(active_listing_data, "landArea") or None,
        "living_area": pydash.get(active_listing_data, "livingArea") or None,
        "rooms": pydash.get(active_listing_data, "numberOfRooms") or None,
        "amenities": ", ".join(
            [amenity["title"] for amenity in pydash.get(active_listing_data, "relevantAmenities") or []]
        ),
        "construction_year": pydash.get(active_listing_data, "legacyConstructionYear") or "",
        "water_distance": pydash.get(active_listing_data, "closestWaterDistanceMeters") or None,
        "coastline_distance": pydash.get(active_listing_data, "coastlineDistanceMeters") or None,
        "broker": broker,
        "broker_agency": broker_agency,
        "is_pre_market": is_pre_market,
        "images": len((active_listing_data.get("images({\"limit\":300})", {}) or {}).get("images", []) or []),
        "times_viewed": pydash.get(active_listing_data, "timesViewed") or 0,
        # "raw_data": data["raw_data"],
    }

    try:
        existing_listing = ListingV2.objects.filter(url=url).first()
        if existing_listing:
            unchanged = (
                existing_listing.is_active == fields["is_active"]
                and existing_listing.removed == fields["removed"]
                and existing_listing.hemnet_id == fields["hemnet_id"]
                and existing_listing.listed == fields["listed"]
                and existing_listing.type == fields["type"]
                and existing_listing.status == fields["status"]
                and existing_listing.title == fields["title"]
                and existing_listing.street_address == fields["street_address"]
                and existing_listing.district == fields["district"]
                and existing_listing.city == fields["city"]
                and existing_listing.municipality == fields["municipality"]
                and existing_listing.county == fields["county"]
                and existing_listing.postcode == fields["postcode"]
                and existing_listing.price == fields["price"]
                and existing_listing.currency == fields["currency"]
                and existing_listing.housing_form == fields["housing_form"]
                and existing_listing.tenure == fields["tenure"]
                and existing_listing.land_area == fields["land_area"]
                and existing_listing.living_area == fields["living_area"]
                and existing_listing.rooms == fields["rooms"]
                and existing_listing.amenities == fields["amenities"]
                and existing_listing.construction_year == fields["construction_year"]
                and existing_listing.water_distance == fields["water_distance"]
                and existing_listing.coastline_distance == fields["coastline_distance"]
                and existing_listing.broker_id == (broker.id if broker else None)
                and existing_listing.broker_agency_id == (broker_agency.id if broker_agency else None)
                and existing_listing.is_pre_market == fields["is_pre_market"]
                and existing_listing.images == fields["images"]
            )
            if not unchanged:
                ListingV2.objects.update_or_create(url=url, defaults=fields)
            else:
                logger.debug("No changes detected, skipping write [url=%s]", url)
        else:
            ListingV2.objects.update_or_create(url=url, defaults=fields)

        municipality_name = fields["municipality"]
        municipality_full_name = municipality
        MunicipalityV2.objects.get_or_create(name=municipality_name, full_name=municipality_full_name)
        if run_id:
            core_models.WebScraperRun.objects.filter(id=run_id).update(
                successful_records=models.F("successful_records") + 1
            )
    except Exception as ex:
        record_run_failure(str(ex))
        raise

    logger.info("Saved listing [url=%s]", url)


@app.task(
    bind=True,
    base=BaseTask,
    soft_time_limit=HEMNET_DETAIL_SOFT_TIME_LIMIT_SECONDS,
    time_limit=HEMNET_DETAIL_HARD_TIME_LIMIT_SECONDS,
)
def scrape_listing_2(  # pylint: disable=too-many-locals, too-many-branches, too-many-statements
    self,
    url: str,
    is_pre_market: bool = False,
    run_id: int | None = None,
):
    data = {"url": url}
    page_source = ""
    self.request.url = url

    if run_id and not is_hemnet_run_active(run_id):
        logger.info("skip scrape for non-active hemnet run [run_id=%s] [url=%s]", run_id, url)
        return

    logger.info("scrape listing [url=%s]", url)
    try:
        if run_id:
            core_models.WebScraperRun.objects.filter(id=run_id).update(
                total_api_requests=models.F("total_api_requests") + 1
            )
        status, page_source = fetch_via_webscraper(url)
        if status is None:
            raise RuntimeError(f"Failed to scrape listing [url={url}] [status=None]")
        if status >= 400:
            raise RuntimeError(f"Failed to scrape listing [url={url}] [status={status}]")

        root = lxml.html.fromstring(page_source)
        if raw_data := root.xpath("//script[@id='__NEXT_DATA__']"):
            data["raw_data"] = json.loads(raw_data[0].text)
        else:
            next_f_listing = extract_next_f_listing_data(page_source)
            if next_f_listing:
                save_listing_from_next_f(
                    url=url,
                    listing_data=next_f_listing,
                    is_pre_market=is_pre_market,
                    run_id=run_id,
                )
                return
            interstitial_reason = detect_interstitial_reason(page_source)
            if interstitial_reason:
                raise RuntimeError(
                    f"Missing __NEXT_DATA__ [url={url}] [{interstitial_reason}] [status={status}]"
                )
            raise RuntimeError(f"Missing __NEXT_DATA__ [url={url}] [status={status}]")

        save_listing_2(data, is_pre_market, run_id=run_id)
    except SoftTimeLimitExceeded as ex:
        reset_browser()
        ex = RuntimeError(
            f"Timed out scraping listing [url={url}] "
            f"[soft_limit={HEMNET_DETAIL_SOFT_TIME_LIMIT_SECONDS}s]"
        )
        if run_id:
            core_models.WebScraperRunResult.objects.create(
                run_id=run_id,
                url=url,
                status=core_models.WebScraperRunResult.STATUS_FAIL,
                error_message=str(ex),
                failed_html=clip_failed_html(page_source),
            )
            core_models.WebScraperRun.objects.filter(id=run_id).update(
                failed_records=models.F("failed_records") + 1
            )
        raise ex
    except Exception as ex:
        if "Timed out scraping listing" in str(ex):
            reset_browser()
        if run_id:
            core_models.WebScraperRunResult.objects.create(
                run_id=run_id,
                url=url,
                status=core_models.WebScraperRunResult.STATUS_FAIL,
                error_message=str(ex),
                failed_html=clip_failed_html(page_source),
            )
            core_models.WebScraperRun.objects.filter(id=run_id).update(
                failed_records=models.F("failed_records") + 1
            )
        raise
    finally:
        mark_hemnet_run_child_finished(run_id)


@app.task(bind=True, base=BaseTask)
def search_listings_2(self):
    active_run = (
        core_models.WebScraperRun.objects.filter(
            method=core_models.WebScraperRun.METHOD_PLAYWRIGHT,
            status=core_models.WebScraperRun.STATUS_ACTIVE,
        )
        .order_by("started_at")
        .first()
    )
    if active_run:
        if not HEMNET_INTERRUPT_PREVIOUS_RUN:
            logger.warning(
                "skipping hemnet search run because previous Playwright run is still active "
                "[run_id=%s] [started_at=%s]",
                active_run.id,
                active_run.started_at,
            )
            return
        logger.warning(
            "interrupting previous hemnet run before starting a new one "
            "[run_id=%s] [started_at=%s]",
            active_run.id,
            active_run.started_at,
        )
        interrupt_hemnet_run(active_run.id)
        removed = clear_hemnet_playwright_queue()
        logger.warning(
            "cleared playwright queue before new hemnet run [queue=%s] [removed=%s]",
            HEMNET_PLAYWRIGHT_QUEUE_NAME,
            removed,
        )

    run = core_models.WebScraperRun.objects.create(
        method=core_models.WebScraperRun.METHOD_PLAYWRIGHT
    )
    init_hemnet_run_tracking(run.id)

    def load_page(url: str) -> str:
        self.request.url = url
        page_source = ""
        for i in range(4):
            try:
                core_models.WebScraperRun.objects.filter(id=run.id).update(
                    total_api_requests=models.F("total_api_requests") + 1
                )
                status, page_source = fetch_via_webscraper(url)
                if status is None:
                    raise RuntimeError(f"failed to load page [url={url}] [status=None]")
                if status >= 200 and status < 300:
                    return page_source
                if status == 404:
                    return page_source
                raise RuntimeError(f"failed to load page [url={url}] [status={status}]")
            except Exception as ex:
                logger.exception("failed to load page [url=%s] - %s", url, ex)
                if i == 3:
                    core_models.WebScraperRunResult.objects.create(
                        run_id=run.id,
                        url=url,
                        status=core_models.WebScraperRunResult.STATUS_FAIL,
                        error_message=str(ex),
                        failed_html=clip_failed_html(page_source),
                    )
                    core_models.WebScraperRun.objects.filter(id=run.id).update(
                        failed_records=models.F("failed_records") + 1
                    )
                    raise ex

                timeout = (i + 1) * 10
                logger.info("going to sleep for %s seconds", timeout)
                time.sleep(timeout)

    def get_listings(el: lxml.html.HtmlElement):
        if item_list := el.xpath("//script[@id='__NEXT_DATA__']"):
            _data = json.loads(item_list[0].text)
            _apollo_state = _data["props"]["pageProps"]["__APOLLO_STATE__"]
            _root_query = _apollo_state["ROOT_QUERY"]
            for k, v in _root_query.items():
                if not k.startswith("searchForSaleListings"):
                    continue

                if "cards" in v:
                    return [_apollo_state[card["__ref"]] for card in v["cards"]]

        return []

    def get_pre_market_listings(el: lxml.html.HtmlElement):
        if item_list := el.xpath("//script[@id='__NEXT_DATA__']"):
            _data = json.loads(item_list[0].text)
            _apollo_state = _data["props"]["pageProps"]["__APOLLO_STATE__"]
            _root_query = _apollo_state["ROOT_QUERY"]
            for k, v in _root_query.items():
                if not k.startswith("searchUpcomingListings"):
                    continue

                if "cards" in v:
                    return [_apollo_state[card["__ref"]] for card in v["cards"]]

        return []


    try:
        existing_ids = set(ListingV2.objects.filter(is_active=True).values_list("hemnet_id", flat=True))
        logger.info("%s existing ids", len(existing_ids))

        # on-market

        page = 1
        base_search_url = "https://www.hemnet.se/bostader"
        for (min_list_price, max_list_price) in PRICE_RANGES:
            query_params = {}
            if min_list_price:
                query_params["price_min"] = min_list_price
            if max_list_price:
                query_params["price_max"] = max_list_price
            if page > 1:
                query_params["page"] = page
            search_url = f"{base_search_url}?{urlencode(query_params)}"

            while True:
                maybe_wait_for_playwright_queue_capacity()
                logger.info("search listing [url=%s]", search_url)
                page_source = load_page(search_url)
                run.total_pages += 1
                run.save(update_fields=("total_pages",))

                root = lxml.html.fromstring(page_source)
                listings = get_listings(root)
                listing_count = len(listings)
                logger.info("listings found [%s]", listing_count)

                if not listing_count:  # no more
                    break

                listing_ids = [int(listing["id"]) for listing in listings if listing.get("id")]
                existing_listings = {
                    listing.hemnet_id: {
                        "price": listing.price,
                        "type": listing.type,
                        "is_pre_market": listing.is_pre_market,
                        "images": listing.images,
                    }
                    for listing in ListingV2.objects.filter(hemnet_id__in=listing_ids).only(
                        "hemnet_id", "price", "type", "is_pre_market", "images"
                    )
                }

                task_signatures = []
                no_update_but_still_actives = []
                found_links = 0
                for listing in listings:
                    listing_id = int(listing["id"])
                    listing_slug = listing.get("slug", "")
                    listing_url = f"https://www.hemnet.se/bostad/{listing_slug}"
                    if listing_slug:
                        found_links += 1
                    if should_skip_existing_hemnet_listing(
                        listing,
                        existing_listings.get(listing_id),
                        is_pre_market=False,
                    ):
                        no_update_but_still_actives.append(listing_id)
                        existing_ids.discard(listing_id)
                        continue
                    if not acquire_hemnet_scrape_dedupe(listing_url):
                        logger.debug("duplicate scrape task suppressed [url=%s]", listing_url)
                        continue
                    task_signatures.append(
                        scrape_listing_2.s(
                            url=listing_url, is_pre_market=False, run_id=run.id
                        )
                    )
                    increment_hemnet_run_pending(run.id)
                    existing_ids.discard(listing_id)

                if no_update_but_still_actives:
                    ListingV2.objects.filter(hemnet_id__in=no_update_but_still_actives).update(
                        is_active=True,
                        removed=None,
                        is_pre_market=False,
                        updated=timezone.now(),
                    )

                if found_links:
                    core_models.WebScraperRun.objects.filter(id=run.id).update(
                        total_links=models.F("total_links") + found_links
                    )

                # scrape the listings in parallel
                # `get()` will block until all the tasks are finished
                group(task_signatures).apply_async()

                logger.info("%s existing ids", len(existing_ids))

                page += 1
                search_url = f"{base_search_url}?{urlencode(query_params)}&page={page}"

            page = 1  # reset page

        # pre-market

        page = 1
        base_search_url = "https://www.hemnet.se/kommande/bostader"
        for (min_list_price, max_list_price) in PRICE_RANGES:
            query_params = {}
            if min_list_price:
                query_params["price_min"] = min_list_price
            if max_list_price:
                query_params["price_max"] = max_list_price
            if page > 1:
                query_params["page"] = page
            search_url = f"{base_search_url}?{urlencode(query_params)}"

            while True:
                maybe_wait_for_playwright_queue_capacity()
                logger.info("search listing [url=%s]", search_url)
                page_source = load_page(search_url)
                run.total_pages += 1
                run.save(update_fields=("total_pages",))

                root = lxml.html.fromstring(page_source)
                listings = get_pre_market_listings(root)
                listing_count = len(listings)
                logger.info("listings found [%s]", listing_count)

                if not listing_count:  # no more
                    break

                listing_ids = [int(listing["id"]) for listing in listings if listing.get("id")]
                existing_listings = {
                    listing.hemnet_id: {
                        "price": listing.price,
                        "type": listing.type,
                        "is_pre_market": listing.is_pre_market,
                        "images": listing.images,
                    }
                    for listing in ListingV2.objects.filter(hemnet_id__in=listing_ids).only(
                        "hemnet_id", "price", "type", "is_pre_market", "images"
                    )
                }

                task_signatures = []
                no_update_but_still_actives = []
                found_links = 0
                for listing in listings:
                    listing_id = int(listing["id"])
                    listing_slug = listing.get("slug", "")
                    listing_url = f"https://www.hemnet.se/bostad/{listing_slug}"
                    if listing_slug:
                        found_links += 1
                    if should_skip_existing_hemnet_listing(
                        listing,
                        existing_listings.get(listing_id),
                        is_pre_market=True,
                    ):
                        no_update_but_still_actives.append(listing_id)
                        existing_ids.discard(listing_id)
                        continue
                    if not acquire_hemnet_scrape_dedupe(listing_url):
                        logger.debug("duplicate scrape task suppressed [url=%s]", listing_url)
                        continue
                    task_signatures.append(
                        scrape_listing_2.s(
                            url=listing_url, is_pre_market=True, run_id=run.id
                        )
                    )
                    increment_hemnet_run_pending(run.id)
                    existing_ids.discard(listing_id)

                if no_update_but_still_actives:
                    ListingV2.objects.filter(hemnet_id__in=no_update_but_still_actives).update(
                        is_active=True,
                        removed=None,
                        is_pre_market=True,
                        updated=timezone.now(),
                    )

                if found_links:
                    core_models.WebScraperRun.objects.filter(id=run.id).update(
                        total_links=models.F("total_links") + found_links
                    )

                # scrape the listings in parallel
                # `get()` will block until all the tasks are finished
                group(task_signatures).apply_async()

                logger.info("%s existing ids", len(existing_ids))

                page += 1
                search_url = f"{base_search_url}?{urlencode(query_params)}&page={page}"

            page = 1  # reset page

        # set remaining existing_ids as inactive
        if existing_ids:
            logger.info("making %s listings inactive", len(existing_ids))
            for listing in ListingV2.objects.filter(hemnet_id__in=existing_ids).iterator():
                listing.is_active = False
                listing.removed = timezone.now().date()
                listing.save()
    except Exception as ex:
        mark_hemnet_run_parent_done(
            run.id,
            failed=True,
            reason=f"{type(ex).__name__}: {ex}",
        )
        raise

    mark_hemnet_run_parent_done(run.id, failed=False)


@app.task(bind=True, base=BaseTask)
def __search_listings_2(self, url: str = None):
    def get_next_url(prev_count: int):
        parsed_url = urlparse(url)
        _search_params = dict(parse_qsl(parsed_url.query))

        # process the next page
        if prev_count:
            prev_page = int(_search_params.get("page", 1))
            _search_params.update({"page": prev_page + 1})
            return f"{BASE_URL}/bostader?{urlencode(_search_params)}"

        # process the next price bucket
        current_price_range = (int(_search_params.pop("price_min", 0)), int(_search_params.pop("price_max", 0)) or None)
        current_price_range_index = PRICE_RANGES.index(current_price_range)
        if current_price_range_index == len(PRICE_RANGES) - 1:
            return None  # where done

        price_min, price_max = PRICE_RANGES[current_price_range_index + 1]
        _search_params = dict(SEARCH_PARAMS)
        if price_min:
            _search_params["price_min"] = price_min
        if price_max:
            _search_params["price_max"] = price_max
        return f"{BASE_URL}/bostader?{urlencode(_search_params)}"

    def get_listings(el: lxml.html.HtmlElement):
        if item_list := el.xpath("//script[@id='__NEXT_DATA__']"):
            _data = json.loads(item_list[0].text)
            _apollo_state = _data["props"]["pageProps"]["__APOLLO_STATE__"]
            _root_query = _apollo_state["ROOT_QUERY"]
            for k, v in _root_query.items():
                if not k.startswith("searchForSaleListings"):
                    continue

                if "cards" in v:
                    return [_apollo_state[card["__ref"]] for card in v["cards"]]

        return []

    if not url:  # the start of a crawling process
        price_min, price_max = PRICE_RANGES[0]
        search_params = dict(SEARCH_PARAMS)
        if price_min:
            search_params["price_min"] = price_min
        if price_max:
            search_params["price_max"] = price_max
        url = f"{BASE_URL}/bostader?{urlencode(search_params)}"

    self.request.url = url
    logger.info("search listings [url=%s]", url)
    status, page_source = fetch_via_webscraper(url)

    if status == 404:
        logger.debug("404 - not found [url=%s]", url)
        if next_url := get_next_url(0):
            search_listings_2.delay(url=next_url)
    else:
        if status >= 400:
            raise RuntimeError("Failed to search listing [url=%s] [status=%s]", url, status)

        root = lxml.html.fromstring(page_source)
        listings = get_listings(root)
        listing_count = len(listings)
        logger.info("listings found [%s]", listing_count)

        listing_ids = [listing["id"] for listing in listings]
        existing_listings = {
            listing.hemnet_id: {
                "price": listing.price,
                "type": listing.type,
                "is_pre_market": listing.is_pre_market,
                "images": listing.images,
                "times_viewed": listing.times_viewed,
            }
            for listing in ListingV2.objects.filter(hemnet_id__in=listing_ids).only(
                "hemnet_id",
                "price",
                "type",
                "is_pre_market",
                "images",
                "times_viewed",
            )
        }
        logger.info("existing_listings - %s", existing_listings.keys())

        no_update_but_still_actives = []
        for listing in listings:
            # if (listing_id := int(listing["id"])) in existing_listings:
            #     listing_price = int(
            #         listing.get("askingPrice", "0").replace("kr", "").replace(" ", "").replace("\xa0", "")
            #     )
            #     listing_type = listing.get("activePackage", "")
            #     listing_images = len((listing.get("images({\"limit\":300})", {}) or {}).get("images", []) or [])
            #     listing_times_viewed = listing.get("timesViewed", 0)
            #
            #     logger.info(
            #         "[listing_id=%s]"
            #         " [current_price=%s] [old_price=%s]"
            #         " [current_type=%s] [old_type=%s]"
            #         " [current_is_pre_market=False] [old_is_pre_market=%s]"
            #         " [current_images=%s] [old_images=%s]"
            #         " [current_times_viewed=%s] [old_times_viewed=%s]",
            #         listing_id,
            #         listing_price,
            #         existing_listings[listing_id]["price"],
            #         listing_type,
            #         existing_listings[listing_id]["type"],
            #         existing_listings[listing_id]["is_pre_market"],
            #         listing_images,
            #         existing_listings[listing_id]["images"],
            #         listing_times_viewed,
            #         existing_listings[listing_id]["times_viewed"],
            #     )
            #
            #     if (
            #         listing_price == existing_listings[listing_id]["price"]
            #         and listing_type == existing_listings[listing_id]["type"]
            #         and not existing_listings[listing_id]["is_pre_market"]
            #         and listing_images == existing_listings[listing_id]["images"]
            #         and listing_times_viewed == existing_listings[listing_id]["times_viewed"]
            #     ):  # no change in price nor package type, skip it
            #         logger.info("no change detected for [hemnet_id=%s] - skip it", listing_id)
            #         no_update_but_still_actives.append(listing_id)
            #         continue

            listing_url = f"https://www.hemnet.se/bostad/{listing.get('slug', '')}"
            scrape_listing_2.delay(listing_url)

        # make sure listings that are not updated but still active is mark as such
        # ListingV2.objects.filter(hemnet_id__in=no_update_but_still_actives).update(
        #     is_active=True,
        #     removed=None,
        #     is_pre_market=False,
        #     updated=timezone.now(),
        # )

        # get next url
        if next_url := get_next_url(listing_count):
            search_listings_2.delay(url=next_url)


@app.task(
    bind=True,
    base=BaseTask,
    autoretry_for=(Exception,),
    retry_backoff=5,
    retry_jitter=True,
    retry_kwargs={"max_retries": 5},
)
def search_pre_market_listings_2(self, url: str = None):
    def get_next_url(prev_count: int):
        parsed_url = urlparse(url)
        _search_params = dict(parse_qsl(parsed_url.query))

        # process the next page
        if prev_count:
            prev_page = int(_search_params.get("page", 1))
            _search_params.update({"page": prev_page + 1})
            return f"{BASE_URL}/kommande/bostader?{urlencode(_search_params)}"

        # process the next price bucket
        current_price_range = (int(_search_params.pop("price_min", 0)), int(_search_params.pop("price_max", 0)) or None)
        current_price_range_index = PRICE_RANGES.index(current_price_range)
        if current_price_range_index == len(PRICE_RANGES) - 1:
            return None  # where done

        price_min, price_max = PRICE_RANGES[current_price_range_index + 1]
        _search_params = dict(SEARCH_PARAMS)
        if price_min:
            _search_params["price_min"] = price_min
        if price_max:
            _search_params["price_max"] = price_max
        return f"{BASE_URL}/kommande/bostader?{urlencode(_search_params)}"

    def get_listings(el: lxml.html.HtmlElement):
        if item_list := el.xpath("//script[@id='__NEXT_DATA__']"):
            _data = json.loads(item_list[0].text)
            _apollo_state = _data["props"]["pageProps"]["__APOLLO_STATE__"]
            _root_query = _apollo_state["ROOT_QUERY"]
            for k, v in _root_query.items():
                if not k.startswith("searchUpcomingListings"):
                    continue

                if "cards" in v:
                    return [_apollo_state[card["__ref"]] for card in v["cards"]]

        return []

    if not url:  # the start of a crawling process
        price_min, price_max = PRICE_RANGES[0]
        search_params = dict(SEARCH_PARAMS)
        if price_min:
            search_params["price_min"] = price_min
        if price_max:
            search_params["price_max"] = price_max
        url = f"{BASE_URL}/kommande/bostader?{urlencode(search_params)}"

    self.request.url = url
    logger.info("search listings [url=%s]", url)
    status, page_source = fetch_via_webscraper(url)

    if status == 404:
        logger.debug("404 - not found [url=%s]", url)
        if next_url := get_next_url(0):
            search_pre_market_listings_2.delay(url=next_url)
    else:
        if status >= 400:
            raise RuntimeError("Failed to search listing [url=%s] [status=%s]", url, status)

        root = lxml.html.fromstring(page_source)
        listings = get_listings(root)
        listing_count = len(listings)
        logger.info("listings found [%s]", listing_count)

        listing_ids = [listing["id"] for listing in listings]
        existing_listings = {
            listing.hemnet_id: {
                "price": listing.price,
                "type": listing.type,
                "is_pre_market": listing.is_pre_market,
                "images": listing.images,
                "times_viewed": listing.times_viewed,
            }
            for listing in ListingV2.objects.filter(hemnet_id__in=listing_ids).only(
                "hemnet_id",
                "price",
                "type",
                "is_pre_market",
                "images",
                "times_viewed",
            )
        }
        logger.info("existing_listings - %s", existing_listings.keys())

        no_update_but_still_actives = []
        for listing in listings:
            # if (listing_id := int(listing["id"])) in existing_listings:
            #     listing_price = int(
            #         listing.get("askingPrice", "0").replace("kr", "").replace(" ", "").replace("\xa0", "")
            #     )
            #     listing_type = listing.get("activePackage", "")
            #     listing_images = len((listing.get("images({\"limit\":300})", {}) or {}).get("images", []) or [])
            #     listing_times_viewed = listing.get("timesViewed", 0)
            #
            #     logger.info(
            #         "[listing_id=%s]"
            #         " [current_price=%s] [old_price=%s]"
            #         " [current_type=%s] [old_type=%s]"
            #         " [current_is_pre_market=True] [old_is_pre_market=%s]"
            #         " [current_images=%s] [old_images=%s]"
            #         " [current_times_viewed=%s] [old_times_viewed=%s]",
            #         listing_id,
            #         listing_price,
            #         existing_listings[listing_id]["price"],
            #         listing_type,
            #         existing_listings[listing_id]["type"],
            #         existing_listings[listing_id]["is_pre_market"],
            #         listing_images,
            #         existing_listings[listing_id]["images"],
            #         listing_times_viewed,
            #         existing_listings[listing_id]["times_viewed"],
            #     )

                # if (
                #         listing_price == existing_listings[listing_id]["price"]
                #         and listing_type == existing_listings[listing_id]["type"]
                #         and existing_listings[listing_id]["is_pre_market"]
                #         and listing_images == existing_listings[listing_id]["images"]
                #         and listing_times_viewed == existing_listings[listing_id]["times_viewed"]
                # ):  # no change in price nor package type, skip it
                #     logger.info("no change detected for [hemnet_id=%s] - skip it", listing_id)
                #     no_update_but_still_actives.append(listing_id)
                #     continue

            listing_url = f"https://www.hemnet.se/bostad/{listing.get('slug', '')}"
            scrape_listing_2.delay(listing_url, is_pre_market=True)

        # make sure listings that are not updated but still active is mark as such
        # ListingV2.objects.filter(hemnet_id__in=no_update_but_still_actives).update(
        #     is_active=True,
        #     removed=None,
        #     is_pre_market=True,
        #     updated=timezone.now(),
        # )

        # get next url
        if next_url := get_next_url(listing_count):
            search_pre_market_listings_2.delay(url=next_url)


@app.task(bind=True, base=BaseTask)
def mark_listings_inactive(self):
    del self

    threshold = timezone.now() - timedelta(hours=24)
    ListingV2.objects.filter(models.Q(updated__isnull=True) | models.Q(updated__lt=threshold)).update(
        is_active=False,
        removed=timezone.now(),
    )


# adcost_steel.OFFER_SLUGS, duplicated rather than imported: that module imports
# playwright at call time and is meant to run OUTSIDE this eventlet worker.
# 60 grid cells x 7 offers = 420 rows in a complete run.
ADCOST_OFFERS_PER_CELL = 7
# Below this share of the expected rows the week is degraded, not merely short.
ADCOST_MIN_COMPLETENESS = 0.95


@app.task(
    bind=True,
    base=BaseTask,
    autoretry_for=(Exception,),
    # Was retry_backoff=5/max_retries=5. On 2026-07-19 that re-ran the whole
    # task six times inside 37 minutes, opening 30 fresh residential Steel
    # sessions against what is plainly an IP-reputation block — the opposite of
    # backing off. The block is time-varying, so wait in tens of minutes.
    retry_backoff=900,
    retry_backoff_max=1800,
    retry_jitter=True,
    # HISTORY (superseded below): max_retries was 0 while the transport was broken.
    # 2026-08-14 showed Cloudflare 403-ing POST /graphql after ~1 call per
    # session, so retrying only burns Steel sessions and adds pressure for an
    # outcome we can already predict. Raise this to 2 once a transport that
    # actually completes the grid is in place.
    # 2026-08-17: raised 0 -> 2. The comment above said to do this "once a
    # transport that actually completes the grid is in place" — Bright Data
    # Web Unlocker now does (420/420 cells, 0 failures, verified live).
    retry_kwargs={"max_retries": 2},
)
def search_ad_cost_2(self):
    del self

    # Build the (municipality, asking-price) grid from the DB price points.
    price_points = list(AdCostPricePointV2.objects.all())
    grid = [
        {
            "name": pp.property_municipality.name,
            "full_name": pp.property_municipality.full_name,
            "price": pp.property_price,
        }
        for pp in price_points
    ]

    # The ad-cost GraphQL operation changed (SellerMarketingProductPrices was
    # removed from Hemnet's schema; the current op is webPricingCalculator) AND
    # the droplet DC IP is Cloudflare-blocked. Egress now runs through a Steel
    # residential browser via a quiet in-page fetch. Playwright is incompatible
    # with this worker's eventlet loop, so the crawl runs in a standalone
    # subprocess (a plain Python interpreter). The residential browser runs
    # OFF-box at Steel. See apps/hemnet/adcost_steel.py and 27-GRAPHQL-CONTRACT.md.
    import subprocess
    import sys

    crawler = os.path.join(os.path.dirname(__file__), "adcost_steel.py")
    proc = subprocess.run(
        [sys.executable, crawler],
        input=json.dumps(grid),
        capture_output=True,
        text=True,
        # ⚠ THIS VALUE IS LOAD-BEARING. On TimeoutExpired subprocess.run kills
        # the child and DISCARDS ITS STDOUT, so overrunning loses the ENTIRE
        # harvest, not the tail — and on a monthly job with no backfill that is
        # a permanent hole. The crawler derives its own TIME_BUDGET from
        # ADCOST_SUBPROCESS_TIMEOUT below, so the two can never drift apart.
        # Sized 2026-08-17 from a measured ~21s/cell over 60 cells (~1,300s)
        # plus headroom for a slower month and one worst-case cell.
        timeout=2700,
        env={**os.environ, "ADCOST_SUBPROCESS_TIMEOUT": "2700"},
    )
    # ALWAYS log the crawler's stderr, not only on rc != 0. Every degraded run
    # so far exited 0, so its "price fetch failed ..." lines were captured here
    # and thrown away unread — which is the only reason the 2026-08 failures had
    # to be diagnosed from timing instead of from a traceback.
    if proc.stderr:
        logger.info("search_ad_cost_2 crawler stderr [%s]", proc.stderr[-8000:])
    if proc.returncode != 0:
        logger.error(
            "search_ad_cost_2 crawl failed [rc=%s stderr=%s]",
            proc.returncode,
            (proc.stderr or "")[-2000:],
        )
        raise RuntimeError("adcost steel crawl failed rc=%s" % proc.returncode)

    payload = json.loads(proc.stdout or "{}")
    if isinstance(payload, list):  # pre-2026-08-14 crawler contract
        rows, stats = payload, {}
    else:
        rows, stats = payload.get("rows") or [], payload.get("stats") or {}

    expected = stats.get("expected_rows") or len(grid) * ADCOST_OFFERS_PER_CELL
    logger.info(
        "search_ad_cost_2 crawled [rows=%s/%s cells=%s/%s reclears=%s aborted=%s]",
        len(rows), expected, stats.get("cells_ok"), stats.get("cells_total"),
        stats.get("reclears"), stats.get("aborted"),
    )

    municipality_by_full_name = {
        pp.property_municipality.full_name: pp.property_municipality
        for pp in price_points
    }

    # Idempotent write, keyed on (municipality, price, ad_type) within the crawl
    # day. AdCostV2 has no uniqueness constraint and the write loop runs after
    # the crawl, so a retry — now much more likely, since an incomplete grid
    # raises below — would otherwise duplicate every row it already wrote.
    today = timezone.now().date()
    existing = {
        (o.property_municipality_id, o.property_price, o.ad_type): o
        for o in AdCostV2.objects.filter(crawled__date=today)
    }

    created = 0
    updated = 0
    for row in rows:
        municipality = municipality_by_full_name.get(row["full_name"])
        if municipality is None:
            continue
        # ad_price is a PositiveIntegerField; the amounts are whole kronor
        # (amountInCents / 100). Round defensively to satisfy the column type.
        ad_price = int(round(row["ad_price"]))
        key = (municipality.id, row["price"], row["ad_type"])
        obj = existing.get(key)
        if obj is not None:
            if obj.ad_price != ad_price:
                obj.ad_price = ad_price
                obj.save(update_fields=["ad_price"])
                updated += 1
            continue
        existing[key] = AdCostV2.objects.create(
            property_municipality=municipality,
            property_price=row["price"],
            ad_type=row["ad_type"],
            ad_price=ad_price,
            valid_until=None,
        )
        created += 1
    logger.info("search_ad_cost_2 wrote [created=%s updated=%s]", created, updated)

    # Completeness gate. Rows are written first so a partial week is never
    # thrown away, but the task must NOT report success on one: downstream
    # reporting cannot otherwise tell a 35-row week from a 420-row week.
    if not rows:
        raise RuntimeError(
            "adcost crawl returned no rows (expected %s)" % expected
        )
    if len(rows) < expected * ADCOST_MIN_COMPLETENESS:
        raise RuntimeError(
            "adcost crawl incomplete: %s/%s rows (%.1f%%) from %s/%s cells, "
            "%s session rebuild(s), aborted=%s — rows written, week is degraded"
            % (len(rows), expected, 100.0 * len(rows) / expected,
               stats.get("cells_ok"), stats.get("cells_total"),
               stats.get("reclears"), stats.get("aborted"))
        )
