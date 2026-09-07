# Building a Karnataka-wide transit dataset without hitting operator booking APIs

Scope: KSRTC (intercity), KKRTC (formerly NEKRTC, Kalyana Karnataka), NWKRTC (North West Karnataka). BMTC and BMRCL are already solved. Every claim below is tagged `[V]` (I loaded the source directly and read it), `[S]` (secondary — a search snippet or another agent's report I did not independently open), or `[I]` (my inference from the above). Six research passes fed this — the original per-topic sweep plus a second, wider sweep the owner explicitly authorized mid-task to include inaccurate third-party and community material as an acceptable starting specimen.

## The single best source found

**World Bank, K-BREEZE project appraisal (P517113), "Initial Environmental and Social Review Summary," dated 19 May 2026** `[V — fetched and read the full 8-page PDF]`. This is a *live* World Bank operation not yet at board (estimated board date 18 Nov 2026), explicitly covering KSRTC, NWKRTC, and KKRTC together. It states the three RTCs jointly run **~19,000 buses** on rural/intercity/interstate routes (BMTC's ~7,000 urban buses are separate), and names **"fragmented institutional systems and weak data integration"** as a barrier the project is funded to fix, alongside digitalization/planning-system upgrades. It is the most current, most authoritative document touching this problem, and it is direct evidence for the report's central finding: no unified route dataset exists at the institutional level today, and the state's own current World Bank-funded project treats *building one* as an open reform goal, not a solved problem.

Runner-up: **NWKRTC's Annual Administration Report series**, nwkrtc.karnataka.gov.in, nine consecutive years (2016-17 to 2024-25) at stable URLs `[V — fetched the 2019-20 report directly, read pp.1-11 of 100]`. Its "Progress at Glance" table gives a real nine-year time series of routes (4,090 in 2019-20), route-km (3.70 lakh/day), interstate routes (322), fleet (5,080), schedules (4,661), depots (51), divisions (9), bus stations (177). This is aggregate, not a timetable, but it is the strongest and most current statistical anchor of the three operators.

## Chigari BRTS — recommendation

**Leave it out of the first Karnataka-wide pass.** It is run by a separate legal entity (Hubballi-Dharwad BRTS Company Ltd, an SPV — GoK 70%, HDMC/NWKRTC/HDUDA 30%) `[V]`, on a single 22.25 km corridor with 32 stations `[V]`, with its own closed smart-card ticketing and a dedicated "Chigari" app `[V]` and no public GTFS feed anywhere checked (Mobility Database included) `[V]`. It shares almost no operational surface with ordinary NWKRTC service beyond one small feeder pilot ("Chigari Samparka," Dec 2022) `[V]`. At roughly 100 buses against NWKRTC's ~5,000-bus fleet, it is about 2% of the state's non-BMTC bus scale `[I]`, structurally a one-city BRT rather than an intercity link, and — contrary to the hope that a modern BRT would have better open data — it turned out to have *worse* data availability than the ordinary intercity network: a closed ITS stack with real-time tracking that isn't exposed publicly `[V]`. Including it buys a separate schema, a separate fare model, and a separate real-time source for a sliver of coverage. Recommend deferring it to a later pass, if ever.

---

## 1. Operator-published static timetables

**Verdict: none of the three operators publishes a route-by-route static timetable (origin, destination, via points, departure/arrival times, class, fare, distance) anywhere on their public sites.** What exists instead:

| Operator | What's public | Fields | Currency |
|---|---|---|---|
| KSRTC | `ksrtc.in` is the live AWATAR booking widget; `ksrtc.in/pages/annual-administration-report.html` links only an FAQ PDF and points to `ksrtc.karnataka.gov.in`, which could not be confirmed to host anything further `[V — loaded, low confidence on the redirect target]` | none — no downloadable route list found | n/a |
| KKRTC | `kkrtc.karnataka.gov.in` nav lists "Annual Accounts and Audit Reports" (2017-18, 2018-19) and a separate "Administrative Reports" page that contains zero actual documents, just boilerplate `[V — both pages loaded]` | none | stale (audit reports two years, no route data) |
| NWKRTC | `nwkrtc.karnataka.gov.in` administration-report index lists nine full annual reports 2016-17 through 2024-25 at stable named URLs `[V]` | aggregate stats only (routes, route-km, fleet, depots) per the 2019-20 report read in full — no per-route schedule | current (2024-25 report present) |

Wayback Machine CDX queries against all four domain forms (`ksrtc.in`, `nwkrtc.in`, `kkrtc.in`, `nekrtc.karnataka.gov.in`) confirm no usable historical timetable ever got crawled `[V — CDX API queried directly]`. ksrtc.in did once have `/site/timetable.html` (2011) and `/pages/timetable.html` (2016), but both render as static shells whose actual schedule content loaded via JS/AJAX that Wayback never captured — one literally reads "Click the below tab to get more details" with no tab content behind it. The other three domains have zero URLs matching "route," "schedule," or "timetable" in Wayback's index at all — not stale, never crawled.

No route-master, Government Resolution, or RTI-disclosed document was found for any of the three operators `[V — dedicated search effort]`.

## 2. Government and open-data sources

- **data.gov.in "KSRTC Operational results statistics"** `[V — fetched and parsed the HTML myself]`: monthly physical + financial operational parameters, published by Karnataka Transport Department/KSRTC, first published 13 Jan 2022, portal-updated 8 Jul 2026 (this year — actively maintained as a listing). Aggregate only — no per-route rows.
- **data.gov.in "Transport Services Offered by KSRTC"** → resource "Divisionwise Route and route kms as on 31-03-2021" `[V — fetched and parsed]`: keywords confirm "Route," "Route Length" — division-level route counts and total route-km, snapshot dated 31-03-2021 (over five years stale relative to today), not a per-route timetable. The catalog page itself shows a 2026 "Updated On" stamp, but that's portal metadata, not new data.
- **data.gov.in "nwkrtc-division-wise-route-details"**, fields Sl no/From/To/Route Length, updated 20/07/2024 `[S — found via search, WebFetch got 403 on both the catalog and its linked resource]`. Same tier as the KSRTC one: from-to and length, not a timetable.
- **DULT** (Directorate of Urban Land Transport): confirmed out of scope — its public-transport mandate is the 16-city urban "Nagara Sarige" program, not intercity RTC service `[S]`.
- **World Bank, "Open Transport Data Assessment in Mysore"** (~2016-17, author Daniel Rudmark) `[V — opened, read ~10 of 46 pages]`: confirms KSRTC's Mysore City Transport Division (≈400 buses, 3 depots) generates GPS/AVL data via its ITS, that no open-data platform existed in Karnataka at the time, that a 2016 "appathon" briefly exposed some of it, and recommends KSRTC publish GTFS/GTFS-RT. Scope is Mysore *city* buses only, not the intercity network, and nine years later there's no evidence the recommendation was acted on.
- **World Bank K-BREEZE** — see above; the strongest and most current document found.
- No ADB or GIZ document with route-level Karnataka data was found `[V — search effort]`. Karnataka e-procurement tender search turned up no ITS/GPS scope-of-work document naming route counts `[V]`.

## 3. OpenStreetMap

Live Overpass queries against a Karnataka bounding box, run this session `[V]`:

- `amenity=bus_station` nodes statewide: **171**. A real but thin skeleton against a state with hundreds of taluks.
- `route=bus` relations in the bbox: **944 total, 853 (90%) tagged `network=BMTC`** — the already-solved Bengaluru network. Only **4** carry `network=KSRTC`, **6** carry `operator=KSRTC`. **Zero** relations exist for `NWKRTC`, `NEKRTC`, or `KKRTC` as a network value.
- Of those 4-6 KSRTC relations: two are Mysore *city* routes, two are isolated Raichur-district rural routes, one crosses into Kerala. **Exactly one** ("Pavagada ⇒ Bengaluru") is a genuine mapped intercity KSRTC corridor. That is the entire OSM inventory of intercity route topology for the state.
- taginfo, queried live via its API `[V]`: `network=NWKRTC` appears **once** worldwide; `NEKRTC` never appears as a network value; `KKRTC` (the current name) has **zero** occurrences in any tag. "KSRTC" gets 506 hits, but most belong to Kerala's identically-named KSRTC — an acronym collision that inflates the apparent count.
- No OSM WikiProject organizes Karnataka intercity mapping; the one Bengaluru-bus wiki page explicitly stops at city limits.

**Assessment:** the Bengaluru-metro precedent (a handful of lines a small community hand-completed) does not transfer. KSRTC/NWKRTC/KKRTC run on the order of thousands of routes; organized OSM mapping never reached them. Overpass yields a sparse, real point-location skeleton — 171 bus-station nodes, plus more scattered `highway=bus_stop` nodes if queried — usable for geocoding depot/stand locations, but route-relation coverage is not incomplete, it is effectively absent (1 real corridor vs. 853 fully-mapped BMTC relations).

## 4. Community and third-party datasets

- **Vonter's other repositories** `[V — fetched github.com/Vonter's repo list directly]`: `bmtc-gtfs`, `bmrcl-gtfs`, `transitrouter`, `namma-metro-navigator`, `orr-bus`, `transit-affinity` — every one Bengaluru-scoped. Nothing for any of the three intercity operators. **No equivalent of `Vonter/bmtc-gtfs` exists for KSRTC, NWKRTC, or KKRTC** — checked across GitHub/Kaggle search, transit.land, TransitFeeds/Mobility Database, and Hugging Face `[V]`.
- **github.com/rabilrbl/ksrtc-api** `[V — fetched the repo]`: a small Go wrapper against ksrtc.in's own live endpoints (`/all` for place codes, `/bus` for route/schedule search by date). Its hosted instance is dead, but the source shows the exact request shape KSRTC's backend expects — a scraper blueprint, KSRTC-only, unofficial, could break anytime.
- **Datameet's GitHub org** `[V — pulled the full repo list via the API]`: no Karnataka intercity work beyond BMTC/OpenBangalore-adjacent efforts.
- **OpenCity's data portal** `[V — fetched]`: returns "No datasets found" for transport.
- **Chalo**: confirmed contract is with **Kerala's** KSRTC, not Karnataka's, plus a separate 2026 Bengaluru-BMTC ticketing contract `[V — opened a news article confirming the Kerala KSRTC deal]`. No evidence of any Karnataka-RTC feed or public API.
- **Google Maps / Moovit**: no confirmed Transit Partner feed or Mobility Database listing for any Karnataka RTC; Moovit's own "KSRTC, Bengaluru" schedule page couldn't be opened to verify its source `[S/unverified]`. Absence of evidence, not evidence of absence — Google doesn't publish its partner list.
- **Academic**: CiSTUP/IISc network-structure papers (arXiv 1512.05909, 1509.04554) study *urban* bus networks (BMTC-type), not intercity KSRTC; no linked dataset found `[S]`. TERI, WRI India, ITDP India publications mention Karnataka RTCs narratively (WRI's "Bus Karo" cites NEKRTC's 4,295 buses/1M daily trips) but ship no dataset `[S]`. ITDP/WRI's brtdata.org covers only Hubballi-Dharwad BRTS, not the intercity network `[S]`.
- **Kaggle / Hugging Face**: nothing relevant beyond Bengaluru- and Pune-specific transit datasets `[V — searched both directly]`.

### Widened sweep (owner-authorized second pass): aggregators, archives, and everything imperfect

The owner explicitly said privately-collected or inaccurate third-party data is an acceptable specimen base — this changes the answer from "nothing exists" to "plenty exists, none of it clean."

**Booking aggregators — the real find of this pass.** `[V unless noted]`
- **Redbus** has a dedicated KSRTC SEO hub, `redbus.in/online-booking/ksrtc-karnataka` (loaded via proxy after direct fetch timeouts): bus-class names (Airavat Club Class, Ambaari Dream Class, EV Power Plus), a route table, 179 named stations. Its real scale mechanism is per-route-per-operator static pages (`redbus.in/online-bus/bangalore-to-hampi-operator-sugama-travels-sugama`) carrying fare and duration per operator per corridor — confirmed to exist via search, not opened directly (timeouts). robots.txt is permissive on these paths — only search/payment/profile paths are disallowed, and the file explicitly *allows* GPTBot/PerplexityBot/Google-Extended/Bingbot.
- **AbhiBus** has a comparable KSRTC operator hub (`abhibus.com/operator/1476/KSRTC`, 403 direct, loaded via proxy) linking out to route pages; robots.txt has no restriction on operator or route paths.
- **Yatra**'s `yatra.com/bus-operators-india/ksrtc` page carries real bus-class names and one verbatim departure-time sentence for a specific corridor.
- **Goibibo** publishes a bus sitemap (`goibibo.com/bus/sitemap.xml`) and its robots.txt explicitly allows `/bus/getsearch/` — a strong crawlability signal, but no page content could be retrieved this session (timeouts/403s throughout).
- **Paytm**, **MakeMyTrip**, **Ixigo**: no Karnataka-specific route content confirmed this session (timeouts, 404s on guessed URLs, or generic inter-state-only "top routes" lists).

All of these carry fare bands, durations, operator/class names, and boarding points at the route level — real, observed, dense fields — but every one required a browser-like renderer (a plain fetcher stalls against anti-bot gating), none of it is a clean per-departure-time timetable at scale, and none of it was built to be machine-read: expect inconsistent formatting, missing fields, and staleness that has to be assumed rather than dated. **Ranking for a specimen build: Redbus first (richest fields, most permissive robots.txt for content paths), AbhiBus second (clean robots.txt, dedicated operator hub), Goibibo a plausible third pending a real browser-render pass.**

**Archive.org's Karnataka Gazette OCR corpus** (`in.gazette.karnataka*`, ~30,000 items; `in.gazette.karnataka_eo*`, ~6,500 items) is real, large, and full-text searchable via `archive.org/advancedsearch.php` `[V — pulled item metadata directly]`. Initial keyword probes ("stage carriage," "route permit," "Road Transport Authority") returned nothing — route permits may not be published at state-gazette level, or need Kannada search terms — so this is an unproven lead with a real, searchable corpus behind it, not a dead end.

**Scanned timetable books** on Scribd (Mysore KSRTC schedule, Bengaluru–Madikeri schedule) were found by search but not opened `[S]` — plausible real content, unknown vintage, single-corridor snapshots.

## 5. Chigari — see the top of this report.

## 6. The generation question: what real anchors exist

Nothing found supports a complete, honest timetable for the ~4,000+ combined routes of the three operators. What's real enough to anchor synthesis on:

- **Fleet and route counts by operator/division/depot**, from NWKRTC's nine annual reports and the K-BREEZE combined figure (~19,000 buses across the three RTCs) `[V]`.
- **Route-km per operator and interstate route counts**, same source `[V]`.
- **A "schedules" count** (4,661 for NWKRTC, 2019-20) that is effectively total daily trip-departures across the network — dividing it across known route counts gives a real, if coarse, average-frequency-per-route anchor `[I, built from V figures]`.
- **Real fare bands, durations, and operator/class names for major trunk corridors**, from redbus/abhibus/yatra pages — Bengaluru↔Hampi, ↔Mysore, ↔Hubballi/Dharwad, ↔Kalaburagi, ↔Chennai, ↔Hyderabad, plus the one OSM-mapped Pavagada↔Bengaluru corridor `[V]`.
- **Real stop/stand locations** for 171+ towns from OSM `[V]`.
- **The live query shape of KSRTC's own backend**, from `rabilrbl/ksrtc-api`'s source `[V]` — this is a meaningful distinction from what the owner ruled out: calling ksrtc.in/AWATAR *at request time* is out of scope, but the owner's own addendum accepts imperfect data built by a one-time or periodic *offline* harvest. A bulk, infrequent scrape done as a data-build step is a different thing from live per-request calls, and is worth surfacing to the owner explicitly as a policy question rather than deciding it here.

**Which corridors could be built to a genuinely high standard**, given the above: the major trunk routes with aggregator coverage and/or the single mapped OSM relation — Bengaluru to Mysore, Hampi, Hubballi-Dharwad, Kalaburagi, Chennai, Hyderabad, and similar high-traffic interstate/major-city pairs. These can carry real fare bands, real class names, and approximate real departure windows, sourced and dated.

**Everything else** — the bulk of the ~4,000+ routes, mostly taluk-to-taluk and rural services — would be synthesized from depot fleet counts, route distance, an assumed average speed (state/national highway intercity buses typically run 30-45 km/h `[I]`), and a frequency model derived from the schedules-per-route ratio above, with a plausible 05:00-23:00 operating window cross-checked against the handful of real departure-time anchors found. **This generated tier must be visibly marked as generated in the product** — Tatak's own honesty-contract precedent (per `docs/06-the-honesty-contract.md`, not read this session but referenced in the brief) argues strongly for the same treatment here.

## 7. Recommended shape

GTFS, riding `src/ingest/gtfs.ts` `[I]`. Specifics verified against the GTFS spec directly `[V — fetched gtfs.org reference pages]`:

- **Multi-day/overnight trips**: core GTFS already supports times past `24:00:00` for a service continuing into the next calendar day — confirmed in the spec. Tatak's own `src/ingest/gtfs.ts` (line ~195) already documents this but notes "this feed never does" for the current BMTC feed — meaning the *parsing* comment records awareness, but real intercity data would be the first feed to actually exercise hours ≥ 24, and that code path needs verification, not just documentation, before intercity data lands `[I]`.
- **Published headway rather than exact times**: `frequencies.txt` with `exact_times=0` fits a corridor whose only known fact is "runs every N hours," which is closer to what NWKRTC's aggregate schedules-count anchor actually supports than fabricated exact departure times would be.
- **Fare by boarding-point pair and service class**: GTFS-Fares v2 (`fare_products.txt`, `fare_leg_rules.txt` with `from_area_id`/`to_area_id`, `rider_categories.txt`, `networks.txt`) replaces the flat-route-fare assumption Tatak currently hand-codes for Bengaluru and can express origin-destination and zone-based fares directly — the natural fit for intercity fare-by-stage-and-class.
- **Reserved seating**: this is the one genuine gap. GTFS-Flex's `booking_rules.txt` (adopted March 2024, linked into `stop_times.txt` via `pickup_booking_rule_id`/`drop_off_booking_rule_id`) is built for demand-responsive/dial-a-ride discoverability, not for flagging "this scheduled fixed-route service requires an advance seat reservation" `[V for the spec, I for the fit assessment]`. There's no first-class GTFS field for that; it would have to ride on a `fare_product` attribute or a city-config convention analogous to how Tatak already infers `serviceTier` from route-name prefixes for BMTC.
- **Service classes** (Ordinary/Express/Airavat/Rajahamsa/Sleeper/AC) map naturally either to distinct `route_id`s per class (as BMTC's feed already does with prefix-encoded classes) or to `fare_products` with `rider_categories`, whichever keeps closer to the existing `serviceTierFromShortName` convention in `src/ingest/gtfs.ts`.

## Effort estimate

`[I]` — a range, not a point estimate, for one engineer building a first defensible statewide dataset covering the three new operators (Chigari excluded per the recommendation above):

| Phase | Days |
|---|---|
| Stop/corridor inventory (OSM stops + depot/taluk gazetteer) | 2-3 |
| Aggregator harvester (headless-browser-grade rendering against redbus/abhibus/goibibo, given anti-bot gating) | 4-6 |
| Ingest pipeline: harvested + annual-report rows → GTFS shape (stops/routes/trips/stop_times/frequencies/fares) | 5-7 |
| Synthesis engine for unharvested routes (fleet/route-km/speed/frequency model) + generated-data flagging in the product | 4-6 |
| GTFS-Fares v2 + service-class + reserved-seating convention wiring | 3-5 |
| Validation/QA gates (topology sanity checks analogous to `check-metro-topology.ts`) | 2-3 |
| **Total** | **20-30 engineer-days** |

Pushing more corridors from "generated" to "genuinely anchored" (deeper aggregator coverage, gazette-corpus mining, Scribd timetable extraction) would add on top of this rather than being required for a first, honestly-labeled release.
