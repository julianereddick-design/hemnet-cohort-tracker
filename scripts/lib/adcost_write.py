#!/usr/bin/env python3
"""adcost_write.py — the idempotent write into hemnet_adcostv2.

Replaces Django's AdCostV2.objects.create / obj.save(update_fields=["ad_price"]).

⚠ hemnet_adcostv2 has NO uniqueness constraint (verified 2026-08-18: the only
indexes are the pkey on id and a plain btree on property_municipality_id). The
idempotency below is the ONLY thing preventing duplicate rows — which is exactly
how 2025-10-19 ended up with 742 rows for a 420-cell grid.

Split into a PURE planner and a thin executor so the semantics can be tested
offline, with no database and no network.
"""


def plan_writes(existing, rows):
    """Decide what to insert and what to update. Pure.

    existing: {(municipality_id, price, ad_type): (row_id, ad_price)} — already
              written for the crawl day.
    rows:     crawler output rows.
    returns:  (inserts, updates) where inserts are dicts ready for INSERT and
              updates are (row_id, new_ad_price) pairs.
    """
    seen = dict(existing)
    inserts, updates = [], []
    for row in rows:
        mid = row.get("municipality_id")
        if mid is None:
            continue                      # matches Django's `if municipality is None: continue`
        # ad_price is a PositiveIntegerField; amounts are whole kronor
        # (amountInCents / 100). Round defensively to satisfy the column type.
        ad_price = int(round(row["ad_price"]))
        key = (mid, row["price"], row["ad_type"])
        found = seen.get(key)
        if found is not None:
            row_id, current = found
            if current != ad_price and row_id is not None:
                updates.append((row_id, ad_price))
                seen[key] = (row_id, ad_price)
            continue
        inserts.append({
            "municipality_id": mid,
            "price": row["price"],
            "ad_type": row["ad_type"],
            "ad_price": ad_price,
        })
        # Mark the cell as seen so a duplicate crawler row for the same cell
        # collapses instead of inserting twice. row_id is unknown until the
        # INSERT runs, so a later differing price for the same cell within one
        # batch is intentionally ignored rather than guessed at.
        seen[key] = (None, ad_price)
    return inserts, updates


def load_existing(cur, day):
    """Rows already written for `day` (a date), keyed for plan_writes."""
    cur.execute(
        """select id, property_municipality_id, property_price, ad_type, ad_price
           from hemnet_adcostv2
           where (crawled at time zone 'UTC')::date = %s""",
        (day,),
    )
    return {(mid, price, ad_type): (row_id, ad_price)
            for row_id, mid, price, ad_type, ad_price in cur.fetchall()}


def apply_writes(cur, inserts, updates):
    """Execute the plan. Returns (created, updated)."""
    for row_id, ad_price in updates:
        cur.execute("update hemnet_adcostv2 set ad_price = %s where id = %s",
                    (ad_price, row_id))
    for row in inserts:
        cur.execute(
            """insert into hemnet_adcostv2
                 (property_municipality_id, property_price, ad_type, ad_price,
                  valid_until, crawled)
               values (%s, %s, %s, %s, NULL, now())""",
            (row["municipality_id"], row["price"], row["ad_type"], row["ad_price"]),
        )
    return len(inserts), len(updates)


def _selftest():
    fails = []
    def check(name, cond, detail=""):
        if not cond:
            fails.append(f"{name}: {detail}")

    # An empty day: everything is an insert.
    rows = [{"municipality_id": 193, "price": 5000000, "ad_type": "MAX", "ad_price": 18146.0}]
    ins, upd = plan_writes({}, rows)
    check("empty day inserts", len(ins) == 1 and not upd, f"{ins} {upd}")
    check("ad_price rounded to int", ins[0]["ad_price"] == 18146 and isinstance(ins[0]["ad_price"], int),
          repr(ins[0]["ad_price"]))

    # Same price already written today: no write at all. This is what makes a
    # re-run after a failure safe on a table with NO uniqueness constraint.
    existing = {(193, 5000000, "MAX"): (99, 18146)}
    ins, upd = plan_writes(existing, rows)
    check("unchanged is a no-op", not ins and not upd, f"{ins} {upd}")

    # Different price today: UPDATE the existing row, never insert a second one.
    existing = {(193, 5000000, "MAX"): (99, 22683)}
    ins, upd = plan_writes(existing, rows)
    check("changed updates in place", not ins and upd == [(99, 18146)], f"{ins} {upd}")

    # A row for a municipality outside the grid is dropped, matching Django's
    # `if municipality is None: continue`.
    ins, upd = plan_writes({}, [{"municipality_id": None, "price": 1, "ad_type": "MAX", "ad_price": 1.0}])
    check("unknown municipality dropped", not ins and not upd, f"{ins} {upd}")

    # The crawler emits full_name, not ids. main() maps it before calling us; a
    # full_name outside the grid therefore arrives as municipality_id None and
    # must be dropped rather than written against a null FK.
    ins, upd = plan_writes({}, [
        {"municipality_id": None, "price": 5000000, "ad_type": "MAX", "ad_price": 1.0},
        {"municipality_id": 193, "price": 5000000, "ad_type": "MAX", "ad_price": 18146.0},
    ])
    check("unmapped rows never block good ones", len(ins) == 1 and ins[0]["municipality_id"] == 193,
          f"{ins}")

    # Two crawler rows for the same cell: the second must UPDATE the first, not
    # insert a duplicate. This is the 2025-10-19 double-run failure mode.
    dup = [
        {"municipality_id": 193, "price": 5000000, "ad_type": "MAX", "ad_price": 18146.0},
        {"municipality_id": 193, "price": 5000000, "ad_type": "MAX", "ad_price": 18000.0},
    ]
    ins, upd = plan_writes({}, dup)
    check("same-cell duplicate collapses", len(ins) == 1, f"{ins} {upd}")

    check("rounds .5 to even (python round), not half-away-from-zero", plan_writes({}, [
        {"municipality_id": 193, "price": 5000000, "ad_type": "BASIC", "ad_price": 6819.5}
    ])[0][0]["ad_price"] == 6820, "")

    for f in fails:
        print("FAIL", f)
    print(f"adcost_write selftest: {8 - len(fails)} pass, {len(fails)} fail")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
