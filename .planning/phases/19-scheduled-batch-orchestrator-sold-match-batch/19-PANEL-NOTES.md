# Phase 19 — National panel probe results + decisions (2026-06-18)

Operator (Julian) reframed the sample 2026-06-18: instead of a few hand-picked segments, take **~1,000 non-deed Booli sold properties every 2 weeks**, de-duped (≤14-day lookback), distributed across Sweden by **population**, with the **natural villa:apt mix** (no per-type editing). Probe `scripts/probe-national-panel.js` (operator-approved live Oxylabs, 73 calls) resolved the panel + sized volume.

## Probe outcome
- **Volume confirms 1,000/fortnight is a sample-DOWN.** 11 usable munis already yield **~2,741 sold (Hus+Lgh) in 14 days** (Stockholm alone 92 Hus / 1,186 Lgh). Headroom ~2.7×.
- **Natural type mix is strong + real** — metros apartment-dominant (Stockholm 13:1 Lgh:Hus), smaller munis villa-heavier. Proportional sampling captures it with zero per-type editing.
- **Booli areaIds:** 19/30 resolved via `Area_V3` scan (1–500). 11 missing (IDs >500 or diacritic name-mismatch).
- **Hemnet location_ids:** the live `/locations/show` JSON endpoint is **Cloudflare-dead via Oxylabs** (the Oxylabs fallback only parses HTML/`__NEXT_DATA__`, not raw JSON) → all returned `?`. Recovered 11 from the existing `lib/hemnet-locations.json` cache instead.

## DECISION — v1 panel = 11 munis with BOTH IDs (`config/sold-panel.json`)
Stockholm, Göteborg, Malmö, Uppsala, Helsingborg, Lund, Borås, Nacka, Södertälje, Täby, Kungälv. Covers all 3 metros + Uppsala + Skåne(3) + VGR(3) + greater-Stockholm(4). Metro/south-heavy, **no Norrland** — acceptable representative-enough v1; panel is pure config so expansion is a one-line append. Unblocks the whole build.

## Allocation (judgment call — `lib/sold-sample.js`)
Allocate the 1,000 across munis **by population**, **capped at each muni's live 14-day volume**; within a muni split Hus:Lägenhet by the **natural live volume ratio**. Exclude deeds (`soldPriceType` not in {Slutpris, Sista bud}) post-scrape. De-dupe new pulls against `booli_sold.booli_id`. Fresh 14-day window (`max=today, min=today-14`) — relies on the Phase-18 re-check drain for slutpris-lag (loop #1), not a settled buffer.

## Backfill (MORNING — documented in `config/sold-panel.json._backfill_pending`)
- 8 munis have Booli IDs, need Hemnet IDs (Linköping 393 / Örebro 334 / Västerås 424 / Norrköping 252 / Eskilstuna 206 / Halmstad 438 / Sundsvall 249 / Karlstad 389) → adds Östergötland/mid-Sweden/Värmland/Halland/a northern city.
- North + Småland + Gotland (Umeå, Luleå, Östersund, Gävle, Jönköping, Växjö, Kalmar, Falun, Visby, Kiruna, Trollhättan-booli) need both.
- **Fix needed:** a raw-Oxylabs JSON helper for Hemnet `/locations/show` (current path is dead), OR operator pastes IDs off the URLs.

## Cost model (per the analysis given to operator)
~1,000 properties + re-check drain ≈ **~3,000–6,000 Oxylabs calls/fortnightly run → ~7,000–13,000/month** (mid ~9k, ~$15–45/mo). Re-check drain is ~50% (always reaches the bridge). Set `MAX_OXY_CALLS` batch ceiling ~6,000–8,000. Cheaper re-check variant (skip bridge on intermediate re-checks) built **default-OFF** as a lever.
