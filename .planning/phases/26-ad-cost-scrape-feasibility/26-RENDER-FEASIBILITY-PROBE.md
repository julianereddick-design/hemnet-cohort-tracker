VERDICT: RENDER_PARTIAL

# Phase 26 — Ad-Cost RENDER Feasibility Probe

**Date:** 2026-06-30
**Question:** Can Hemnet's seller ad-cost package prices be captured via an Oxylabs Web Scraper API **headless-render** fetch (`render:'html'`, optionally `browser_instructions`) using THIS repo's existing creds — avoiding a new Oxylabs product?

**Answer (short):** Render executes the page's client JS and `browser_instructions` ARE available on these creds and get **~90% of the way** — typing drives React, the asking-price field formats, and the location autocomplete opens showing the **exact target municipality** option. BUT the final step — committing the react-select location selection so the price GraphQL query fires — **cannot be performed with the supported action set**. `click` does not trigger react-select's selection, and there is **no keyboard/Enter action type** at all. So the `sellerMarketingProductPrices` query never fires and the BASIC/PLUS/PREMIUM/MAX cards stay priceless in every rendered case. Prices are therefore **not reliably parameterizable** via render with existing creds → **RENDER_PARTIAL**, and the practical path remains a body-capable / GraphQL-POST transport.

---

## Transport used

Mirrored `lib/scrape-http.js` `fetchViaOxylabs()` shape EXACTLY — `POST https://realtime.oxylabs.io/v1/queries`, body `{ source:'universal', url, geo_location:'Sweden', user_agent_type:'desktop' }`, Basic auth from this repo's `OXYLABS_USERNAME`/`OXYLABS_PASSWORD` — but **added `render:'html'`** (and later `browser_instructions`) and returned `result.content` unconditionally (no `__NEXT_DATA__` gate). Probe scripts in scratchpad: `probe-render.js`, `probe-bi.js`, `probe-bi2.js`, `probe-bi3.js`, `probe-actiontypes.js`. **Render jobs only; no POST to Hemnet's GraphQL.**

## What was tried (Oxylabs target HTTP status)

| # | Job | URL / instructions | API | Target | Prices? | Notes |
|---|-----|--------------------|-----|--------|---------|-------|
| 1 | `render:'html'` plain | `/priser` | 200 | 200 | **No** | JS ran (page 134KB→341KB) but `loading:true` persists; no location selected |
| 2 | `render:'html'` + params | `/priser?utgangspris=5000000&kommun=Göteborg` | 200 | 200 | **No** | params do NOT drive the client query; `loading:true` |
| 3 | `render:'html'` + params | `/priser?askingPrice=5000000&locationId=17920` | 200 | 200 | **No** | same; params inert |
| 4 | `browser_instructions` type `input_text` | — | **400** | — | — | `Unsupported action type input_text` (confirms BI **is parsed/available**) |
| 5 | `browser_instructions` `input`+`click` | type askingPrice + location, click option-0 | 200 | 200 | **No** | **typing works**: askingPrice→`5 000 000`, location→`Göteborg`, `aria-expanded=true`, options 0–4 rendered incl. *"Göteborgs kommun, Västra Götalands län"*. Click did NOT select (menu stayed open) |
| 6 | A: `wait_for_element`+`click` | longer waits | 200 | 200 | **No** | `wait_for_element` valid; click still doesn't commit selection |
| 7 | B: keyboard `press` Enter | — | **400** | — | — | `Unsupported action type press` |
| 8 | C: xpath `click` on option | `//div[@id='react-select-location-option-0']` | 200 | 200 | **No** | menu stays open, no selection |
| 9 | D: location-first then click then askingPrice | — | 200 | 200 | **No** | menu closed on blur but location input **cleared to empty**, 0×"Göteborg", no `locationId`, no SingleValue chip → selection never committed |
| 10 | action-type discovery (×10) | `press, press_key, key_press, keyboard, keypress, type, key, enter_key, select_option, press_button` | **400×10** | — | — | ALL invalid → **no keyboard/select action exists** |

