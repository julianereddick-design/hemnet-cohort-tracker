#!/usr/bin/env python3
"""adcost-report.py — Phase 28 ad-cost reporting (rerunnable).

Pulls the full AdCostV2 history from the shared defaultdb and produces:
  1. exports/adcost-all-data.xlsx  — every snapshot x muni x tier x price point
     (muni-level detail, color-scaled) so price change is visible at a glance.
  2. exports/adcost-heatmap.html   — 8-county x {Bas,Plus,Premium,Max} heat map of
     % change WoW and vs end-2025, plus the weighted ARPL block.

Pricing basis: PAY_WHEN_LISTING_IS_REMOVED (matches the historical series).
County rollup + ARPL weights use the v6 listing mix in data/arpl-baseline.json
(county x tier x price-band listing counts). See docs/ad-cost-scrape-gap.md for the
2026-03-16 -> 2026-06-30 no-backfill gap.
"""
import datetime
import json
import os
import re

import openpyxl
from openpyxl.formatting.rule import ColorScaleRule
from openpyxl.styles import Alignment, Font, PatternFill
import psycopg

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "exports")
BASELINE = os.path.join(REPO, "data", "arpl-baseline.json")

CORE_TIERS = ["BASIC", "PLUS", "PREMIUM", "MAX"]
ALL_TIERS = ["BASIC", "PLUS", "PREMIUM", "MAX",
             "PAID_REPUBLISH", "TOPLISTING", "TOPLISTING_5_DAYS"]
PRICE_POINTS = [2000000, 5000000, 7500000, 10000000, 15000000, 20000000]
MOMS = 1.25  # Swedish VAT. webPricingCalculator amounts are NET (ex-VAT); the v6
             # Output reports GROSS (inc-moms). net × MOMS ≈ v6 reported figures.

# 10 scraped munis (id -> (name, county)); county strings match arpl-baseline.json.
MUNI = {
    164: ("Göteborgs", "Västra Götalands"),
    117: ("Krokoms", "Jämtlands"),
    217: ("Lunds", "Skåne"),
    88:  ("Malmö", "Skåne"),
    68:  ("Sandvikens", "Gävleborgs"),
    193: ("Stockholms", "Stockholms"),
    104: ("Uppsala", "Uppsala"),
    266: ("Vadstena", "Östergötlands"),
    282: ("Varbergs", "Hallands"),
    222: ("Ydre", "Östergötlands"),
}
COUNTIES = ["Gävleborgs", "Hallands", "Jämtlands", "Skåne",
            "Stockholms", "Uppsala", "Västra Götalands", "Östergötlands"]
WOW_MAX_GAP_DAYS = 12  # if the prior snapshot is older than this, WoW is n/a (gap)


def load_env():
    env = {}
    for line in open(os.path.join(REPO, ".env"), encoding="utf-8"):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        m = re.match(r"([A-Z_]+)=(.*)", line)
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def fetch_rows(env):
    conn = psycopg.connect(host=env["DB_HOST"], port=env.get("DB_PORT", 5432),
                           user=env["DB_USER"], password=env["DB_PASSWORD"],
                           dbname=env["DB_NAME"], sslmode="require", connect_timeout=15)
    cur = conn.cursor()
    cur.execute("""select property_municipality_id, property_price, ad_type, ad_price,
                          (crawled at time zone 'UTC')::date
                   from hemnet_adcostv2
                   where property_municipality_id = any(%s)
                     and property_price = any(%s)
                   order by 5""", (list(MUNI), PRICE_POINTS))
    rows = cur.fetchall()
    conn.close()
    return rows


def build_cube(rows):
    """-> data[date][muni_id][tier][price] = ad_price ; and sorted snapshot dates."""
    data = {}
    for muni_id, price, tier, ad_price, d in rows:
        data.setdefault(d, {}).setdefault(muni_id, {}).setdefault(tier, {})[price] = ad_price
    return data, sorted(data)


def county_price(data_date, county, tier, price):
    """Average the ad_price across the munis of `county` for (tier, price) on a date."""
    vals = [data_date[mid][tier][price]
            for mid, (_, c) in MUNI.items()
            if c == county and mid in data_date
            and tier in data_date[mid] and price in data_date[mid][tier]]
    return sum(vals) / len(vals) if vals else None


def weighted_price(data_date, baseline, county, tier):
    """Baseline-weighted price for (county, tier) over available price-bands."""
    num = den = 0.0
    bands = baseline.get(county, {}).get(tier, {})
    for band_str, cnt in bands.items():
        p = county_price(data_date, county, tier, int(band_str))
        if p is not None:
            num += cnt * p
            den += cnt
    return (num / den) if den else None


