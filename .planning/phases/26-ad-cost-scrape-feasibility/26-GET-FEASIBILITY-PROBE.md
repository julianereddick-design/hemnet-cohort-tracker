VERDICT: GET_BLOCKED

# Phase 26 — Ad-Cost GET Feasibility Probe

**Date:** 2026-06-30
**Question:** Can Hemnet's seller ad-cost (advertising-package) prices be obtained via a universal GET of an HTML page + parsing server-rendered data (`__NEXT_DATA__` / Apollo state), the way this repo already scrapes Hemnet — instead of the GraphQL POST `SellerMarketingProductPrices` the droplet uses?

**Answer:** **No.** The prices are NOT present in any GET-able page's server-rendered data. The public price calculator (`/priser`) ships the package-card *structure* server-side but fetches the actual SEK prices **client-side via the same GraphQL query** the droplet uses. A body-capable Oxylabs product (or working GraphQL-POST creds) is genuinely required.

---

## Transport used

Mirrored `lib/scrape-http.js` `fetchViaOxylabs()` request shape EXACTLY — `POST https://realtime.oxylabs.io/v1/queries`, body `{ source:'universal', url, geo_location:'Sweden', user_agent_type:'desktop' }`, Basic auth from this repo's `OXYLABS_USERNAME`/`OXYLABS_PASSWORD` — but returned `result.content` unconditionally (no `__NEXT_DATA__` gate), so pages without `__NEXT_DATA__` could still be inspected. Probe script: `scratchpad/probe-adcost.js`. **GET only; no POST to Hemnet.**

## URLs tried (Oxylabs target HTTP status)

| # | URL | Target status | Bytes | `__NEXT_DATA__` | Package prices server-rendered? |
|---|-----|---------------|-------|-----------------|-------------------------------|
| 1 | `https://www.hemnet.se/priser` | **200** | 134 KB | No (App Router RSC) | **No** |
| 2 | `https://www.hemnet.se/annonsera-bostad` | **200** | 134 KB | No | No (marketing page, no calculator) |
| 3 | `https://www.hemnet.se/priser?utgangspris=5000000&kommun=Stockholm` | **200** | 302 KB | No | **No** |
| 4 | `https://www.hemnet.se/priser?askingPrice=5000000&location=Stockholm&locationId=17744` | **200** | 302 KB | No | **No** |

(`/priser` is the seller-facing "Priskalkylator" — *"Räkna ut priset på din bostadsannons"* — that takes a location + asking price and shows package prices. It is the correct target; it just doesn't serve the prices in the GET response.)

## Evidence that prices are client-side only

1. **No `__NEXT_DATA__` tag.** `/priser` is the new Next.js **App Router (React Server Components)** build — hydration streams via `self.__next_f.push([...])` and `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(...)`, not a single `__NEXT_DATA__` blob.

2. **Apollo SSR transport ships the price queries in a `loading` / unresolved state.** The server-rendered Apollo rehydrate payload contains three queries all stuck at:
   ```
   {"data":undefined,"loading":true,"networkStatus":1,"called":true}
   ```
   i.e. the price/location queries are *registered* server-side but their data is never resolved server-side — it is fetched in the browser after hydration.

3. **The package cards carry no SEK amounts.** The `BASIC` / `PLUS` / `PREMIUM` / `MAX` cards (`PackagePreviewDesktopView_*`) render the package names and feature copy (*"Bas – startpaket med det viktigaste"* etc.) but **zero `kr` price amounts** in the ~12 KB card region. The only `kr` figures anywhere on the page belong to an illustrative sample **listing card** (`4 395 000 kr`, `2 945 kr/mån`, `46 263 kr/m²`) — a property-for-sale example, not an ad-package price.

4. **The calculator inputs are client-side widgets.** Location is a `react-select` autocomplete (*"Gata eller kommun"*, `css-…-control`) that hits Hemnet's `AutocompleteLocations`; asking price is `AskingPriceInput_inputWrapper` (`#text-input-askingPrice`). Both feed the client-side GraphQL `sellerMarketingProductPrices` call — the exact operation the droplet's `search_ad_cost_2` uses.

5. **Query params do not force server-side resolution.** Variants #3 and #4 (guessed `utgangspris`/`kommun` and `askingPrice`/`location`/`locationId` params) returned a larger page but **still** had empty package cards and **still** showed Apollo `data:undefined, loading:true`. Params do not make the server embed prices.

6. **The GraphQL operation name isn't even in the HTML.** `sellerMarketingProductPrices` / `SellerMarketingProductPrice` / `productCode` / `TOPLISTING` / `PAID_REPUBLISH` are all absent from the GET response — they live only in the client JS bundle, confirming the price fetch is a runtime client call, not server data.

## Why GET cannot replace the POST

The data we want — `sellerMarketingProductPrices.prices[].{code, price.amount}` parameterized by `locationId` × `askingPrice` for the 10-municipality × 6-asking-price × ~7-tier grid (`AdCostV2`) — exists **only** as the response to the client-side GraphQL POST. The universal GET returns pre-hydration HTML where those values are `undefined`/`loading`. Oxylabs `source:'universal'` does not execute the page's client JS (no `render` in the request shape), so it can never observe the hydrated prices. Even a JS-rendering GET would only re-derive the same GraphQL POST under the hood for an empty/default form — without a submitted location + asking price there is nothing to render, and there is no URL surface that injects those into server render.

## Conclusion / recommendation

**GET_BLOCKED — must provision a body-capable Oxylabs product** (one that can carry the GraphQL POST body, e.g. Web Scraper API with a POST/`payload` body, or otherwise restore working GraphQL-POST creds for the droplet). Reusing this repo's universal-GET transport is **not** a viable substitute: the ad-cost prices are never present in the server-rendered HTML, with or without URL params. The droplet's existing `SellerMarketingProductPrices` POST approach (resolve `locationId` via `AutocompleteLocations`, then POST `askingPrice` × `productCodes`) remains the only path to the data; the only open problem is giving that POST a transport with working credentials.

## Oxylabs GET call count: 4

(2 candidate pages + 2 query-param variants of `/priser`. Well under the ~20-call budget; ~$0 marginal on the flat Advanced plan.)
