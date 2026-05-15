# Job B dry-run match verification

- **Cohort week:** 2026-W20  (2026-05-11 → 2026-05-17)
- **Booli rows processed:** 200 (--limit 200)
- **Match rate (matchedFromSearch / booliCount, official):** 109/200 = **54.5%**
  - Of those, 82 passed the postcode-mismatch gate (27 rejected)
- **Unique properties matched (deduped by booli_id):** 63
- **Postcode mismatches:** 27 log lines / 20 unique booli_id
- **Fetch errors:** 0  | **Parse errors:** 0  | **Null-title skipped:** 6
- **Duration:** 370.6s

> Note: 82 match log lines were emitted for 63 unique booli_ids — some booli_ids have duplicate rows in booli_listing (Job D is "duplicate-row tolerant" by design). Dedup-by-booli_id below is the right unit for human verification.

## Matches (63 of 200, 31.5%)
| # | Booli | Hemnet | Postcode | Open both | ✓ |
|---|-------|--------|----------|-----------|---|
| 1 | [Luntmakargatan 56B](https://www.booli.se/bostad/664226) | [hemnet 21721719](https://www.hemnet.se/bostad/21721719) | 11358 ✓ | [B](https://www.booli.se/bostad/664226) / [H](https://www.hemnet.se/bostad/21721719) | ☐ |
| 2 | [Vasavägen 23](https://www.booli.se/bostad/784012) | [hemnet 21724016](https://www.hemnet.se/bostad/21724016) | 16958 ✓ | [B](https://www.booli.se/bostad/784012) / [H](https://www.hemnet.se/bostad/21724016) | ☐ |
| 3 | [Södra Hultet 4](https://www.booli.se/bostad/1943285) | [hemnet 21578086](https://www.hemnet.se/bostad/21578086) | 42456 ✓ | [B](https://www.booli.se/bostad/1943285) / [H](https://www.hemnet.se/bostad/21578086) | ☐ |
| 4 | [Vretgränd 12C](https://www.booli.se/annons/4714762) | [hemnet 18919884](https://www.hemnet.se/bostad/18919884) | 75322 ✓ | [B](https://www.booli.se/annons/4714762) / [H](https://www.hemnet.se/bostad/18919884) | ☐ |
| 5 | [Leksaksgatan 5](https://www.booli.se/bostad/1730148) | [hemnet 21290320](https://www.hemnet.se/bostad/21290320) | 28335 ✓ | [B](https://www.booli.se/bostad/1730148) / [H](https://www.hemnet.se/bostad/21290320) | ☐ |
| 6 | [Kungsgatan 93C](https://www.booli.se/bostad/4047267) | [hemnet 20067779](https://www.hemnet.se/bostad/20067779) | 75318 ✓ | [B](https://www.booli.se/bostad/4047267) / [H](https://www.hemnet.se/bostad/20067779) | ☐ |
| 7 | [Murarvägen 13](https://www.booli.se/annons/4947425) | [hemnet 21721791](https://www.hemnet.se/bostad/21721791) | 16833 ✓ | [B](https://www.booli.se/annons/4947425) / [H](https://www.hemnet.se/bostad/21721791) | ☐ |
| 8 | [Solnavägen 13C](https://www.booli.se/annons/5027638) | [hemnet 20172996](https://www.hemnet.se/bostad/20172996) | 17165 ✓ | [B](https://www.booli.se/annons/5027638) / [H](https://www.hemnet.se/bostad/20172996) | ☐ |
| 9 | [Åbroddsgränden 9](https://www.booli.se/annons/5096499) | [hemnet 20699355](https://www.hemnet.se/bostad/20699355) | 28133 ✓ | [B](https://www.booli.se/annons/5096499) / [H](https://www.hemnet.se/bostad/20699355) | ☐ |
| 10 | [Rekordvägen 7](https://www.booli.se/bostad/705878) | [hemnet 21713557](https://www.hemnet.se/bostad/21713557) | 13439 ✓ | [B](https://www.booli.se/bostad/705878) / [H](https://www.hemnet.se/bostad/21713557) | ☐ |
| 11 | [Malmögatan 3B](https://www.booli.se/bostad/280730) | [hemnet 21723628](https://www.hemnet.se/bostad/21723628) | 25249 ✓ | [B](https://www.booli.se/bostad/280730) / [H](https://www.hemnet.se/bostad/21723628) | ☐ |
| 12 | [Vintrosagatan 1](https://www.booli.se/bostad/4096364) | [hemnet 21279911](https://www.hemnet.se/bostad/21279911) | 12473 ✓ | [B](https://www.booli.se/bostad/4096364) / [H](https://www.hemnet.se/bostad/21279911) | ☐ |
| 13 | [Torpstugegränd 2D](https://www.booli.se/bostad/2264274) | [hemnet 21285387](https://www.hemnet.se/bostad/21285387) | 16341 ✓ | [B](https://www.booli.se/bostad/2264274) / [H](https://www.hemnet.se/bostad/21285387) | ☐ |
| 14 | [Karlaplan 2A](https://www.booli.se/annons/5210048) | [hemnet 21722692](https://www.hemnet.se/bostad/21722692) | 11460 ✓ | [B](https://www.booli.se/annons/5210048) / [H](https://www.hemnet.se/bostad/21722692) | ☐ |
| 15 | [Sturegatan 1](https://www.booli.se/bostad/3900701) | [hemnet 21295945](https://www.hemnet.se/bostad/21295945) | 75314 ✓ | [B](https://www.booli.se/bostad/3900701) / [H](https://www.hemnet.se/bostad/21295945) | ☐ |
| 16 | [Hjärtstensvägen 13](https://www.booli.se/annons/5295253) | [hemnet 21695393](https://www.hemnet.se/bostad/21695393) | 19636 ✓ | [B](https://www.booli.se/annons/5295253) / [H](https://www.hemnet.se/bostad/21695393) | ☐ |
| 17 | [Solviksvägen 42](https://www.booli.se/bostad/2635551) | [hemnet 21322962](https://www.hemnet.se/bostad/21322962) | 76015 ✓ | [B](https://www.booli.se/bostad/2635551) / [H](https://www.hemnet.se/bostad/21322962) | ☐ |
| 18 | [Fågelvägen 10C](https://www.booli.se/bostad/2513249) | [hemnet 21327703](https://www.hemnet.se/bostad/21327703) | 17564 ✓ | [B](https://www.booli.se/bostad/2513249) / [H](https://www.hemnet.se/bostad/21327703) | ☐ |
| 19 | [Östanvindsgatan 3B](https://www.booli.se/annons/5373881) | [hemnet 21722936](https://www.hemnet.se/bostad/21722936) | 41717 ✓ | [B](https://www.booli.se/annons/5373881) / [H](https://www.hemnet.se/bostad/21722936) | ☐ |
| 20 | [Lindarnas väg 1](https://www.booli.se/bostad/2785115) | [hemnet 21396392](https://www.hemnet.se/bostad/21396392) | 24196 ✓ | [B](https://www.booli.se/bostad/2785115) / [H](https://www.hemnet.se/bostad/21396392) | ☐ |
| 21 | [Vidängsvägen 9](https://www.booli.se/bostad/2569138) | [hemnet 21364251](https://www.hemnet.se/bostad/21364251) | 15251 ✓ | [B](https://www.booli.se/bostad/2569138) / [H](https://www.hemnet.se/bostad/21364251) | ☐ |
| 22 | [Brunnehagen 33](https://www.booli.se/bostad/33558) | [hemnet 21348643](https://www.hemnet.se/bostad/21348643) | 41747 ✓ | [B](https://www.booli.se/bostad/33558) / [H](https://www.hemnet.se/bostad/21348643) | ☐ |
| 23 | [Övralidsgatan 5](https://www.booli.se/bostad/504541) | [hemnet 21427880](https://www.hemnet.se/bostad/21427880) | 42247 ✓ | [B](https://www.booli.se/bostad/504541) / [H](https://www.hemnet.se/bostad/21427880) | ☐ |
| 24 | [Vigelsjövägen 7B](https://www.booli.se/bostad/787926) | [hemnet 21380518](https://www.hemnet.se/bostad/21380518) | 76151 ✓ | [B](https://www.booli.se/bostad/787926) / [H](https://www.hemnet.se/bostad/21380518) | ☐ |
| 25 | [Svartögatan 4](https://www.booli.se/bostad/4051094) | [hemnet 21408605](https://www.hemnet.se/bostad/21408605) | 25734 ✓ | [B](https://www.booli.se/bostad/4051094) / [H](https://www.hemnet.se/bostad/21408605) | ☐ |
| 26 | [Termometergatan 32](https://www.booli.se/bostad/4435841) | [hemnet 21407871](https://www.hemnet.se/bostad/21407871) | 41841 ✓ | [B](https://www.booli.se/bostad/4435841) / [H](https://www.hemnet.se/bostad/21407871) | ☐ |
| 27 | [Silleskärsgatan 63](https://www.booli.se/bostad/3269998) | [hemnet 21723534](https://www.hemnet.se/bostad/21723534) | 42159 ✓ | [B](https://www.booli.se/bostad/3269998) / [H](https://www.hemnet.se/bostad/21723534) | ☐ |
| 28 | [Kommendantsvägen 52](https://www.booli.se/annons/5497606) | [hemnet 21474416](https://www.hemnet.se/bostad/21474416) | 29136 ✓ | [B](https://www.booli.se/annons/5497606) / [H](https://www.hemnet.se/bostad/21474416) | ☐ |
| 29 | [Lappalund 19](https://www.booli.se/annons/5542442) | [hemnet 21446806](https://www.hemnet.se/bostad/21446806) | 14897 ✓ | [B](https://www.booli.se/annons/5542442) / [H](https://www.hemnet.se/bostad/21446806) | ☐ |
| 30 | [Nobelvägen 147L](https://www.booli.se/annons/5566875) | [hemnet 21477744](https://www.hemnet.se/bostad/21477744) | 21215 ✓ | [B](https://www.booli.se/annons/5566875) / [H](https://www.hemnet.se/bostad/21477744) | ☐ |
| 31 | [Sturegatan 3](https://www.booli.se/annons/5571378) | [hemnet 21463528](https://www.hemnet.se/bostad/21463528) | 75314 ✓ | [B](https://www.booli.se/annons/5571378) / [H](https://www.hemnet.se/bostad/21463528) | ☐ |
| 32 | [Ingetorp 158C](https://www.booli.se/annons/5585260) | [hemnet 21489405](https://www.hemnet.se/bostad/21489405) | 44296 ✓ | [B](https://www.booli.se/annons/5585260) / [H](https://www.hemnet.se/bostad/21489405) | ☐ |
| 33 | [Borgargatan 6A](https://www.booli.se/annons/5603414) | [hemnet 21477780](https://www.hemnet.se/bostad/21477780) | 76160 ✓ | [B](https://www.booli.se/annons/5603414) / [H](https://www.hemnet.se/bostad/21477780) | ☐ |
| 34 | [Tvillinggatan 3A](https://www.booli.se/bostad/618078) | [hemnet 21723377](https://www.hemnet.se/bostad/21723377) | 43143 ✓ | [B](https://www.booli.se/bostad/618078) / [H](https://www.hemnet.se/bostad/21723377) | ☐ |
| 35 | [Vallagränd 10](https://www.booli.se/annons/5627421) | [hemnet 21489685](https://www.hemnet.se/bostad/21489685) | 13639 ✓ | [B](https://www.booli.se/annons/5627421) / [H](https://www.hemnet.se/bostad/21489685) | ☐ |
| 36 | [Tjädervägen 4](https://www.booli.se/bostad/1957932) | [hemnet 21499799](https://www.hemnet.se/bostad/21499799) | 50670 ✓ | [B](https://www.booli.se/bostad/1957932) / [H](https://www.hemnet.se/bostad/21499799) | ☐ |
| 37 | [Stenaredsvägen 50](https://www.booli.se/bostad/2961645) | [hemnet 21589874](https://www.hemnet.se/bostad/21589874) | 42470 ✓ | [B](https://www.booli.se/bostad/2961645) / [H](https://www.hemnet.se/bostad/21589874) | ☐ |
| 38 | [Almarevägen 10B](https://www.booli.se/bostad/4506325) | [hemnet 21515785](https://www.hemnet.se/bostad/21515785) | 17676 ✓ | [B](https://www.booli.se/bostad/4506325) / [H](https://www.hemnet.se/bostad/21515785) | ☐ |
| 39 | [Jungfruplatsen 1A](https://www.booli.se/bostad/803548) | [hemnet 21723959](https://www.hemnet.se/bostad/21723959) | 43148 ✓ | [B](https://www.booli.se/bostad/803548) / [H](https://www.hemnet.se/bostad/21723959) | ☐ |
| 40 | [Hjärtstocksvägen 4](https://www.booli.se/bostad/3711679) | [hemnet 21538187](https://www.hemnet.se/bostad/21538187) | 13953 ✓ | [B](https://www.booli.se/bostad/3711679) / [H](https://www.hemnet.se/bostad/21538187) | ☐ |
| 41 | [Smögengatan 24](https://www.booli.se/annons/5695180) | [hemnet 21722813](https://www.hemnet.se/bostad/21722813) | 41674 ✓ | [B](https://www.booli.se/annons/5695180) / [H](https://www.hemnet.se/bostad/21722813) | ☐ |
| 42 | [Fannydalsbacken 7](https://www.booli.se/bostad/2111326) | [hemnet 21721885](https://www.hemnet.se/bostad/21721885) | 13141 ✓ | [B](https://www.booli.se/bostad/2111326) / [H](https://www.hemnet.se/bostad/21721885) | ☐ |
| 43 | [Ragnvallagatan 32B](https://www.booli.se/annons/5719646) | [hemnet 21723270](https://www.hemnet.se/bostad/21723270) | 25663 ✓ | [B](https://www.booli.se/annons/5719646) / [H](https://www.hemnet.se/bostad/21723270) | ☐ |
| 44 | [Nolsjövägen 28](https://www.booli.se/bostad/3630311) | [hemnet 21542313](https://www.hemnet.se/bostad/21542313) | 18495 ✓ | [B](https://www.booli.se/bostad/3630311) / [H](https://www.hemnet.se/bostad/21542313) | ☐ |
| 45 | [Lövtorpsvägen 35](https://www.booli.se/bostad/2543210) | [hemnet 21542563](https://www.hemnet.se/bostad/21542563) | 13974 ✓ | [B](https://www.booli.se/bostad/2543210) / [H](https://www.hemnet.se/bostad/21542563) | ☐ |
| 46 | [Karlsrovägen 13](https://www.booli.se/bostad/3729096) | [hemnet 21545313](https://www.hemnet.se/bostad/21545313) | 18253 ✓ | [B](https://www.booli.se/bostad/3729096) / [H](https://www.hemnet.se/bostad/21545313) | ☐ |
| 47 | [Tjärvägen 3](https://www.booli.se/bostad/2513818) | [hemnet 21565546](https://www.hemnet.se/bostad/21565546) | 19467 ✓ | [B](https://www.booli.se/bostad/2513818) / [H](https://www.hemnet.se/bostad/21565546) | ☐ |
| 48 | [Munkebäcksgatan 8](https://www.booli.se/annons/5773984) | [hemnet 21621620](https://www.hemnet.se/bostad/21621620) | 41653 ✓ | [B](https://www.booli.se/annons/5773984) / [H](https://www.hemnet.se/bostad/21621620) | ☐ |
| 49 | [Sunnanbyn 16](https://www.booli.se/bostad/1929555) | [hemnet 21627933](https://www.hemnet.se/bostad/21627933) | 50494 ✓ | [B](https://www.booli.se/bostad/1929555) / [H](https://www.hemnet.se/bostad/21627933) | ☐ |
| 50 | [Alsnäset 1](https://www.booli.se/bostad/3752674) | [hemnet 21573363](https://www.hemnet.se/bostad/21573363) | 14891 ✓ | [B](https://www.booli.se/bostad/3752674) / [H](https://www.hemnet.se/bostad/21573363) | ☐ |
| 51 | [Arvid Lindmansgatan 19D](https://www.booli.se/bostad/30918) | [hemnet 21585950](https://www.hemnet.se/bostad/21585950) | 41726 ✓ | [B](https://www.booli.se/bostad/30918) / [H](https://www.hemnet.se/bostad/21585950) | ☐ |
| 52 | [Backvägen 7](https://www.booli.se/bostad/4091492) | [hemnet 21583101](https://www.hemnet.se/bostad/21583101) | 16955 ✓ | [B](https://www.booli.se/bostad/4091492) / [H](https://www.hemnet.se/bostad/21583101) | ☐ |
| 53 | [Jenny Linds gata 10](https://www.booli.se/annons/5808726) | [hemnet 21594651](https://www.hemnet.se/bostad/21594651) | 12952 ✓ | [B](https://www.booli.se/annons/5808726) / [H](https://www.hemnet.se/bostad/21594651) | ☐ |
| 54 | [Humanistgatan 6B](https://www.booli.se/annons/5808956) | [hemnet 21721476](https://www.hemnet.se/bostad/21721476) | 21456 ✓ | [B](https://www.booli.se/annons/5808956) / [H](https://www.hemnet.se/bostad/21721476) | ☐ |
| 55 | [Vinkelvägen 3B](https://www.booli.se/bostad/2000713) | [hemnet 21721511](https://www.hemnet.se/bostad/21721511) | 74141 ✓ | [B](https://www.booli.se/bostad/2000713) / [H](https://www.hemnet.se/bostad/21721511) | ☐ |
| 56 | [Kyrkogatan 10](https://www.booli.se/bostad/2629559) | [hemnet 21722454](https://www.hemnet.se/bostad/21722454) | 26633 ✓ | [B](https://www.booli.se/bostad/2629559) / [H](https://www.hemnet.se/bostad/21722454) | ☐ |
| 57 | [Broddstigen 17](https://www.booli.se/bostad/1521556) | [hemnet 21722216](https://www.hemnet.se/bostad/21722216) | 18494 ✓ | [B](https://www.booli.se/bostad/1521556) / [H](https://www.hemnet.se/bostad/21722216) | ☐ |
| 58 | [Trudvangsvägen 5](https://www.booli.se/bostad/1968674) | [hemnet 21604866](https://www.hemnet.se/bostad/21604866) | 18263 ✓ | [B](https://www.booli.se/bostad/1968674) / [H](https://www.hemnet.se/bostad/21604866) | ☐ |
| 59 | [Redargatan 3](https://www.booli.se/bostad/704719) | [hemnet 21598991](https://www.hemnet.se/bostad/21598991) | 12061 ✓ | [B](https://www.booli.se/bostad/704719) / [H](https://www.hemnet.se/bostad/21598991) | ☐ |
| 60 | [Bellevuevägen 4B](https://www.booli.se/annons/5843388) | [hemnet 21615280](https://www.hemnet.se/bostad/21615280) | 21772 ✓ | [B](https://www.booli.se/annons/5843388) / [H](https://www.hemnet.se/bostad/21615280) | ☐ |
| 61 | [Kopparvägen 30](https://www.booli.se/bostad/2492387) | [hemnet 21609722](https://www.hemnet.se/bostad/21609722) | 18744 ✓ | [B](https://www.booli.se/bostad/2492387) / [H](https://www.hemnet.se/bostad/21609722) | ☐ |
| 62 | [Åreparksvägen 2](https://www.booli.se/bostad/3642493) | [hemnet 21613869](https://www.hemnet.se/bostad/21613869) | 18460 ✓ | [B](https://www.booli.se/bostad/3642493) / [H](https://www.hemnet.se/bostad/21613869) | ☐ |
| 63 | [Banmästargatan 8](https://www.booli.se/annons/5863089) | [hemnet 21722485](https://www.hemnet.se/bostad/21722485) | 17067 ✓ | [B](https://www.booli.se/annons/5863089) / [H](https://www.hemnet.se/bostad/21722485) | ☐ |

## Unmatched — Hemnet returned 0 cards (1, 0.5%)
Open the **Search URL** to verify Hemnet really has nothing matching that price/rooms/item_type combo.
| Booli | Muni | Filters | Search URL |
|-------|------|---------|------------|
| [Ligusterstigen 35](https://www.booli.se/annons/5830879) | Haninge | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17928&price_min=712500&price_max=787500&rooms_min=1&rooms_max=1&item_types%5B%5D=fritidshus) |

## Unmatched — cards returned but no street/date match (69, 34.5%)
Open the **Search URL**; if any card looks like the same property, the cardMatches predicate is rejecting valid matches.
| Booli | Muni | Cards seen | Filters | Search URL |
|-------|------|-----------:|---------|------------|
| [Bärkingeplan 16](https://www.booli.se/bostad/417862) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=1610250&price_max=1779750&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Rondellen 4](https://www.booli.se/annons/3977345) | Järfälla | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17951&price_min=1230250&price_max=1359750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Elgentorpsvägen 20](https://www.booli.se/annons/4529738) | Botkyrka | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17885&price_min=2085250&price_max=2304750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Torgny Segerstedts Allé 11D](https://www.booli.se/annons/4629595) | Uppsala | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17800&price_min=1662500&price_max=1837500&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Ljungabrovägen 141](https://www.booli.se/bostad/2755425) | Ystad | 49 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17824&price_min=4275000&price_max=4725000&rooms_min=7&rooms_max=7&item_types%5B%5D=villa) |
| [Vadarevägen 38](https://www.booli.se/bostad/3280466) | Trollhättan | 28 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17790&price_min=3035250&price_max=3354750&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Saxofongatan 3](https://www.booli.se/annons/4744608) | Göteborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=1795500&price_max=1984500&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Hägerneholmsvägen 8A](https://www.booli.se/bostad/4190443) | Täby | 50 | price | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17793&price_min=1515250&price_max=1674750) |
| [Strand 9](https://www.booli.se/bostad/2144407) | Strömstad | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18034&price_min=3225250&price_max=3564750&rooms_min=4&rooms_max=4&item_types%5B%5D=villa) |
| [Citronfjärilvägen 6](https://www.booli.se/bostad/3455428) | Stenungsund | 19 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18030&price_min=3325000&price_max=3675000&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Murarevägen 7](https://www.booli.se/bostad/1777810) | Staffanstorp | 44 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18053&price_min=3800000&price_max=4200000&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Tunhemsvägen 19](https://www.booli.se/bostad/1972853) | Trollhättan | 50 | price | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17790&price_min=3035250&price_max=3354750) |
| [Köpenhamnsgatan 20](https://www.booli.se/bostad/651490) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=1705250&price_max=1884750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Örsholmsgången 4B](https://www.booli.se/bostad/7803) | Malmö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17989&price_min=1515250&price_max=1674750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Ararp 5](https://www.booli.se/bostad/3747923) | Svenljunga | 10 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18039&price_min=1140000&price_max=1260000&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Ararp 5](https://www.booli.se/annons/5372422) | Svenljunga | 12 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18039&price_min=2351250&price_max=2598750&rooms_min=5&rooms_max=5&item_types%5B%5D=gard) |
| [Thorburnsgatan 8C](https://www.booli.se/bostad/3938708) | Göteborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=2137500&price_max=2362500&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Hamngatan 11A](https://www.booli.se/annons/5411455) | Sundbyberg | 50 | rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18042&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Karlbergsvägen 32A](https://www.booli.se/annons/5435257) | Stockholm | 50 | rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&rooms_min=9&rooms_max=9&item_types%5B%5D=bostadsratt) |
| [Briljantgatan 86](https://www.booli.se/bostad/667149) | Göteborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=1900000&price_max=2100000&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Adress saknas](https://www.booli.se/annons/5439177) | Kungälv | 10 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17973&price_min=945250&price_max=1044750&item_types%5B%5D=tomt) |
| [Borgarfjordsgatan 21B](https://www.booli.se/bostad/3997521) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=2085250&price_max=2304750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Västgötagatan 12](https://www.booli.se/bostad/2616695) | Åstorp | 25 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17830&price_min=2180250&price_max=2409750&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Ekfatsgatan 3](https://www.booli.se/bostad/4196135) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=6170250&price_max=6819750&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Tältvägen 10](https://www.booli.se/bostad/1976693) | Båstad | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17890&price_min=5980250&price_max=6609750&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Tunnlandsvägen 71](https://www.booli.se/bostad/776178) | Stockholm | 51 | rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Majorsgatan 16](https://www.booli.se/annons/5534089) | Malmö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17989&price_min=2750250&price_max=3039750&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Flintebergsvägen 4](https://www.booli.se/annons/5538145) | Lysekil | 5 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17849&price_min=4275000&price_max=4725000&item_types%5B%5D=tomt) |
| [Gröna gatan 3C](https://www.booli.se/bostad/241478) | Uppsala | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17800&price_min=1472500&price_max=1627500&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Lappalund 20](https://www.booli.se/annons/5542575) | Nynäshamn | 50 | price | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18006&price_min=4655000&price_max=5145000) |
| [Engelbrektsvägen 145](https://www.booli.se/bostad/4210702) | Vallentuna | 50 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17804&price_min=1995000&price_max=2205000&item_types%5B%5D=bostadsratt) |
| [Berghemsvägen 75](https://www.booli.se/bostad/1491776) | Nacka | 32 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17853&price_min=22800000&price_max=25200000&rooms_min=6&rooms_max=6&item_types%5B%5D=villa) |
| [Lackerargränd 11](https://www.booli.se/annons/5604880) | Huddinge | 50 | rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17936&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Åkervägen 12](https://www.booli.se/bostad/464140) | Haninge | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17928&price_min=1254000&price_max=1386000&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Monsungatan 34](https://www.booli.se/bostad/566915) | Göteborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=2370250&price_max=2619750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Ölmevägen 10](https://www.booli.se/bostad/797808) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=2802500&price_max=3097500&rooms_min=3&rooms_max=3&item_types%5B%5D=bostadsratt) |
| [Hanåsvägen 44](https://www.booli.se/bostad/2159009) | Hässleholm | 25 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17945&price_min=945250&price_max=1044750&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Aspviks Alléväg 2B](https://www.booli.se/bostad/4400605) | Värmdö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17818&price_min=5700000&price_max=6300000&rooms_min=3&rooms_max=3&item_types%5B%5D=villa) |
| [Per Albin Hanssons väg 56B](https://www.booli.se/bostad/3657) | Malmö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17989&price_min=755250&price_max=834750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Tenorgatan 8](https://www.booli.se/annons/5665601) | Göteborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=1895250&price_max=2094750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Simris Bygata 23](https://www.booli.se/bostad/1868913) | Simrishamn | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18021&price_min=3515000&price_max=3885000&rooms_min=7&rooms_max=7&item_types%5B%5D=villa) |
| [Skagafjordsgatan 14](https://www.booli.se/annons/5686382) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=2845250&price_max=3144750&rooms_min=4&rooms_max=4&item_types%5B%5D=bostadsratt) |
| [Rudeboksvägen 812](https://www.booli.se/annons/5690852) | Lund | 50 | price | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17987&price_min=2085250&price_max=2304750) |
| [Erik Dahlbergs gata 43](https://www.booli.se/bostad/3993187) | Helsingborg | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17932&price_min=1021250&price_max=1128750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Krokstigen 5](https://www.booli.se/bostad/3287703) | Trollhättan | 26 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17790&price_min=2826250&price_max=3123750&rooms_min=6&rooms_max=6&item_types%5B%5D=radhus) |
| [Symfonigatan 23E](https://www.booli.se/annons/5698803) | Borås | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17884&price_min=1353750&price_max=1496250&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Kulpetorpsvägen](https://www.booli.se/annons/5699147) | Kungälv | 23 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17973&price_min=1705250&price_max=1884750&item_types%5B%5D=tomt) |
| [Gamla Huddingevägen 439A](https://www.booli.se/annons/5722437) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=1800250&price_max=1989750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Styrbordsgatan 11](https://www.booli.se/bostad/3264322) | Göteborg | 11 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17920&price_min=31160000&price_max=34440000&rooms_min=9&rooms_max=9&item_types%5B%5D=villa) |
| [Brattåsvägen](https://www.booli.se/annons/5750447) | Ale | 9 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17865&price_min=1610250&price_max=1779750&item_types%5B%5D=tomt) |
| [Vittrornas väg 36](https://www.booli.se/bostad/4493510) | Ale | 22 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17865&price_min=2945000&price_max=3255000&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Kullavägen 40](https://www.booli.se/bostad/3420877) | Mark | 39 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18046&price_min=2660000&price_max=2940000&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Kvarnvägen 38C](https://www.booli.se/bostad/4104311) | Järfälla | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17951&price_min=2465250&price_max=2724750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Vattenverksvägen 36A](https://www.booli.se/bostad/12220) | Malmö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17989&price_min=755250&price_max=834750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Plogvägen 16](https://www.booli.se/bostad/3355852) | Borås | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17884&price_min=2470000&price_max=2730000&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Nunnegårdsgatan 118](https://www.booli.se/annons/5794315) | Kungälv | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17973&price_min=1515250&price_max=1674750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Neptunigatan 48](https://www.booli.se/bostad/4268588) | Malmö | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17989&price_min=2560250&price_max=2829750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Alfavägen 22](https://www.booli.se/bostad/2575274) | Hässleholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17945&price_min=2275250&price_max=2514750&rooms_min=5&rooms_max=5&item_types%5B%5D=villa) |
| [Villa Backa 1](https://www.booli.se/annons/5809334) | Höör | 1 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17949&price_min=16625000&price_max=18375000&rooms_min=19&rooms_max=19&item_types%5B%5D=villa) |
| [Keramikens väg 25B](https://www.booli.se/bostad/4525553) | Sigtuna | 45 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18020&price_min=3035250&price_max=3354750&rooms_min=4&rooms_max=4&item_types%5B%5D=radhus) |
| [Kungsklippan 12](https://www.booli.se/bostad/353380) | Stockholm | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18031&price_min=3605250&price_max=3984750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Gåsörtsvägen 10](https://www.booli.se/bostad/1620525) | Sundbyberg | 10 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18042&price_min=7837500&price_max=8662500&rooms_min=6&rooms_max=6&item_types%5B%5D=radhus) |
| [Näsbydalsvägen 16](https://www.booli.se/bostad/690620) | Täby | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17793&price_min=1610250&price_max=1779750&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |
| [Stamhusvägen 1](https://www.booli.se/bostad/4238264) | Lerum | 47 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17979&price_min=2945000&price_max=3255000&rooms_min=4&rooms_max=4&item_types%5B%5D=bostadsratt) |
| [Sanatorievägen 4](https://www.booli.se/bostad/2641802) | Ängelholm | 22 | price,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17835&price_min=12302500&price_max=13597500&item_types%5B%5D=villa) |
| [Östanå Kolgården 1](https://www.booli.se/bostad/3852864) | Österåker | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17769&price_min=7837500&price_max=8662500&rooms_min=4&rooms_max=4&item_types%5B%5D=villa) |
| [Vigelsjövägen 6C](https://www.booli.se/annons/5848665) | Norrtälje | 50 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=18003&price_min=1230250&price_max=1359750&rooms_min=2&rooms_max=2&item_types%5B%5D=bostadsratt) |
| [Masthuggarvägen 7](https://www.booli.se/bostad/4079503) | Upplands Väsby | 50 | rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17798&rooms_min=8&rooms_max=8&item_types%5B%5D=villa) |
| [Boställsgatan 2E](https://www.booli.se/bostad/387171) | Hässleholm | 2 | price,rooms,item_type | [search](https://www.hemnet.se/bostader?location_ids%5B%5D=17945&price_min=123500&price_max=136500&rooms_min=1&rooms_max=1&item_types%5B%5D=bostadsratt) |

## Postcode mismatches (20, 10.0%)
| Booli | Booli postcode | Hemnet postcode | Hemnet |
|-------|----------------|-----------------|--------|
| [booli 3640248](https://www.booli.se/bostad/4193272) | 17738 | 17744 | [hemnet 16398461](https://www.hemnet.se/bostad/16398461) |
| [booli 4475672](https://www.booli.se/annons/4475672) | 13172 | 13173 | [hemnet 18145576](https://www.hemnet.se/bostad/18145576) |
| [booli 4513425](https://www.booli.se/annons/4513425) | 19162 | 19164 | [hemnet 18265377](https://www.hemnet.se/bostad/18265377) |
| [booli 4943362](https://www.booli.se/bostad/4240873) | 42146 | 42151 | [hemnet 21377033](https://www.hemnet.se/bostad/21377033) |
| [booli 5058406](https://www.booli.se/annons/5058406) | 15257 | 15259 | [hemnet 20334255](https://www.hemnet.se/bostad/20334255) |
| [booli 5066692](https://www.booli.se/bostad/4104903) | 13835 | 13839 | [hemnet 21349545](https://www.hemnet.se/bostad/21349545) |
| [booli 5102229](https://www.booli.se/bostad/4313936) | 13141 | 13157 | [hemnet 20588041](https://www.hemnet.se/bostad/20588041) |
| [booli 5152887](https://www.booli.se/annons/5152887) | 75267 | 75269 | [hemnet 21701434](https://www.hemnet.se/bostad/21701434) |
| [booli 5268504](https://www.booli.se/bostad/89843) | 21745 | 21746 | [hemnet 21297527](https://www.hemnet.se/bostad/21297527) |
| [booli 5561549](https://www.booli.se/bostad/2787022) | 24036 | 24175 | [hemnet 21465813](https://www.hemnet.se/bostad/21465813) |
| [booli 5573448](https://www.booli.se/bostad/4398706) | 17266 | 17261 | [hemnet 21493323](https://www.hemnet.se/bostad/21493323) |
| [booli 5613171](https://www.booli.se/bostad/4389563) | 41507 | 41574 | [hemnet 21495519](https://www.hemnet.se/bostad/21495519) |
| [booli 5671184](https://www.booli.se/annons/5671184) | 75651 | 75659 | [hemnet 21513325](https://www.hemnet.se/bostad/21513325) |
| [booli 5741865](https://www.booli.se/bostad/1689623) | 15021 | 15396 | [hemnet 21553262](https://www.hemnet.se/bostad/21553262) |
| [booli 5742268](https://www.booli.se/bostad/4098151) | 13430 | 13442 | [hemnet 21553654](https://www.hemnet.se/bostad/21553654) |
| [booli 5771423](https://www.booli.se/annons/5771423) | 16346 | 16345 | [hemnet 21681116](https://www.hemnet.se/bostad/21681116) |
| [booli 5781371](https://www.booli.se/bostad/4370868) | 41528 | 41526 | [hemnet 21721696](https://www.hemnet.se/bostad/21721696) |
| [booli 5788391](https://www.booli.se/bostad/88687) | 54140 | 54950 | [hemnet 21598655](https://www.hemnet.se/bostad/21598655) |
| [booli 5809122](https://www.booli.se/bostad/2430088) | 29037 | 29156 | [hemnet 21722468](https://www.hemnet.se/bostad/21722468) |
| [booli 5860542](https://www.booli.se/annons/5860542) | 25668 | 25671 | [hemnet 21721402](https://www.hemnet.se/bostad/21721402) |

## perCounty
| County | Booli rows | Matched | Inserted | Errors |
|--------|-----------:|--------:|---------:|-------:|

## perMuni (top 25 by booli rows)
| Muni | Booli rows | Matched | Inserted | Pages exhausted |
|------|-----------:|--------:|---------:|:---------------:|
| Stockholm | 0 | 0 | 0 |  |
| Järfälla | 0 | 0 | 0 |  |
| Solna | 0 | 0 | 0 |  |
| Nacka | 0 | 0 | 0 |  |
| Göteborg | 0 | 0 | 0 |  |
| Sollentuna | 0 | 0 | 0 |  |
| Botkyrka | 0 | 0 | 0 |  |
| Uppsala | 0 | 0 | 0 |  |
| Ystad | 0 | 0 | 0 |  |
| Trollhättan | 0 | 0 | 0 |  |
| Osby | 0 | 0 | 0 |  |
| Täby | 0 | 0 | 0 |  |
| Södertälje | 0 | 0 | 0 |  |
| Hässleholm | 0 | 0 | 0 |  |
| Strömstad | 0 | 0 | 0 |  |
| Värmdö | 0 | 0 | 0 |  |
| Stenungsund | 0 | 0 | 0 |  |
| Helsingborg | 0 | 0 | 0 |  |
| Staffanstorp | 0 | 0 | 0 |  |
| Malmö | 0 | 0 | 0 |  |
| Upplands-Bro | 0 | 0 | 0 |  |
| Norrtälje | 0 | 0 | 0 |  |
| Svenljunga | 0 | 0 | 0 |  |
| Eslöv | 0 | 0 | 0 |  |
| Sundbyberg | 0 | 0 | 0 |  |
