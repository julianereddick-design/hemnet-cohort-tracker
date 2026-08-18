#!/usr/bin/env python3
"""adcost_grid.py — the ONE definition of the ad-cost scrape grid.

Before 2026-08-18 this existed twice: as rows in hemnet_adcostpricepointv2
(edited through the Django admin) and as MUNI/PRICE_POINTS hardcoded in
scripts/adcost-report.py. Nothing checked they agreed. Destroying the Django box
removes the admin UI, so the grid moves into the repo where it is reviewed and
versioned, and assert_matches_db() catches drift against the legacy table.

full_name is required: webAutocompleteLocations is queried by "<name> kommun",
not by the short name.
"""

# id -> (name, full_name, county). ids are hemnet_municipalityv2.id and are the
# FK written into hemnet_adcostv2.property_municipality_id.
MUNI = {
    68:  ("Sandvikens", "Sandvikens kommun", "Gävleborgs"),
    88:  ("Malmö", "Malmö kommun", "Skåne"),
    104: ("Uppsala", "Uppsala kommun", "Uppsala"),
    117: ("Krokoms", "Krokoms kommun", "Jämtlands"),
    164: ("Göteborgs", "Göteborgs kommun", "Västra Götalands"),
    193: ("Stockholms", "Stockholms kommun", "Stockholms"),
    217: ("Lunds", "Lunds kommun", "Skåne"),
    222: ("Ydre", "Ydre kommun", "Östergötlands"),
    266: ("Vadstena", "Vadstena kommun", "Östergötlands"),
    282: ("Varbergs", "Varbergs kommun", "Hallands"),
}

PRICE_POINTS = [2000000, 5000000, 7500000, 10000000, 15000000, 20000000]

# BASIC, PLUS, PREMIUM, MAX, PAID_REPUBLISH, TOPLISTING, TOPLISTING_5_DAYS
OFFERS_PER_CELL = 7

EXPECTED_CELLS = len(MUNI) * len(PRICE_POINTS) * OFFERS_PER_CELL   # 420

COUNTIES = sorted({c for _, _, c in MUNI.values()})


def grid_rows():
    """The 60 (municipality, price) cells the crawler walks, in stable order."""
    return [
        {"municipality_id": mid, "name": name, "full_name": full, "price": price}
        for mid, (name, full, _county) in sorted(MUNI.items())
        for price in PRICE_POINTS
    ]


def assert_matches_db(cur):
    """Raise if the legacy hemnet_adcostpricepointv2 table has drifted from this file.

    The table survives the Django droplet (it lives in the managed Postgres), so it
    can still be edited by hand. This is the only thing that would notice.
    """
    cur.execute(
        """select p.property_municipality_id, m.full_name, p.property_price
           from hemnet_adcostpricepointv2 p
           join hemnet_municipalityv2 m on m.id = p.property_municipality_id"""
    )
    in_db = {(mid, full, price) for mid, full, price in cur.fetchall()}
    in_repo = {(r["municipality_id"], r["full_name"], r["price"]) for r in grid_rows()}
    if in_db != in_repo:
        only_db = sorted(in_db - in_repo)
        only_repo = sorted(in_repo - in_db)
        raise RuntimeError(
            "adcost grid drift: hemnet_adcostpricepointv2 disagrees with "
            "scripts/lib/adcost_grid.py — only in DB: %s ; only in repo: %s"
            % (only_db, only_repo)
        )


def _selftest():
    fails = []
    def check(name, cond, detail=""):
        if not cond:
            fails.append(f"{name}: {detail}")
    check("10 municipalities", len(MUNI) == 10, str(len(MUNI)))
    check("6 price points", len(PRICE_POINTS) == 6, str(PRICE_POINTS))
    check("420 expected cells", EXPECTED_CELLS == 420, str(EXPECTED_CELLS))
    rows = grid_rows()
    check("60 grid rows", len(rows) == 60, str(len(rows)))
    check("row shape", set(rows[0]) == {"name", "full_name", "price", "municipality_id"},
          str(sorted(rows[0])))
    check("full_name suffix", all(r["full_name"].endswith(" kommun") for r in rows),
          "every full_name must be '<name> kommun' for webAutocompleteLocations")
    check("ids are ints", all(isinstance(r["municipality_id"], int) for r in rows), "")
    check("prices ascending", PRICE_POINTS == sorted(PRICE_POINTS), str(PRICE_POINTS))
    for f in fails:
        print("FAIL", f)
    print(f"adcost_grid selftest: {8 - len(fails)} pass, {len(fails)} fail")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
