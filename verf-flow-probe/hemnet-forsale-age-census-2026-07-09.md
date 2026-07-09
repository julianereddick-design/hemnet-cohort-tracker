# Hemnet for-sale (Till salu) age penetration — national — 2026-07-09

Municipality-partition census over 290 munis (big munis sub-partitioned by item_type + price). Age = days since Hemnet publish.

## Census histogram

| Bucket | Count | % of dated | Cumulative % | of which new-build |
|---|--:|--:|--:|--:|
| ≤1mo | 20,899 | 48.2% | 48.2% | 1687 |
| 1–3mo | 11,217 | 25.9% | 74.1% | 668 |
| 3–6mo | 3,185 | 7.3% | 81.5% | 132 |
| 6–12mo | 2,586 | 6.0% | 87.4% | 76 |
| 12–18mo | 1,930 | 4.5% | 91.9% | 49 |
| 18–24mo | 924 | 2.1% | 94.0% | 28 |
| >24mo | 2,597 | 6.0% | 100.0% | 149 |
| _undated_ | 0 | — | — | — |
| **dated total** | **43,338** | | | 2789 new-build |

## Like-for-like: Hemnet vs Booli for-sale (share of dated pool)

| Bucket | Hemnet % | Booli % |
|---|--:|--:|
| ≤1mo | 48.2% | 18.5% |
| 1–3mo | 25.9% | 32.0% |
| 3–6mo | 7.3% | 18.2% |
| 6–12mo | 6.0% | 13.4% |
| 12–18mo | 4.5% | 8.4% |
| 18–24mo | 2.1% | 3.3% |
| >24mo | 6.0% | 6.2% |

Hemnet 74% ≤3mo vs Booli 51%; zombie tail (>24mo) Hemnet 6.0% vs Booli 6.2%.

## Coverage & quality

- Munis: 290 processed, 290 with FS listings.
- Distinct listings counted: **43,338** (dated 43,338 + undated 0).
- Σ muni headline totals=43,338 vs distinct counted 43,338 (gap = clamp-undercount + dedupe; count is truth).
- Error/gap pages: 0. Upcoming cards filtered: 0. publishedAt anomalies: 0.
- Oxylabs calls: **1208**.