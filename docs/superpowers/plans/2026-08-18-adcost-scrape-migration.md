# Ad-cost Scrape Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Hemnet ad-cost scrape off the standalone Django/Celery droplet `170.64.181.89` onto the cohort-tracker droplet `170.64.197.241`, so the old droplet can be destroyed (~$12/month).

**Architecture:** Lift-and-shift the proven Python crawler, keeping only its `unlocker` (Bright Data Web Unlocker) transport, and drive it from a thin Node job registered in `lib/job-registry.js` — the same shape as the existing `adcost-report.js`. The Django ORM's two responsibilities (reading the grid, writing the rows) become a shared repo-constant module and a small psycopg module. All data already lives in the shared managed Postgres, so nothing is migrated, only the code that orchestrates it.

**Tech Stack:** Node 20 (`cron-wrapper`, `job-registry`), Python 3.12 under `/opt/hemnet-cohort-tracker/.venv-adcost` (`requests`, `psycopg`), PostgreSQL (managed), Bright Data Web Unlocker.

**Spec:** `docs/superpowers/specs/2026-08-18-adcost-scrape-migration-design.md`

## Global Constraints

- `ADCOST_OFFERS_PER_CELL = 7`; `EXPECTED_CELLS = 10 munis × 6 price points × 7 products = 420`.
- `ADCOST_MIN_COMPLETENESS = 0.95` — retained, but **as a severity label, not the pass/fail line**.
  Ruling R12 (final review) made the gate stricter than this plan originally specified: the job
  exits non-zero on **any** month short of all 420 cells, **after** writing rows. Reason: both
  downstream consumers already require exactly 420 (`adCostMonth`'s `cells === 420`,
  `adcost-report.py`'s `cells == EXPECTED_CELLS`), so a 413-row month that passed a 0.95 gate
  exited 0 with a green Slack post while the monitor went red and the report called it PARTIAL.
  Below 0.95 the error says `incomplete`; at/above 0.95 but short it says `short grid` and names
  the missing cell count. See `completeness_failure()` in `scripts/adcost-crawl.py`.
- Subprocess timeout `2700` seconds, passed to the child as `ADCOST_SUBPROCESS_TIMEOUT` from a **single constant**, because the crawler derives its own `TIME_BUDGET` from it and the two must never drift.
- Transport is `unlocker` only. Proxy `brd.superproxy.io:44445`, `verify=False` (Bright Data terminates TLS).
- Credential `BRIGHTDATA_UNLOCKER_PROXY` — read from env, else repo-root `.env`. **Never logged, never echoed into a transcript or commit.**
- `ad_price = prices.PAY_WHEN_LISTING_IS_REMOVED.total.amountInCents / 100` — SEK, **net of 25% moms**.
  ⚠ **Not `PAY_NOW`.** Earlier revisions of this plan (and the Django docstring it was copied from)
  said `PAY_NOW`; that was a stale-docstring error — the working code never read `PAY_NOW`.
  The payment method is load-bearing for continuity across the scrape gap: the historical
  AdCostV2 series matches `PAY_WHEN_LISTING_IS_REMOVED` exactly (Stockholm @5M → BASIC 7297 /
  PLUS 11662 / PREMIUM 16370 / MAX 22683). **Do not "fix" the code toward `PAY_NOW`.**
- `composeUpgradesWithBasic: true` — PLUS/PREMIUM/MAX arrive already composed; never sum BASIC into them.
- Writes are idempotent on `(property_municipality_id, property_price, ad_type)` **scoped to the crawl day**. `hemnet_adcostv2` has **no uniqueness constraint** — idempotency exists only in code.
- `valid_until` is always `NULL`. `crawled` is set to `now()`.
- Python on the workstation: use `PYTHON_BIN=python` (the local `python3` lacks `psycopg`).
- Never run a paid crawl without Julian's explicit go-ahead for that specific run.

---

## File Structure

**Create:**
- `scripts/lib/adcost_grid.py` — the single definition of which municipalities × price points are scraped, plus a DB drift assertion. Consumed by both the crawler and the report.
- `scripts/lib/adcost_write.py` — pure write-planning (`plan_writes`) + the psycopg execution layer (`apply_writes`).
- `scripts/adcost-crawl.py` — the ported crawler, `unlocker` transport only.
- `adcost-crawl.js` — Node job wrapper (repo root, beside `adcost-report.js`).

**Modify:**
- `scripts/adcost-report.py` — import the grid from `adcost_grid.py` instead of defining `MUNI`/`PRICE_POINTS` locally.
- `lib/job-registry.js` — `ad-cost-crawler` stops being `external: true` and gains a cron, command, env and log.

**Source of the port — ⚠ UNCOMMITTED, on the droplet being destroyed:**
- `/var/www/apps/hemnet/apps/hemnet/adcost_steel.py` — the crawler. Copy the unlocker path, delete the rest.
- `/var/www/apps/hemnet/apps/hemnet/tasks.py` — `search_ad_cost_2`, the orchestration and write semantics being replaced.

Also created by Task 0, and the port should read from these rather than from the live box:
- `docs/handover/adcost-django-source/adcost_steel.py` — preserved verbatim copy.
- `docs/handover/adcost-django-source/tasks.py` — preserved verbatim copy.
- `docs/handover/adcost-django-source/README.md` — provenance.

---

## Task 0: Rescue the source — DO THIS FIRST

**Why this task exists.** Verified 2026-08-18 on `170.64.181.89`:

```
repo:      /var/www/apps/hemnet   (bind-mounted to /app in the container)
branch:    feat/adcost-steel-resume @ 328dc3d
remote:    github.com/tt7676/hem-bol-scrapers.git
upstream:  none — the branch has never been pushed
status:    M apps/hemnet/adcost_steel.py   (+1,226 lines)
           M apps/hemnet/tasks.py          (+115 lines)
```

`git branch -r --contains 328dc3d` returns nothing, so the commit is on no remote either.
**The entire working Bright Data fix — 1,238 uncommitted insertions, 56 of them referencing
`unlocker`/`44445`/`BRIGHTDATA` — exists in exactly one place: a working tree on the droplet
this plan destroys.** It is also the only thing currently producing the dataset. Until Task 0
completes, every later task depends on a single unbacked-up host, and Task 4's "copy the file
down" has nothing to fall back on.

The remote belongs to a third party (`tt7676`), so pushing the branch upstream is not an
option available to us. Preserving it here is.

**Files:**
- Create: `docs/handover/adcost-django-source/adcost_steel.py`
- Create: `docs/handover/adcost-django-source/tasks.py`
- Create: `docs/handover/adcost-django-source/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a committed, verbatim copy of the two source files that Tasks 3 and 4 port from.

- [ ] **Step 1: Take the DigitalOcean snapshot NOW**

Snapshot `170.64.181.89` before touching anything. This was originally Task 7 Step 4; it moved
here because it is the only backup of the running configuration, the beat rows, and the `.env`.

Record the snapshot id in `docs/handover/adcost-django-source/README.md` at Step 4.
Retention: hold to ~2026-11-18 per decision D7.

- [ ] **Step 2: Copy both files down verbatim**

```bash
mkdir -p docs/handover/adcost-django-source
for f in adcost_steel.py tasks.py; do
  ssh -i ~/.ssh/droplet_ed25519 root@170.64.181.89 \
    "cat /var/www/apps/hemnet/apps/hemnet/$f" > "docs/handover/adcost-django-source/$f"
done
wc -l docs/handover/adcost-django-source/*.py
```

Expected: `adcost_steel.py` ≈ 1315 lines, `tasks.py` ≈ 1900+ lines.

- [ ] **Step 3: Verify the copies are byte-identical to the source**

A truncated copy would be worse than no copy, because it looks like a backup.

```bash
ssh -i ~/.ssh/droplet_ed25519 root@170.64.181.89 \
  "md5sum /var/www/apps/hemnet/apps/hemnet/adcost_steel.py /var/www/apps/hemnet/apps/hemnet/tasks.py"
md5sum docs/handover/adcost-django-source/adcost_steel.py docs/handover/adcost-django-source/tasks.py
```

Expected: the two hashes match pairwise. If they differ, check for CRLF translation and re-copy
with `scp` rather than a redirected `cat`.

- [ ] **Step 4: Write the provenance README**

```markdown
# Ad-cost Django source — preserved 2026-08-18

Verbatim copies of the two files the ad-cost scrape actually ran from on the
price-scraper droplet `170.64.181.89`, taken before that droplet was destroyed.

**These were UNCOMMITTED when copied.** The droplet's checkout of
`github.com/tt7676/hem-bol-scrapers.git` sat on branch `feat/adcost-steel-resume`
@ `328dc3d` with no upstream, carrying +1,226 uncommitted lines in
`adcost_steel.py` and +115 in `tasks.py` — the whole Bright Data Web Unlocker fix.
That commit was on no remote branch. This directory was the first time any of it
existed anywhere but that one host.

The remote is a third party's repository, so the branch could not be pushed upstream.

- `adcost_steel.py` — the crawler. Its `unlocker` transport is what
  `scripts/adcost-crawl.py` is ported from.
- `tasks.py` — contains `search_ad_cost_2`, whose grid read and idempotent write
  became `scripts/lib/adcost_grid.py` and `scripts/lib/adcost_write.py`.

Reference only. Nothing in this repo imports or executes these files.

DO snapshot of the droplet: `<id>` — hold to ~2026-11-18 (spec decision D7).
```

- [ ] **Step 5: Commit**

```bash
git add docs/handover/adcost-django-source/
git commit -m "chore(adcost): preserve the Django crawler source before decommission

The working Bright Data fix was 1,238 uncommitted lines in a working tree on
170.64.181.89, on a never-pushed branch of a third party's repo. This is the
first time it has existed anywhere else."
git push origin master
```

- [ ] **Step 6: Confirm it is off the doomed host**

```bash
git log --oneline -1 origin/master
ssh cohort-droplet "cd /opt/hemnet-cohort-tracker && git pull --ff-only -q && ls docs/handover/adcost-django-source/"
```

Expected: both files listed on a machine that is not `170.64.181.89`.

---

## Task 1: Shared grid module

**Files:**
- Create: `scripts/lib/adcost_grid.py`
- Test: `scripts/lib/adcost_grid.py` (self-test in `--selftest`, matching this repo's offline-smoke convention)

**Interfaces:**
- Consumes: nothing.
- Produces: `MUNI: dict[int, tuple[str, str, str]]` (id → name, full_name, county), `PRICE_POINTS: list[int]`, `OFFERS_PER_CELL: int`, `EXPECTED_CELLS: int`, `grid_rows() -> list[dict]`, `assert_matches_db(cur) -> None`.

- [ ] **Step 1: Write the failing self-test**

Create `scripts/lib/adcost_grid.py` containing ONLY the test block for now:

```python
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PYTHON_BIN=python python scripts/lib/adcost_grid.py`
Expected: `NameError: name 'MUNI' is not defined`

- [ ] **Step 3: Add the constants and helpers above the test block**

```python
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
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `PYTHON_BIN=python python scripts/lib/adcost_grid.py`
Expected: `adcost_grid selftest: 8 pass, 0 fail`, exit 0

- [ ] **Step 5: Verify the DB assertion against the real table**

Run:

```bash
PYTHON_BIN=python python -c "
import sys, os, importlib.util, psycopg
sys.path.insert(0, 'scripts/lib')
import adcost_grid as g
spec = importlib.util.spec_from_file_location('ar', 'scripts/adcost-report.py')
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
env = ar.load_env()
conn = psycopg.connect(host=env['DB_HOST'], port=env.get('DB_PORT',5432), user=env['DB_USER'],
                       password=env['DB_PASSWORD'], dbname=env['DB_NAME'], sslmode='require')
g.assert_matches_db(conn.cursor())
print('grid matches hemnet_adcostpricepointv2')
"
```

Expected: `grid matches hemnet_adcostpricepointv2` (no exception)

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/adcost_grid.py
git commit -m "feat(adcost): single source of truth for the scrape grid"
```

---

## Task 2: Point the report at the shared grid

Collapses the second definition. This touches a **deployed, working** script, so the deliverable is proof of byte-identical output.

**Files:**
- Modify: `scripts/adcost-report.py` (the `MUNI` / `PRICE_POINTS` / `COUNTIES` block, ~lines 42-70)

**Interfaces:**
- Consumes: `adcost_grid.MUNI`, `adcost_grid.PRICE_POINTS`, `adcost_grid.COUNTIES`, `adcost_grid.EXPECTED_CELLS`.
- Produces: no new interface. `adcost-report.py`'s own `MUNI` keeps its existing 2-tuple shape `(name, county)` so nothing downstream changes.

- [ ] **Step 1: Capture the current output as the reference**

Run:

```bash
PYTHON_BIN=python python scripts/adcost-report.py --json > /tmp/adcost-before.json
node adcost-report.js --smoke | tail -1
```

Expected: a JSON file, and `smoke: 20 pass, 0 fail`

- [ ] **Step 2: Replace the local definitions with imports**

In `scripts/adcost-report.py`, replace the `MUNI = {...}`, `PRICE_POINTS = [...]` and `COUNTIES = [...]` block with:

```python
# The grid is defined once, in scripts/lib/adcost_grid.py, and shared with the
# crawler. MUNI is re-shaped to (name, county) here because every existing use
# in this file unpacks a 2-tuple.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import adcost_grid as _grid

MUNI = {mid: (name, county) for mid, (name, _full, county) in _grid.MUNI.items()}
PRICE_POINTS = list(_grid.PRICE_POINTS)
COUNTIES = list(_grid.COUNTIES)
```

Then delete the now-duplicated `EXPECTED_CELLS = len(MUNI) * ...` line and use `_grid.EXPECTED_CELLS`.

Confirm `import sys` and `import os` already exist at the top of the file (they do).

- [ ] **Step 3: Run and diff against the reference**

Run:

```bash
PYTHON_BIN=python python scripts/adcost-report.py --json > /tmp/adcost-after.json
diff /tmp/adcost-before.json /tmp/adcost-after.json && echo "IDENTICAL"
```

Expected: `IDENTICAL` — no output from diff. Any difference is a regression; stop and fix.

- [ ] **Step 4: Run the Node smoke suite**

Run: `node adcost-report.js --smoke | tail -1`
Expected: `smoke: 20 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add scripts/adcost-report.py
git commit -m "refactor(adcost): report reads the shared grid, output byte-identical"
```

---

## Task 3: The write module

**Files:**
- Create: `scripts/lib/adcost_write.py`

**Interfaces:**
- Consumes: nothing (pure, plus a psycopg cursor).
- Produces: `plan_writes(existing, rows) -> tuple[list[dict], list[tuple[int, int]]]` returning `(inserts, updates)` where an update is `(row_id, new_ad_price)`; `load_existing(cur, day) -> dict`; `apply_writes(cur, inserts, updates) -> tuple[int, int]`.

- [ ] **Step 1: Write the failing self-test**

Create `scripts/lib/adcost_write.py` with only this block:

```python
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

    check("rounds half away from zero", plan_writes({}, [
        {"municipality_id": 193, "price": 5000000, "ad_type": "BASIC", "ad_price": 6819.5}
    ])[0][0]["ad_price"] == 6820, "")

    for f in fails:
        print("FAIL", f)
    print(f"adcost_write selftest: {8 - len(fails)} pass, {len(fails)} fail")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PYTHON_BIN=python python scripts/lib/adcost_write.py`
Expected: `NameError: name 'plan_writes' is not defined`

- [ ] **Step 3: Implement above the test block**

```python
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
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `PYTHON_BIN=python python scripts/lib/adcost_write.py`
Expected: `adcost_write selftest: 8 pass, 0 fail`, exit 0

- [ ] **Step 5: Prove the round-trip against the real table, then roll back**

Run:

```bash
PYTHON_BIN=python python -c "
import sys, datetime, importlib.util, psycopg
sys.path.insert(0, 'scripts/lib')
import adcost_write as w
spec = importlib.util.spec_from_file_location('ar', 'scripts/adcost-report.py')
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
env = ar.load_env()
conn = psycopg.connect(host=env['DB_HOST'], port=env.get('DB_PORT',5432), user=env['DB_USER'],
                       password=env['DB_PASSWORD'], dbname=env['DB_NAME'], sslmode='require')
cur = conn.cursor()
day = datetime.date(2026, 8, 17)
ex = w.load_existing(cur, day)
print('existing rows for 2026-08-17:', len(ex), '(expect 420)')
ins, upd = w.plan_writes(ex, [{'municipality_id':193,'price':5000000,'ad_type':'MAX','ad_price':18146.0}])
print('replaying an unchanged cell ->', 'no-op' if not ins and not upd else ('CHANGED', ins, upd))
conn.rollback(); conn.close()
"
```

Expected: `existing rows for 2026-08-17: 420 (expect 420)` and `replaying an unchanged cell -> no-op`. Nothing is written — the connection is rolled back and only reads were issued.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/adcost_write.py
git commit -m "feat(adcost): idempotent day-scoped write, pure planner + executor"
```

---

## Task 4: Port the crawler

**Files:**
- Create: `scripts/adcost-crawl.py` (from `apps/hemnet/adcost_steel.py` on `170.64.181.89`)

**Interfaces:**
- Consumes: `adcost_grid.grid_rows()`, `adcost_grid.EXPECTED_CELLS`, `adcost_write.load_existing/plan_writes/apply_writes`.
- Produces: CLI `python scripts/adcost-crawl.py [--selftest] [--dry-run]`. Exit codes `0` ok, `1` error, `2` misconfig, `4` transport blocked. On `--dry-run`, prints a JSON diff summary and writes nothing.

- [ ] **Step 1: Start from the PRESERVED copy, not the live box**

Task 0 must be complete. Copying from the committed reference rather than re-reading the
droplet means the port has a fixed, reviewable starting point, and it still works if the
old box has already gone away.

```bash
cp docs/handover/adcost-django-source/adcost_steel.py scripts/adcost-crawl.py
wc -l scripts/adcost-crawl.py   # expect ~1315
```

If `docs/handover/adcost-django-source/adcost_steel.py` does not exist, **stop and do Task 0**
— do not fall back to reading the droplet, because that silently re-creates the
single-copy-on-a-doomed-host problem Task 0 exists to remove.

- [ ] **Step 2: Run its self-test unchanged, to establish the baseline**

Run: `PYTHON_BIN=python python scripts/adcost-crawl.py --selftest`
Expected: passes. If it fails here, the copy is wrong — fix before deleting anything.

- [ ] **Step 3: Delete the dead transports**

Remove: `create_session`, `cdp_endpoint`, `release_session`, `_steel_headers`, `read_steel_key`, `brightdata_cdp_url`, every `playwright.async_api` import and code path, the `TRANSPORTS` tuple and the `TRANSPORT` selector, and any `selftest()` case that exercises Steel or the Browser API.

Hard-code the transport:

```python
# Bright Data Web Unlocker is the ONLY transport. The Steel and Browser-API paths
# were removed 2026-08-18: both were falsified (Steel's clear rate had decayed to
# ~12%; the Browser API returned resolve_fail_cf_max_tries on US and SE alike),
# and keeping them meant carrying Playwright onto a box that needs neither.
# Rollback is the 170.64.181.89 droplet snapshot, not a transport switch.
UNLOCKER_PROXY_VAR = "BRIGHTDATA_UNLOCKER_PROXY"
UNLOCKER_GQL_URL = "https://www.hemnet.se/graphql"
UNLOCKER_VERIFY = False        # Bright Data terminates TLS
UNLOCKER_TIMEOUT = (15, 120)
UNLOCKER_WARMUP_TIMEOUT = (15, 240)
```

- [ ] **Step 4: Run the self-test again**

Run: `PYTHON_BIN=python python scripts/adcost-crawl.py --selftest`
Expected: passes, with fewer checks than Step 2. Zero network, zero spend.

- [ ] **Step 5: Replace stdin-grid with the shared grid, and add the write**

Replace `main()`'s `json.load(sys.stdin)` grid with `adcost_grid.grid_rows()`, and append the write + completeness gate that `search_ad_cost_2` used to own:

```python
def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="crawl fully, write nothing, diff against the last complete snapshot")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    import adcost_grid as grid
    import adcost_write as writer

    conn = connect_db()                      # same .env reader as adcost-report.py
    cur = conn.cursor()
    grid.assert_matches_db(cur)              # fail loudly on drift before spending money

    rows, stats = crawl(grid.grid_rows())    # the ported loop, unchanged
    expected = stats.get("expected_rows") or grid.EXPECTED_CELLS

    # The crawler emits rows keyed by full_name only (adcost_steel.py:560), NOT by
    # municipality id. Django bridged this with `municipality_by_full_name` and so
    # must we, before anything downstream touches a row. A row whose full_name is
    # unknown gets municipality_id None and is dropped by plan_writes — matching
    # Django's `if municipality is None: continue`.
    by_full = {r["full_name"]: r["municipality_id"] for r in grid.grid_rows()}
    for r in rows:
        r["municipality_id"] = by_full.get(r["full_name"])
    unmapped = sum(1 for r in rows if r["municipality_id"] is None)
    if unmapped:
        print(f"WARNING: {unmapped} crawled rows had an unrecognised full_name "
              f"and will be dropped", file=sys.stderr)

    if args.dry_run:
        conn.rollback()
        print(json.dumps(dry_run_diff(cur, rows, expected), ensure_ascii=True))
        return 0

    day = datetime.datetime.now(datetime.timezone.utc).date()
    ins, upd = writer.plan_writes(writer.load_existing(cur, day), rows)
    created, updated = writer.apply_writes(cur, ins, upd)
    conn.commit()
    print(f"adcost-crawl wrote [created={created} updated={updated}]", file=sys.stderr)

    # Completeness gate LAST. Rows are written first so a degraded month keeps its
    # partial data, but the job must still fail: downstream reporting cannot
    # otherwise tell a 35-row month from a 420-row month.
    if not rows:
        raise RuntimeError("adcost crawl returned no rows (expected %s)" % expected)
    if len(rows) < expected * ADCOST_MIN_COMPLETENESS:
        raise RuntimeError(
            "adcost crawl incomplete: %s/%s rows (%.1f%%) from %s/%s cells, "
            "%s rebuild(s), aborted=%s — rows written, month is degraded"
            % (len(rows), expected, 100.0 * len(rows) / expected,
               stats.get("cells_ok"), stats.get("cells_total"),
               stats.get("reclears"), stats.get("aborted")))
    return 0
```

- [ ] **Step 6: Add the dry-run diff helper**

```python
def dry_run_diff(cur, rows, expected):
    """Compare a crawl against the most recent COMPLETE snapshot. Writes nothing."""
    cur.execute(
        """select (crawled at time zone 'UTC')::date d, count(*)
           from hemnet_adcostv2 group by 1 having count(*) >= %s
           order by 1 desc limit 1""", (expected,))
    ref = cur.fetchone()
    if ref is None:
        return {"rows": len(rows), "expected": expected, "reference": None}
    ref_day = ref[0]
    cur.execute(
        """select property_municipality_id, property_price, ad_type, max(ad_price)
           from hemnet_adcostv2 where (crawled at time zone 'UTC')::date = %s
           group by 1,2,3""", (ref_day,))
    before = {(m, p, t): v for m, p, t, v in cur.fetchall()}
    now = {(r["municipality_id"], r["price"], r["ad_type"]): int(round(r["ad_price"]))
           for r in rows}
    changed = {k: [before[k], now[k]] for k in set(before) & set(now) if before[k] != now[k]}
    return {
        "reference_day": ref_day.isoformat(),
        "rows": len(rows), "expected": expected,
        "complete": len(rows) == expected,
        "missing_vs_reference": sorted(map(list, set(before) - set(now)))[:20],
        "new_vs_reference": sorted(map(list, set(now) - set(before)))[:20],
        "changed_count": len(changed),
        "changed_sample": {str(k): v for k, v in list(changed.items())[:20]},
    }
```

- [ ] **Step 7: Fix `read_env_value`'s path depth — it is one directory too high here**

Copied unchanged, `read_env_value` resolves the fallback `.env` as
`os.path.join(os.path.dirname(__file__), "..", "..", ".env")`. In Django the file sat at
`apps/hemnet/adcost_steel.py` — two levels down, so `../..` was the repo root. Here it sits at
`scripts/adcost-crawl.py` — **one** level down, so `../..` resolves to `/opt/.env`, which does
not exist.

It is masked in normal operation, because the crontab `cd`s to the repo root and `dotenv`
supplies the credential through `process.env`. It bites the moment anyone runs
`python scripts/adcost-crawl.py` directly — which is exactly what a manual repair run after a
failed month looks like — giving a misleading `exit 2, "not set (env or repo-root .env)"`.

```python
# Repo root is ONE level up from scripts/, not two. (In the Django tree this file
# lived at apps/hemnet/, hence the original "../..".)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
```

and use `os.path.join(REPO_ROOT, ".env")` in `read_env_value`.

- [ ] **Step 8: Prove the fallback resolves to the real repo root**

```bash
PYTHON_BIN=python python -c "
import os, sys; sys.path.insert(0, 'scripts')
import importlib.util
spec = importlib.util.spec_from_file_location('c', 'scripts/adcost-crawl.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print('repo root ->', m.REPO_ROOT)
print('.env exists ->', os.path.exists(os.path.join(m.REPO_ROOT, '.env')))"
```

Expected: the path ends in `hemnet-cohort-tracker` and `.env exists -> True`. If it ends in
`/opt` or the parent directory, the fix did not take.

- [ ] **Step 9: Run the self-test once more**

Run: `PYTHON_BIN=python python scripts/adcost-crawl.py --selftest`
Expected: passes. Still no network.

- [ ] **Step 8: Commit**

```bash
git add scripts/adcost-crawl.py
git commit -m "feat(adcost): port the crawler, unlocker transport only"
```

---

## Task 5: Node wrapper and registry entry

**Files:**
- Create: `adcost-crawl.js`
- Modify: `lib/job-registry.js` (the `ad-cost-crawler` entry, currently `tier: 1, external: true, frequency: 'monthly', assert: 'adCostMonth'`)

**Interfaces:**
- Consumes: `scripts/adcost-crawl.py`; `cron-wrapper.runJob`.
- Produces: CLI `node adcost-crawl.js [--smoke] [--dry-run]`; registry key `ad-cost-crawler`.

- [ ] **Step 1: Write the wrapper**

Model it on `adcost-report.js`. The load-bearing details:

```js
// ⚠ ONE constant. subprocess.run DISCARDS the child's stdout on timeout, so an
// overrun loses the ENTIRE month's harvest rather than its tail — a permanent
// hole in an unbackfillable monthly series. The crawler derives its own
// TIME_BUDGET from ADCOST_SUBPROCESS_TIMEOUT, so these must never drift apart.
const SUBPROCESS_TIMEOUT_SEC = 2700;

function runPython(extraArgs, deps = {}) {
  const spawnSync = deps.spawnSync || require('child_process').spawnSync;
  const bins = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : ['python3', 'python'];
  let last = null;
  for (const bin of bins) {
    const res = spawnSync(bin, [PY_SCRIPT, ...extraArgs], {
      encoding: 'utf8',
      timeout: (SUBPROCESS_TIMEOUT_SEC + 60) * 1000,
      env: { ...process.env, ADCOST_SUBPROCESS_TIMEOUT: String(SUBPROCESS_TIMEOUT_SEC) },
    });
    // Fall through ONLY when the interpreter is absent. A python that exists and
    // fails must fail loudly, never be silently retried under another one.
    if (res.error && res.error.code === 'ENOENT') { last = res; continue; }
    if (res.error) throw new Error(`${bin} failed to start: ${res.error.message}`);
    // ALWAYS surface stderr, not only on non-zero exit: every degraded run so far
    // exited 0, and its "price fetch failed" lines were captured and thrown away.
    if (res.stderr) log.info(`adcost-crawl stderr: ${res.stderr.slice(-8000)}`);
    if (res.status !== 0) throw new Error(`${bin} ${PY_SCRIPT} exited ${res.status}`);
    return res.stdout;
  }
  throw new Error(`no usable python interpreter (tried ${bins.join(', ')})`);
}
```

- [ ] **Step 2: Write the smoke checks**

```js
function smoke() {
  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fail++; console.log(`SMOKE FAIL [${name}]: ${e.message}`); }
  };

  check('a missing interpreter falls through, a failing one does NOT', () => {
    const calls = [];
    const fakeSpawn = (bin) => {
      calls.push(bin);
      if (bin === 'python3') return { error: { code: 'ENOENT' } };
      return { status: 1, stderr: 'boom', stdout: '' };
    };
    delete process.env.PYTHON_BIN;
    assert.throws(() => runPython([], { spawnSync: fakeSpawn }), /exited 1/);
    assert.deepStrictEqual(calls, ['python3', 'python']);
  });

  check('a non-ENOENT spawn error is never retried', () => {
    const calls = [];
    const fakeSpawn = (bin) => { calls.push(bin); return { error: { code: 'EACCES', message: 'denied' } }; };
    assert.throws(() => runPython([], { spawnSync: fakeSpawn }), /failed to start/);
    assert.strictEqual(calls.length, 1, 'must not try a second interpreter');
  });

  check('the subprocess timeout is passed to the child from ONE constant', () => {
    let seenEnv = null;
    const fakeSpawn = (_b, _a, opts) => { seenEnv = opts.env; return { status: 0, stdout: '{}' }; };
    process.env.PYTHON_BIN = 'python';
    runPython([], { spawnSync: fakeSpawn });
    assert.strictEqual(seenEnv.ADCOST_SUBPROCESS_TIMEOUT, String(SUBPROCESS_TIMEOUT_SEC));
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  return fail === 0 ? 0 : 1;
}
```

- [ ] **Step 3: Run the smoke suite**

Run: `node adcost-crawl.js --smoke`
Expected: `smoke: 6 pass, 0 fail` (3 as first drafted, + the exit-0 stderr-logging check,
+ the two stderr-tail-in-the-thrown-message checks added by the final review)

- [ ] **Step 4: Update the registry entry**

In `lib/job-registry.js`, replace the `ad-cost-crawler` entry:

```js
  'ad-cost-crawler': {
    // 00:30, NOT 02:00. 'age-census-monthly' already owns `0 2 1 * *` and runs
    // ~3h (expectedDurationMin: 240), so 02:00 would start two never-before-run
    // tier-1 monthly jobs on the same minute, on one vCPU / 2GB with no swap.
    // The crawler's TIME_BUDGET leaves only ~31% headroom at its own measured
    // rate, and subprocess.run DISCARDS stdout on timeout — contention costs the
    // whole month, not the tail. 00:30 + the 45-min ceiling ends by 01:15, which
    // is 45 min clear of the census and 6h40m ahead of the 07:10 report, and it
    // stays inside one UTC date so the day-scoped write cannot straddle midnight.
    tier: 1, frequency: 'monthly', label: 'Monthly (1st 00:30)',
    cron: '30 0 1 * *', command: 'node adcost-crawl.js',
    env: { PYTHON_BIN: '/opt/hemnet-cohort-tracker/.venv-adcost/bin/python' },
    log: '/var/log/hemnet/adcost-crawl.log',
    // 45 min = the 2700s subprocess ceiling, NOT the ~21 min expected runtime, so a
    // slow-but-successful month is not alerted as an overrun.
    expectedDurationMin: 45,
    assert: 'adCostMonth',
    notBefore: '2026-09-02',
  },
```

`external: true` is removed — the job now runs here.

- [ ] **Step 5: Verify NO OTHER JOB shares the slot**

⚠ Do **not** verify with `render-crontab.js | grep adcost`. That was the original check and it
is structurally blind: filtering to `adcost` hides every job you could be colliding with. That
is exactly how the `0 2 1 * *` collision with the ~3h `age-census-monthly` survived review.

Check the slot, not the job:

```bash
node scripts/render-crontab.js | grep '^30 0 1'      # expect EXACTLY ONE line: adcost-crawl
node scripts/render-crontab.js | grep -E '^[0-9,*]+ [0-9,*]+ 1 ' | sort -k2 -n
node adcost-report.js --smoke | tail -1
```

Expected: one line at `30 0 1 * *`; the monthly picture reading 00:30 crawl → 02:00 census
(~3h) → 07:00 census report → 07:10 ad-cost report, with no overlap; and `smoke: 20 pass, 0 fail`.

- [ ] **Step 6: Fix the freshness assertion so a failed month cannot read green**

`lib/job-assertions.js:208` `adCostMonth` accepts **any** complete grid within
`NOW() - INTERVAL '40 days'`. That was right for the old weekly cadence. Under monthly it is
wrong: on 2026-09-01 the **2026-08-17** grid satisfies it, and keeps satisfying it until
2026-09-26. A September crawl that writes 42 rows and dies — the exact shape of 2026-08-02
(42 cells) and 2026-08-09 (35 cells), both still in the table — reads healthy for 25 days.

Replace the body with: *if anything has been crawled since the last expected fire, the newest
crawl day must be complete.* That catches a degraded month the morning it happens, and falls
back to the age check when no run is due yet.

```js
  async adCostMonth(client) {
    const r = await client.query(
      `SELECT (crawled AT TIME ZONE 'UTC')::date AS d,
              count(DISTINCT property_municipality_id)::int AS munis,
              count(DISTINCT (property_municipality_id, property_price, ad_type))::int AS cells
         FROM hemnet_adcostv2
        WHERE crawled >= NOW() - INTERVAL '40 days'
        GROUP BY 1 ORDER BY 1 DESC`);
    if (!r.rows.length) {
      return bad('no hemnet_adcostv2 rows in 40 days — the monthly crawl has not run');
    }
    const iso = (x) => (x.toISOString ? x.toISOString().slice(0, 10) : String(x));
    // The newest crawl day is the one that matters. If the crawler ran and produced a
    // partial grid, an older COMPLETE grid must not be allowed to vouch for it.
    const newest = r.rows[0];
    if (newest.munis !== 10 || newest.cells !== 420) {
      return bad(`newest run ${iso(newest.d)} is INCOMPLETE — ${newest.munis}/10 municipalities, `
        + `${newest.cells}/420 cells. An older complete grid does not make this month good.`);
    }
    return ok(`complete grid ${iso(newest.d)} (420/420 cells, 10 munis)`);
  },
```

- [ ] **Step 7: Prove the new assertion rejects the old failure shape**

```bash
node -e "
const {ASSERTIONS} = require('./lib/job-assertions');
// 2026-08-09 wrote 35 cells / 1 muni and 2026-08-17 wrote 420/10. Under the OLD rule a
// partial newest run passed because an older complete grid existed; under the new rule it
// must fail. Simulate both orderings against a stub client.
const stub = (rows) => ({ query: async () => ({ rows }) });
(async () => {
  const good = await ASSERTIONS.adCostMonth(stub([{d:'2026-09-01',munis:10,cells:420}]));
  const bad_ = await ASSERTIONS.adCostMonth(stub([
    {d:'2026-09-01',munis:1,cells:42}, {d:'2026-08-17',munis:10,cells:420}]));
  console.log('complete newest ->', good.ok, good.detail);
  console.log('partial newest  ->', bad_.ok, bad_.detail);
  if (good.ok !== true || bad_.ok !== false) { console.log('ASSERTION FIX FAILED'); process.exit(1); }
  console.log('OK: a partial newest run can no longer be vouched for by an older grid');
})();"
```

Expected: `complete newest -> true`, `partial newest -> false`, then the OK line.

- [ ] **Step 8: Commit**

```bash
git add adcost-crawl.js lib/job-registry.js lib/job-assertions.js
git commit -m "feat(adcost): node wrapper, registry entry at 00:30, and a monthly-correct assertion"
```

---

## Task 6: Deploy and validate with a dry run

No code. The deliverable is evidence the port produces the same grid as the old box.

- [ ] **Step 1: Push and pull**

```bash
git push origin master
ssh cohort-droplet "cd /opt/hemnet-cohort-tracker && git pull --ff-only && node adcost-crawl.js --smoke | tail -1"
```

Expected: `smoke: 6 pass, 0 fail` — a pass, not a failure. (It was 3 when this plan was
first written; the suite grew to 6 during implementation and final review. Read the
`0 fail`, not the total.)

- [ ] **Step 2: Pin the Python dependencies BEFORE installing them**

The venv at `/opt/hemnet-cohort-tracker/.venv-adcost` is **untracked, un-gitignored, and has no
lockfile** — there is no `requirements.txt`, `Pipfile` or provisioning script anywhere in the
repo. The box being destroyed has a `Dockerfile` and a `Pipfile.lock` (Python 3.11,
`requests 2.32.3`). The new box is Python 3.12 and a bare `pip install requests` currently
resolves to 2.34.2. Migrating as-is would trade a reproducible runtime for an unreproducible
one at the same moment it destroys the reproducible one — and a `git clean -fdx` or a droplet
rebuild would silently remove the entire ad-cost capability.

Create `scripts/requirements-adcost.txt`, pinning what the old box actually ran:

```
# Pinned to the versions the ad-cost crawl is known to work on. requests/urllib3
# matter more than they look: the unlocker path is an HTTPS POST through an HTTP
# proxy with verify=False, which is precisely the corner urllib3 has churned on.
# Bump only after a dry run passes on the new pins.
requests==2.32.3
urllib3==2.4.0
psycopg[binary]==3.2.*
openpyxl==3.1.*
```

Add `.venv-adcost/` to `.gitignore`, then install from the pins:

```bash
ssh cohort-droplet "cd /opt/hemnet-cohort-tracker && \
  .venv-adcost/bin/pip install -r scripts/requirements-adcost.txt"
ssh cohort-droplet "/opt/hemnet-cohort-tracker/.venv-adcost/bin/python -c \
  'import requests, urllib3, psycopg; print(requests.__version__, urllib3.__version__)'"
```

Expected: `2.32.3 2.4.0` — matching the old box, not whatever PyPI ships today.

```bash
git add scripts/requirements-adcost.txt .gitignore
git commit -m "chore(adcost): pin the crawler's python deps to the versions it ran on"
```

- [ ] **Step 3: Copy the credential host-to-host**

Never through the transcript. Read it on the old box and append it on the new one in a single hop, then verify only the *name* landed:

```bash
ssh cohort-droplet "grep -c '^BRIGHTDATA_UNLOCKER_PROXY' /opt/hemnet-cohort-tracker/.env"
```

Expected: `1`

- [ ] **Step 4: Run the offline selftest on the droplet**

```bash
ssh cohort-droplet "cd /opt/hemnet-cohort-tracker && .venv-adcost/bin/python scripts/adcost-crawl.py --selftest"
```

Expected: passes, exit 0, zero spend.

- [ ] **Step 5: GATE — get Julian's go-ahead for the paid dry runs**

~$0.10 each, ~21 minutes each, and Step 6 asks for **three**. Do not proceed without an
explicit yes for these specific runs.

*Already settled, do not re-test:* the Bright Data zone `hemnet_pricing_unlocker` authenticates
by username/password with **no source-IP allowlist**. Verified 2026-08-18 — cohort-tracker
(`170.64.197.241`) got HTTP 200 and 165KB of genuine Hemnet HTML through the proxy, three
samples, alongside a control from the old box.

- [ ] **Step 6: Run THREE dry runs at different times of day**

One run is not enough, and the plan originally asked for one. The unlocker transport has
succeeded exactly **once ever** — attended, two minutes after a hand-started container, on
freshly written code. It has never run unattended and never twice. Worse, the two recorded
timings for that same day disagree by ~7× (226.77s total for 60 cells ≈ 3.8s/cell, versus the
source file's own `MEASURED_SEC_PER_CELL = 21.0`), and the `TIME_BUDGET` cliff at ~30.6s/cell
sits between them. A single run that draws the fast case manufactures false confidence.

Spread them across the day — challenge difficulty varies (a homepage probe on 2026-08-18 ranged
**5.9s to 45s** on both hosts alike):

```bash
ssh cohort-droplet "cd /opt/hemnet-cohort-tracker && \
  PYTHON_BIN=.venv-adcost/bin/python node adcost-crawl.js --dry-run"
```

Expected each time: `"complete": true`, `"rows": 420`, `"expected": 420`, empty
`missing_vs_reference` and `new_vs_reference`. `changed_count` may be non-zero — if Hemnet
repriced this week that is a real observation, not a port bug. Investigate any changed cell
before accepting.

**Stop and fix if:** rows < 420 on any run, or any cell is missing versus the reference.

- [ ] **Step 7: Size the timeout from the SLOWEST run, not the average**

Record wall-clock and seconds-per-cell for all three. Then:

- If the **slowest** run exceeds ~50% of `TIME_BUDGET` (≈940s of the ≈1875s budget), raise
  `SUBPROCESS_TIMEOUT_SEC` **and** confirm the crawler's derived `TIME_BUDGET` moves with it —
  they come from one constant precisely so they cannot drift — then re-run Step 6.
- If the three runs disagree by more than ~2×, say so explicitly in the handover rather than
  quoting a mean. The failure mode here is a slow month meeting a budget sized on a fast one,
  and `subprocess.run` discards stdout on timeout, so the cost is the entire month.

---

## Task 7: Cutover and decommission

- [ ] **Step 1: Install the crontab**

```bash
ssh cohort-droplet "crontab -l > /root/crontab-backup-\$(date +%Y%m%d).txt && \
  cd /opt/hemnet-cohort-tracker && node scripts/render-crontab.js | crontab - && \
  node scripts/render-crontab.js --check"
```

Expected: `crontab in sync with lib/job-registry.js`

- [ ] **Step 2: Disable the old Celery beat row — BEFORE the first new fire**

```bash
ssh -i ~/.ssh/droplet_ed25519 root@170.64.181.89 \
  "docker exec hemnet-django python manage.py shell -c \"
from django_celery_beat.models import PeriodicTask
t = PeriodicTask.objects.get(name='Scrape hemnet.se ad cost')
t.enabled = False; t.save()
print('disabled:', t.name, t.enabled)\""
```

Expected: `disabled: Scrape hemnet.se ad cost False`. Two writers must never target the same crawl day.

- [ ] **Step 3: 1 September — verify the first unattended run**

```bash
ssh cohort-droplet "tail -40 /var/log/hemnet/adcost-crawl.log"
PYTHON_BIN=python python scripts/adcost-report.py --json | head -5
```

Expected: 420 rows written for 2026-09-01, and the 07:10 report reading them as the latest complete snapshot.

- [ ] **Step 4: Verify the snapshot from Task 0 is complete and readable**

The snapshot was taken in Task 0 Step 1, not here — it is the only backup of the running
configuration, the beat rows and the `.env`, so it could not wait until decommission time.
Confirm it finished successfully and that its id is recorded in
`docs/handover/adcost-django-source/README.md`. **Hold until ~2026-11-18** (decision D7),
then delete.

- [ ] **Step 5: Destroy the droplet**

Only after **all** of these hold:
- Step 3 passed — 1 September wrote 420 rows from cohort-tracker and the report read them.
- Step 4 passed — the snapshot exists and its id is recorded.
- `docs/handover/adcost-django-source/` is committed and **pushed to origin** (Task 0 Step 6).
  This is the only copy of the crawler that ever existed off that host.

Then remove its stale trusted-source entry from the managed database's firewall.

Note what is deliberately being given up: the Django admin UI, the disabled listing scrapers,
and the Metabase *server*. Metabase's dashboards and saved questions survive — they live in the
managed Postgres (`MB_DB_TYPE=postgres`, database `metabase`) with no local volume — so only the
container is lost, restorable with one `docker run` on any host.

- [ ] **Step 6: Delete the now-dead `notBefore` key**

After the 1 September run, remove `notBefore: '2026-09-02'` from both `ad-cost-crawler` and `adcost-report` in `lib/job-registry.js` — it is inert config once each job has fired.

```bash
git add lib/job-registry.js
git commit -m "chore(adcost): drop notBefore, both jobs have now fired"
```

---

## Notes for the executor

- **Task 0 is not optional and not reorderable.** Until it completes, the only copy of the
  working crawler is 1,238 uncommitted lines on the host this plan destroys, on a branch of a
  third party's repo that has never been pushed. Everything else here assumes that source
  still exists.
- **The riskiest thing in this plan is Task 3.** `hemnet_adcostv2` has no uniqueness constraint, so a wrong key or a wrong day boundary silently duplicates rows and corrupts the series. The reporting side only survives 2025-10-19's double-run because it dedupes with `max(ad_price)` in SQL.
- **Do not "improve" the completeness gate's ordering.** Rows are written *before* it raises, deliberately.
- **Do not add a `python3 → python` fallback that swallows failures.** ENOENT only.
- **`--dry-run` on this script is genuinely passive** (it rolls back and writes nothing). That is *not* true of every script in this repo — `weekly-view-report`'s `--dry-run` is not passive.
- Swedish characters in `adcost_grid.py` must be UTF-8. The Windows console renders them as mojibake; that is a display artefact, not corruption. Verify with a byte check, not by eye.
