# Oxylabs support inquiry — body-capable transport for a Cloudflare-protected GraphQL POST

**Purpose:** Find a ~$0 path before committing to a ~$45/mo Web Unblocker plan. Send this to Oxylabs support/account manager. Goal priority: Q1 (free, existing plan) > Q3 (cheap PAYG) > Q2 (confirm Web Unblocker spec) > Q4 (no new product at all).

> Do not paste any account credentials into the message. Reference the account by your normal support identifier.

---

## Ready-to-send message

Subject: Need a transport that delivers a JSON POST body to a Cloudflare-protected GraphQL endpoint

Hi team,

We're on the **Web Scraper API (Advanced, $249/mo flat)** plan. We need to send a small, low-volume **GraphQL POST** (a JSON request body) to a **Cloudflare-protected** endpoint (`https://www.hemnet.se/graphql`) and read the JSON response. Volume is tiny — about **120 requests/week (~16 MB/month)**.

What we've already verified ourselves:
- Your Web Scraper API **defeats the site's Cloudflare challenge** reliably (good).
- But on our plan it **does not deliver the POST request body to the origin.** Using `source: universal` with `context: [{key: http_method, value: post}, {key: content, value: <base64>}]`, the request reaches the target as a real POST (httpbin confirms 200) **but the body arrives empty** — the origin returns `{"errors":[{"message":"Must provide query string","code":"BAD_REQUEST"}]}`, and httpbin shows `data: ""` / `Content-Length: 0`. The `context.content` is validated as base64 but then dropped before reaching the target.

**My questions:**

1. **(Highest priority — keeps us on our current plan.)** With `render: html`, **does your render engine support an `execute_javascript` / "evaluate JS in page context and return the result" browser instruction?** Our ideal flow is: load the page (you pass its Cloudflare challenge), then run our own `fetch('/graphql', {method:'POST', body: <our JSON>})` **from inside the loaded page's context** and return the JSON response. The page's cookies + browser fingerprint make that in-page fetch succeed where a proxied bare POST doesn't — and it sidesteps the form entirely. If render can execute arbitrary in-page JS and return its output, this solves everything on our existing plan. (Secondary: if there's no JS-eval action, is there one to send a keypress/Enter or dispatch a mousedown? The page's input is a `react-select` we can open to the right option with your `input` action but cannot **commit** with `click` — it commits on Enter/mousedown.)

2. **Is there any way to pass a real POST request body through to the target on our current Web Scraper API plan** (any `source`, parser, or `payload`/`content` configuration that is NOT dropped before the origin)? If a different plan tier transmits POST bodies, which one?

3. **Residential / datacenter proxies** (`pr.oxylabs.io:7777` / `dc.oxylabs.io:8001`): (a) is there a **pay-as-you-go** option with **no monthly minimum**, and the per-GB rate? (b) For a Cloudflare-protected endpoint, will a **residential** exit reliably pass the POST without your managed unblocking, or is the challenge likely to return a 403? (Our current Web Scraper API creds get 401/407 on these endpoints — they appear scoped to Web Scraper API only.)

4. **Web Unblocker** (`unblock.oxylabs.io:60000`): (a) confirm it handles a **JSON POST to a Cloudflare-protected GraphQL endpoint**; (b) is there a **pay-as-you-go / no-floor** option, or is the entry plan the **~$45/mo (8 GB)** floor we see on the site? Given our ~16 MB/month usage, a per-GB PAYG with no minimum would suit us far better than the 8 GB plan.

Thanks!

---

## Decision tree on the reply

- **Q1 yields a commit action (Enter/mousedown/JS)** → unblock on the **existing $249 plan, $0 extra**. Best outcome. We wire the render+commit flow on the droplet, re-probe, enable Phase 27.
- **Q2 yields a POST-body-passthrough config** → unblock on the existing plan, $0 extra. Droplet POSTs GraphQL through Web Scraper API directly.
- **Q3 = residential PAYG, no floor, clears Cloudflare** → ~cents/month. Thin proxy path on the droplet.
- **Else (all dead-end)** → provision **Web Unblocker (~$45/mo)**; operator value call (≈ whole sold-match budget for ~50 cells/week). Then wire + re-probe + Phase 27.

*Phase 26 · drafted 2026-06-30 · chosen next step after all free existing-creds paths exhausted. See `docs/ad-cost-scrape-cost.md` and `26-RENDER-FEASIBILITY-PROBE.md`.*