def arpl(data_date, baseline, tiers):
    """Weighted ARPL over all counties x given tiers x bands. -> (blended, per_tier)."""
    per_tier = {}
    tnum = tden = 0.0
    for tier in tiers:
        num = den = 0.0
        for county in COUNTIES:
            for band_str, cnt in baseline.get(county, {}).get(tier, {}).items():
                p = county_price(data_date, county, tier, int(band_str))
                if p is not None:
                    num += cnt * p
                    den += cnt
        per_tier[tier] = (num / den) if den else None
        tnum += num
        tden += den
    return (tnum / tden if tden else None), per_tier


def pct(latest, ref):
    if latest is None or ref is None or ref == 0:
        return None
    return latest / ref - 1.0


# ---------------------------------------------------------------------------
# Excel: all data points
# ---------------------------------------------------------------------------
def write_excel(data, dates, path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "AllData"
    bold = Font(bold=True)
    header = ["County", "Municipality", "Tier", "Price point"] + [d.isoformat() for d in dates]
    ws.append(header)
    for c in ws[1]:
        c.font = bold
        c.alignment = Alignment(horizontal="center")
    ws.freeze_panes = "E2"
    for mid, (name, county) in sorted(MUNI.items(), key=lambda kv: (kv[1][1], kv[1][0])):
        for tier in ALL_TIERS:
            for price in PRICE_POINTS:
                row = [county, name, tier, price]
                for d in dates:
                    v = data.get(d, {}).get(mid, {}).get(tier, {}).get(price)
                    row.append(v)
                ws.append(row)
    # color scale across the value columns for visual change
    first_col = openpyxl.utils.get_column_letter(5)
    last_col = openpyxl.utils.get_column_letter(4 + len(dates))
    rng = f"{first_col}2:{last_col}{ws.max_row}"
    ws.conditional_formatting.add(rng, ColorScaleRule(
        start_type="min", start_color="63BE7B",
        mid_type="percentile", mid_value=50, mid_color="FFEB84",
        end_type="max", end_color="F8696B"))
    for col in range(1, 5):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 16
    wb.save(path)


# ---------------------------------------------------------------------------
# HTML heat map + ARPL
# ---------------------------------------------------------------------------
def cell_color(p):
    if p is None:
        return "#f2f2f2", "#999", "n/a"
    # diverging: red = price up, blue = price down; intensity by magnitude (cap 10%)
    mag = min(abs(p) / 0.10, 1.0)
    if p >= 0:
        bg = f"rgb(255,{int(255 - 120 * mag)},{int(255 - 120 * mag)})"
    else:
        bg = f"rgb({int(255 - 120 * mag)},{int(255 - 120 * mag)},255)"
    return bg, "#111", f"{p*100:+.1f}%"


def heat_table(title, subtitle, data_latest, data_ref, baseline):
    rows = []
    for county in COUNTIES:
        tds = [f"<th class='rowh'>{county}</th>"]
        for tier in CORE_TIERS:
            lp = weighted_price(data_latest, baseline, county, tier)
            rp = weighted_price(data_ref, baseline, county, tier) if data_ref else None
            bg, fg, txt = cell_color(pct(lp, rp))
            tip = f"{county} {tier}: {rp:.0f} → {lp:.0f} kr" if (lp and rp) else "n/a"
            tds.append(f"<td style='background:{bg};color:{fg}' title='{tip}'>{txt}</td>")
        rows.append("<tr>" + "".join(tds) + "</tr>")
    head = "<th></th>" + "".join(f"<th>{t.title()}</th>" for t in CORE_TIERS)
    return (f"<h2>{title}</h2><p class='sub'>{subtitle}</p>"
            f"<table class='heat'><tr>{head}</tr>{''.join(rows)}</table>")


def arpl_block(latest_date, data_latest, end2025_date, data_end, baseline):
    bl, pt_l = arpl(data_latest, baseline, CORE_TIERS)
    be, pt_e = arpl(data_end, baseline, CORE_TIERS) if data_end else (None, {})
    rows = []
    for tier in CORE_TIERS + ["BLENDED"]:
        if tier == "BLENDED":
            lv, ev = bl, be
        else:
            lv, ev = pt_l.get(tier), pt_e.get(tier)
        chg = pct(lv, ev)
        _, _, ctxt = cell_color(chg)
        gross = (lv * MOMS) if lv else None
        rows.append(
            f"<tr><td class='rowh'>{tier.title()}</td>"
            f"<td>{('%.0f'%lv) if lv else 'n/a'}</td>"
            f"<td><b>{('%.0f'%gross) if gross else 'n/a'}</b></td>"
            f"<td>{('%.0f'%ev) if ev else 'n/a'}</td>"
            f"<td>{ctxt}</td></tr>")
    return (f"<h2>Weighted ARPL (SEK / listing)</h2>"
            f"<p class='sub'>Weighted by the v6 listing mix (county × tier × price-band, "
            f"n={sum(sum(b.values()) for c in baseline.values() for b in c.values()):,} listings). "
            f"Blended = across Bas/Plus/Premium/Max. 'net' = ex-VAT (as scraped); "
            f"'inc-moms' = ×1.25 to match the v6 gross reporting.</p>"
            f"<table class='arpl'><tr><th>Tier</th><th>Latest net ({latest_date})</th>"
            f"<th>Latest inc-moms</th><th>End-2025 net ({end2025_date})</th><th>Δ net</th></tr>"
            f"{''.join(rows)}</table>")


def write_html(latest_date, prior_date, end2025_date, data, baseline, path, wow_ok):
    dl = data[latest_date]
    de = data.get(end2025_date)
    dp = data.get(prior_date)
    wow_sub = (f"latest {latest_date} vs prior snapshot {prior_date}"
               if wow_ok else
               f"n/a — only one post-resume snapshot ({latest_date}); prior weekly run "
               f"was {prior_date} (across the Mar-16→Jun-30 gap). Valid once two adjacent "
               f"post-resume weeks exist.")
    parts = [
        "<!doctype html><meta charset='utf-8'><title>Hemnet ad-cost heat map</title>",
        "<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:28px;color:#111}"
        "h1{margin:0 0 4px} .meta{color:#666;font-size:13px;margin-bottom:20px}"
        "h2{margin:26px 0 2px;font-size:17px} .sub{color:#777;font-size:12px;margin:0 0 8px}"
        "table{border-collapse:collapse;margin-bottom:8px} "
        ".heat td,.heat th{border:1px solid #e2e2e2;padding:7px 12px;text-align:center;font-size:13px;min-width:74px}"
        ".heat th{background:#fafafa} .rowh{background:#fafafa!important;text-align:left!important;font-weight:600}"
        ".arpl td,.arpl th{border:1px solid #e2e2e2;padding:6px 14px;text-align:right;font-size:13px}"
        ".arpl th{background:#fafafa} .legend{font-size:12px;color:#666;margin-top:6px}"
        "</style>",
        "<h1>Hemnet ad-cost — county heat map & ARPL</h1>",
        f"<div class='meta'>Basis: pay-when-removed price · pulled from AdCostV2 · "
        f"latest snapshot <b>{latest_date}</b> · end-2025 anchor <b>{end2025_date}</b>. "
        f"Rows = the 8 priced counties; cols = ad package tier. "
        f"Cell = % change in the baseline-weighted price. "
        f"<span style='color:#c0392b'>red = cost up</span>, "
        f"<span style='color:#2c6fbf'>blue = cost down</span>.</div>",
        heat_table("% change vs end of 2025",
                   f"latest {latest_date} vs {end2025_date}", dl, de, baseline),
        heat_table("% change week-over-week", wow_sub, dl, dp if wow_ok else None, baseline),
        arpl_block(latest_date, dl, end2025_date, de, baseline),
        "<p class='legend'>Gap 2026-03-16 → 2026-06-30 has no data (Hemnet prices are "
        "current-only; no backfill). WoW resumes once two adjacent post-resume weeks exist.</p>",
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    baseline = json.load(open(BASELINE, encoding="utf-8"))
    env = load_env()
    rows = fetch_rows(env)
    data, dates = build_cube(rows)
    if not dates:
        raise SystemExit("no AdCostV2 rows found")

    latest = dates[-1]
    prior = dates[-2] if len(dates) > 1 else None
    wow_ok = bool(prior and (latest - prior).days <= WOW_MAX_GAP_DAYS)
    end2025 = max((d for d in dates if d.year == 2025), default=None)

    xlsx = os.path.join(OUT_DIR, "adcost-all-data.xlsx")
    html = os.path.join(OUT_DIR, "adcost-heatmap.html")
    write_excel(data, dates, xlsx)
    write_html(latest, prior, end2025, data, baseline, html, wow_ok)

    print(f"snapshots={len(dates)}  first={dates[0]}  latest={latest}")
    print(f"prior={prior}  WoW_valid={wow_ok}  end2025_anchor={end2025}")
    bl, pt = arpl(data[latest], baseline, CORE_TIERS)
    print("ARPL latest per tier:", {k: (round(v) if v else None) for k, v in pt.items()})
    print("ARPL latest blended:", round(bl) if bl else None)
    print(f"wrote {xlsx}")
    print(f"wrote {html}")


if __name__ == "__main__":
    main()
