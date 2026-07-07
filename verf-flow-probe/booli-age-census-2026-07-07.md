# Booli pre-market age penetration — census vs binary-search — 2026-07-07

National pre-market pool (`upcomingSale=1`). Age = days since Booli publish date. Stock total (headline): **33,742**.

## Census histogram (ground truth)

| Bucket | Count | % of pool | Cumulative % | of which new-build |
|---|--:|--:|--:|--:|
| ≤1mo | 8,155 | 24.2% | 24.2% | 7 |
| 1–3mo | 7,280 | 21.6% | 45.7% | 17 |
| 3–6mo | 4,000 | 11.9% | 57.6% | 11 |
| 6–12mo | 4,415 | 13.1% | 70.7% | 14 |
| 12–18mo | 3,004 | 8.9% | 79.6% | 3 |
| 18–24mo | 1,995 | 5.9% | 85.5% | 5 |
| >24mo | 4,809 | 14.3% | 99.8% | 9 |
| _undated_ | 0 | 0.0% | — | — |
| **dated total** | **33,658** | | | 66 new-build |

## Bake-off: binary-search vs census

| Bucket | Census | Binary-search | Abs err | Rel err | Pool share | Verdict |
|---|--:|--:|--:|--:|--:|:--:|
| ≤1mo | 8,155 | 8,155 | +0 | 0.0% | 24.2% | ✅ |
| 1–3mo | 7,280 | 7,280 | +0 | 0.0% | 21.6% | ✅ |
| 3–6mo | 4,000 | 4,001 | +1 | 0.0% | 11.9% | ✅ |
| 6–12mo | 4,415 | 4,415 | +0 | 0.0% | 13.1% | ✅ |
| 12–18mo | 3,004 | 3,004 | +0 | 0.0% | 8.9% | ✅ |
| 18–24mo | 1,995 | 1,995 | +0 | 0.0% | 5.9% | ✅ |
| >24mo | 4,809 | 4,892 | +83 | 1.7% | 14.3% | ✅ |
| _undated_ | 0 | 0 (est) | 0 | — | — | (excluded) |

**Acceptance:** every age bucket within ±1pp of pool (±337) AND ≤10% rel on ≥1%-share buckets.

## VERDICT: ✅ PASS — binary-search reproduces the census within tolerance

**Recommendation:** adopt binary-search going forward — ~16× cheaper (60 vs 963 calls) at bucket accuracy within tolerance.

## Coverage & quality

- Census: 963 pages walked, 0 error/gap pages, 33,658 distinct ids, drift `stock−distinct`=84.
- Page size: preflight min/max/modal 35/35/35; census mean 34.99/page; cross-page dup ids 0.
- Undated: census exact 0; binary-search rate 0.00% → est 0.
- Oxylabs calls: preflight 12 + binary 48 + census 963 = **1023**.
- Timings: preflight 43s, binary 210s, census 4543s.

_Both methods share one clock (NOW). Binary-search ran first, census immediately after; pool drift over the run ≈ 84 listings. New-builds ~0.6% of pool. Booli national via validated `upcomingSale=1`._