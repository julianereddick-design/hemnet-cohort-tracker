#!/usr/bin/env python3
"""adcost-extract-baseline.py — one-off: extract the ARPL listing-mix baseline
from Julian's v6 model (data/Hemnet ARPL Calcs_v6.xlsx, sheet Listings_New) into
a small committed JSON: county -> tier -> price_band -> listing_count.

This is the weighting base for the weighted ARPL (reuse-v6 decision, 2026-07-01).
Only the 8 priced counties and the 4 core tiers (BASIC/PLUS/PREMIUM/MAX) are kept.
Price bands = the AdCostV2 price points [2M,5M,7.5M,10M,15M,20M]; a listing's band
is the smallest point >= its asking price (matching the v6 Pricing SUMIFS bands),
capped at 20M.
"""
import json
import os

import openpyxl

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(REPO, "data", "Hemnet ARPL Calcs_v6.xlsx")
OUT = os.path.join(REPO, "data", "arpl-baseline.json")

PRICE_POINTS = [2000000, 5000000, 7500000, 10000000, 15000000, 20000000]
CORE_TIERS = {"BASIC", "PLUS", "PREMIUM", "MAX"}
# The 8 counties that have scraped pricing (from the 10 scraped munis).
PRICED_COUNTIES = {
    "Gävleborgs", "Hallands", "Jämtlands", "Skåne",
    "Stockholms", "Uppsala", "Västra Götalands", "Östergötlands",
}


def band_for(price):
    if price is None:
        return None
    for p in PRICE_POINTS:
        if price <= p:
            return p
    return PRICE_POINTS[-1]  # cap >20M at the 20M band


def main():
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb["Listings_New"]
    # header row -> column index
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = {str(h).strip(): i for i, h in enumerate(header) if h}
    ci_type = idx.get("Type")
    ci_county = idx.get("County")
    ci_price = idx.get("Price")
    assert None not in (ci_type, ci_county, ci_price), f"missing cols in {list(idx)}"

    counts = {}
    total = kept = 0
    skipped_county = set()
    for r in rows:
        total += 1
        tier = r[ci_type]
        county = r[ci_county]
        price = r[ci_price]
        if tier not in CORE_TIERS:
            continue
        if county not in PRICED_COUNTIES:
            if county:
                skipped_county.add(county)
            continue
        b = band_for(price)
        if b is None:
            continue
        counts.setdefault(county, {}).setdefault(tier, {})
        counts[county][tier][b] = counts[county][tier].get(b, 0) + 1
        kept += 1

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(counts, f, ensure_ascii=False, indent=1)

    print(f"listings scanned={total} kept(priced county+core tier)={kept}")
    print(f"counties={sorted(counts)}")
    # per-county totals
    for c in sorted(counts):
        tot = sum(sum(bands.values()) for bands in counts[c].values())
        print(f"  {c:20s} listings={tot}")
    print(f"skipped non-priced counties (sample): {sorted(skipped_county)[:12]}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