## Key evidence

**Render DOES execute client JS.** Plain `/priser` grew from ~134 KB (non-render GET, prior probe) to ~341 KB rendered; the autocomplete combobox (`id="location"`), asking-price input (`#text-input-askingPrice`), and package cards (`PackagePreviewDesktopView_container…`) all hydrate.

**`browser_instructions` are available on these creds.** The API validates the instruction array and rejects only unknown action *names* (job #4/#7/#10). Confirmed-valid actions: `input`, `click`, `wait`, `wait_for_element`. Confirmed-invalid: `input_text`, `press`, and 9 other keyboard/select names.

**Typing successfully drives React (job #5).** After `input` into the two fields the rendered DOM showed:
- `name="askingPrice" value="5&nbsp;000&nbsp;000"` (React onChange fired + formatter ran)
- `id="location" … value="Göteborg" … aria-expanded="true"`
- `react-select-location-option-0..4` rendered, option-0 = **"Göteborgs kommun, Västra Götalands län"** — exactly the municipality grid cell we need.

**The blocker is committing the react-select selection.** react-select commits on mousedown/keyboard-Enter. Across 3 distinct click tactics (css id, xpath, `wait_for_element`-gated, field-order reversed) the option never selected: menu stays `aria-expanded=true` with options present, or closes on blur with the location input **cleared and no SingleValue chip** (job #9). With no committed location the client never POSTs `sellerMarketingProductPrices`, so the package cards carry **zero kr package prices** — the only `kr` figures on every rendered page are an illustrative sample *listing* card (`4 395 000 kr`, `2 945 kr/mån`, `46 263 kr/m²`) and an FAQ broker-switch fee (`2 490 kronor`), never the BASIC/PLUS/PREMIUM/MAX amounts. `sellerMarketingProductPrices` / `productCode` / `TOPLISTING` / `PAID_REPUBLISH` are absent from all rendered HTML.

**Params don't help.** `?utgangspris/kommun` and `?askingPrice/locationId` (jobs #2/#3) do not inject a selected location into the render — `loading:true` regardless.

## Why this is PARTIAL, not WORKS or BLOCKED

- Not **WORKS**: prices never surface in any rendered case and cannot be parameterized over the muni × asking-price grid, because the one required interaction (select the autocomplete option) is unreachable with the supported actions.
- Not pure **BLOCKED**: render is fully capable and the creds DO support `browser_instructions`; we got within a single mousedown/Enter of firing the real query, with the correct municipality already surfaced. The gap is a missing *action capability* (keyboard Enter / a click that triggers react-select), not a rendering or credential limitation.

## Recommendation

For actually capturing the AdCostV2 grid, **do not rely on render-driven form automation with the current action set** — it cannot commit the location selection that fires the price query. The reliable path remains a **body-capable transport that issues the `SellerMarketingProductPrices` GraphQL POST directly** (resolve `locationId` via `AutocompleteLocations`, then POST `askingPrice` × `productCodes`), i.e. the droplet's existing approach with working credentials — consistent with the prior GET probe's conclusion.

Caveat / possible future flip to WORKS (not pursued, out of scope/budget): if Oxylabs exposes a keyboard action or a click variant that dispatches real mouse-down events on a higher plan tier, the render path would likely complete (typing + autocomplete already proven). Worth a one-line check with Oxylabs support before provisioning, since render+typing is already free on the existing Advanced plan and only the commit step is missing. The simpler/known-good route is still the GraphQL POST.

## Oxylabs call accounting

- **Render jobs actually executed: 7** (jobs #1,#2,#3,#5,#6,#8,#9).
- Validation-only rejections (400, no render performed): **12** (jobs #4,#7, and the 10 action-type discovery probes) — these fail at request validation before any browser render, so ~zero marginal cost.
- Total API POSTs: 19; all within the ≤~20 budget. Render is ~$0 marginal on the flat Advanced plan.
