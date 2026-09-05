# Reserved intercity coach seats: the inventory this provider owns

**Status:** build-ready specification. No code has been written yet.
**Audience:** an engineer who has read `SPEC.md` and `docs/passes.md`, and knows
this repository's two existing catalogue categories.
**Written:** 5 September 2026.

A single-journey ticket is a fare for a stop pair. A pass is a fare for a period
and a scope of service. A reserved intercity seat is neither: it is **one named
person, in one numbered seat, on one dated departure of one service, boarding at
one named point**. Nothing this provider sells today has a calendar, a seat, a
passenger name, a refund, or a finite quantity that another buyer can exhaust.
This category has all six, and that is what makes it a third catalogue axis
rather than a richer item under an existing one.

`SPEC.md` section 2.2 put `cancel`/`on_cancel`, refunds and "seat/quantity
inventory" out of scope for phase one, and section 9's fidelity table records
the consequence plainly: *"No inventory model. Every `select` succeeds. No
out-of-stock path."* This document closes all of that, for one category only.
The `TICKET` and `PASS` categories are untouched.

---

## 0. Sourcing, and what the labels mean

Every domain fact below carries the confidence label its research gave it, and
the labels are not decoration:

- **[V]** read against an official or primary source (ksrtc.in's own reservation
  terms, a Government of Karnataka page, a Wikipedia article with cited
  references, a GitHub repository loaded directly).
- **[S]** from a secondary source or a search-engine summary of one - aggregator
  pages, news reports, a route page whose direct fetch failed. Directionally
  reliable, not independently confirmed against a primary document.
- **[I]** an inference by the research author or by this document, marked as one.

The labels this specification inherits come from four research documents, now
vendored into this repository so that every claim below is checkable against a
path a reader has:

| Document | What this specification takes from it |
|---|---|
| [`docs/research/ksrtc-domain-research.md`](research/ksrtc-domain-research.md) | Service classes, the three corridors, reservation mechanics, cancellation slabs, concessions, the Shakti exclusions |
| [`docs/research/karnataka-data-acquisition.md`](research/karnataka-data-acquisition.md) | What data exists and what does not, and therefore what every provenance value in section 3.2 can honestly claim |
| [`docs/research/karnataka-network-scope.md`](research/karnataka-network-scope.md) | The four-corporation territorial split, the operating-corporation attribution gap and its settlement consequence in section 10, and the KSRTC/NWKRTC boundary the coastal corridor of section 10.5 crosses |
| [`docs/research/reservation-ux-study.md`](research/reservation-ux-study.md) | The hold mechanism and its real TTL (section 8.1), seat-map failure modes (section 5.2), boarding-point data quality (section 4), and what an incumbent e-ticket actually carries (section 9.1) |

Where two of them disagree, this document says which it followed and why. The
hold TTL in section 8.1 is the one place that matters: a confirmed five-minute
figure in the UX study against a looser 10-to-15-minute figure in the domain
research, and the confirmed one wins as evidence even though this document then
chooses a different number for a stated reason.

Where a figure below is used in a fixture, the fixture carries the same label in
a sibling field. A ₹495 fare marked [S] must not print in a demo as though an
operator had quoted it.

---

## 1. The three catalogue axes, and why this is the third

| | `TICKET` (`SJT`) | `PASS` | `RESERVED` |
|---|---|---|---|
| What is priced | A stop pair | A period and a scope of service | A boarding-point pair, a dated service instance, and a class |
| Search intent names | Two GPS points or two stop codes | A category, and no stops | An origin and destination town, a travel date, and optionally a class |
| Inventory | None. Every `select` succeeds | None. Nine static items, always sellable | Finite. Numbered seats, exhaustible, held |
| Quantity | 1-6 anonymous tickets | 1-6 anonymous credentials | One named passenger per named seat |
| Calendar | None. Valid for a duration from issue | A window anchored to the confirm date | A specific calendar date, chosen before search returns |
| Credential | A QR PNG per ticket | A rotating TOTP secret per credential | A booking reference and a manifest. No gate exists to scan anything |
| Cancellation | Not implemented | Not implemented | Two-step, with a real refund figure |
| Fare depends on | Route slice (fixture: whole-route flat) or the planner's paise | A derived multiple of a synthetic ceiling | A lookup table keyed by boarding pair and class |

**A reserved item's identity has to carry the date.** Two calendar dates of "the
same" KSRTC service are two entirely different sellable inventories, so
`item.id` is not the service - it is
`RSV-<serviceId>-<travelDate>-<classCode>`, for example
`RSV-2259BNGHMP-2026-09-25-PALLAKKI`. This is the single largest structural
difference from both existing categories, where an item id is stable across
every search forever. Tatak's own spec reaches the same conclusion from the
router side, requiring `RaptorLeg` to carry "the specific `serviceId`/date pair
it was priced against" for exactly this reason
(`docs/superpowers/specs/2026-09-05-karnataka-statewide-design.md`, section 3).

**A reserved order's fulfillment is not a `TRIP` and not a `PASS`.** It is a
`RESERVATION`, carrying the dated departure, the two chosen boarding points with
their own reporting times, the class, and the seats. Section 14 gives the shape.

### The precedent this follows

`docs/passes.md` is the closest thing in this repository to a template, and the
commit that produced it - "Sell transit passes on a second catalogue category" -
is the model for how this one should land. Its moves, in the order they matter:
a new search axis on vocabulary the domain already owns; a new fulfillment type
parallel to the existing one; a credential shaped to the product rather than
inherited from it; every invented number marked on the wire and disclosed in a
document that says how weakly it is sourced; and every extension of the domain's
vocabulary named as an extension rather than presented as a transcription.

This document does the same for a third category, with one difference that
changes the engineering rather than the writing: **passes added no state that
another buyer could exhaust.** Nine pass items are static constants, identical
for every buyer, resolvable without touching the per-transaction catalogue cache
(`src/trv11/pass.ts`, `passItemById`). A seat is the opposite: shared, finite,
and contended. Sections 8 and 15 are where that lands.

---

## 2. The domain string: `TRANSIT.LOCALHOST:INTERCITY`

**Settled, and stated as such.** This category is published under the domain
string `TRANSIT.LOCALHOST:INTERCITY`, version `0.1.0`. It is Beckn-shaped and it
does not claim ONDC conformance of any kind.

### Why not `ONDC:TRV12`

ONDC's mobility specification does carry a TRV12 domain covering airline and
intercity bus, on branches `release-TRV12-airline` and
`release-TRV12-intercity` (`SPEC.md` section 3.4, which tabulates the TRV domain
split). Its domain code is ruled out anyway.

The intercity bus half is **still in draft**. The Beckn/ONDC domain registry
lists TRV11 as released at 2.0.0 and TRV12 intercity as `draft-TRV12-intercity`
[S - search-summarised from `schema.beckn.io` indexing; the primary schema page
could not be re-fetched during the research, so this is reported rather than
independently confirmed]. `SPEC.md` section 1 already establishes that ONDC's
own resource pages lag their repository branches, so a branch name is not a
release.

**No state road transport corporation is a live ONDC participant for intercity
booking.** ONDC's public transport ticketing is real and large - metro in
Bengaluru, Chennai, Delhi, Kochi, Pune, Nagpur and all three Mumbai Metro lines,
intracity bus for DTC, CRUT, BEST and Katch Mobility, over 300,000 trips a day
[V - Business Standard, cited in `SPEC.md` as `[^ondc-300k]`] - and none of it is
intercity. KSRTC, NWKRTC and KKRTC appear in no live participant list found.

Publishing under `ONDC:TRV12` would therefore assert two things that are not
true: that this provider conforms to a released specification, and that it sits
in a namespace ONDC administers. This repository already refuses the second kind
of claim at the identity layer - subscriber IDs are `*.transit.localhost` under
RFC 6761's reserved name specifically so that nothing here "can collide with, or
be mistaken for, a real ONDC participant" (`SPEC.md` section 5.3). The domain
string gets the same treatment for the same reason.

### Why this string in particular

`TRANSIT.LOCALHOST` is the namespace half of the subscriber IDs this stack
already uses. Reusing it means the domain string cannot collide with an
ONDC-issued domain by the same mechanism that already prevents the subscriber IDs
from colliding: `.localhost` is reserved and unresolvable. `INTERCITY` names the
product. **The strings `ONDC` and `TRV12` appear nowhere in it**, so a grep for
either across a consuming codebase never returns a false positive from this
category.

Version `0.1.0` rather than a two-part number: a zero major says this is
pre-stable and locally owned, and it will not be mistaken for a TRV release
number the way `2.0.1` would be.

### The boundary is enforced by a test, not by discipline

Tatak's spec proposes a grep test asserting that the strings `ONDC` and `TRV12`
never appear under `src/reservations/`. The same reasoning applies on this side,
and the guard has to run in both directions, because a category leaking either
way is the failure:

| Assertion | What it prevents |
|---|---|
| `ONDC` and `TRV11` appear nowhere under `src/reserved/` | A reserved payload acquiring an ONDC namespace claim by copy-paste from the path it was modelled on |
| `TRANSIT.LOCALHOST`, `RESERVED` and `INTERCITY` appear nowhere under `src/trv11/` | The reverse leak, which would put a locally-invented vocabulary into payloads that do claim TRV11 conformance |
| No file under `schemas/transit_local_intercity/` carries a `$ref` into `schemas/ondc_trv11/` | Schema-level coupling, which is how the two vocabularies would merge without anyone editing a source file |

The third is the one worth writing carefully. `common.json`'s `$defs` are
genuinely tempting to reuse - a `descriptor`, a `price`, a `tag` are the same
shapes in both trees - and reusing them would mean a change made for TRV11
silently altering what the reserved domain accepts. The reserved tree gets its
own `common.json`, duplicated rather than shared, and the duplication is the
point.

The app side reached the same conclusion independently and for the same reason.
Tatak's statewide spec refuses to reuse `OndcClient`'s wire shape for
reservations because doing so "would not be simulating a real protocol the way
the ticket and pass paths do - it would be inventing a protocol and dressing it
as ONDC's," and puts reservations in `src/reservations/` rather than
`src/ondc/reservations.ts` (section 5). This document is the seller-side half of
that same decision.

### What this costs, and what it does not

It costs a second registry subscription per participating BPP, a gateway routing
entry, and one more schema tree. Section 21 prices it.

It does not cost protocol fidelity in the sense that matters. The registry
lookup, the gateway fan-out, the Ed25519 signing pipeline, the ACK/NACK
envelope, the asynchronous callback model and the schema validation on both
directions are all unchanged - they are properties of the ONIX stack and of this
provider's own boundary, not of the domain string. What changes is the claim
made about the payload vocabulary, and that claim is now accurate.

### What would have to change if TRV12 intercity is released

Named now, so the answer is not improvised later:

1. **The domain constant and version.** One constant, one schema directory name,
   one registry subscription per BPP, one gateway routing rule.
2. **The vocabulary map.** Every tag code and enum value this document
   introduces - `RESERVATION` as a fulfillment type, `SEAT_MAP`, `BOARDING_POINT`,
   `HOLD_INFO`, `MANIFEST`, `REFUND_SLAB`, `SERVICE_PROVENANCE`,
   `OPERATOR_DISCLOSURE` - is this document's own naming and must be mapped onto
   whatever TRV12 names the same concept. Section 14 keeps them in one table
   precisely so that mapping is a table-to-table exercise rather than a search
   through source.
3. **A layer B contract test against TRV12's published examples**, which cannot
   be written until they exist. `SPEC.md` section 11.3's layer B - asserting
   that generated payloads have the same key structure as ONDC's own example
   files - is the single test that keeps this repository's TRV11 output from
   drifting into something that merely looks like Beckn. This category has no
   equivalent and cannot have one. Section 20 states that gap rather than
   working around it.
4. **Nothing in the business logic.** The seat map, the hold arbitration, the
   fare lookup, the refund slab and the manifest are the operator's own domain
   model. They are what a real BPP would hold regardless of the wire format, and
   they are why this repository is worth publishing at all (`SPEC.md` section
   14.1).

---

## 3. The service catalogue

### What a service is

A **service** is one scheduled, repeating intercity run: an identity, a
corridor, a class, an operating pattern, and a set of boarding points. A
**dated service instance** is one service on one calendar date, and it is the
thing that has inventory.

```ts
export interface ReservedService {
  /** Stable across dates and across releases. The join key to
   *  transit-fleet-sim (section 18) and to Tatak's own dataset. Internal:
   *  a rider never sees it. */
  serviceId: string
  /** What is painted on the coach's own board, and what staff at a stand
   *  answer questions about. This is the identifier a rider uses to find a
   *  coach they have never seen (section 9.2). Often the same string as
   *  serviceId for a KSRTC route code, and separately typed because it is
   *  a rider-facing fact rather than a join key, and the two are free to
   *  diverge for any service whose board says something else. */
  serviceNumber: string
  /** What the rider is sold. See section 10 - this is a brand, not a fact
   *  about who dispatches the coach. */
  brand: 'KSRTC' | 'NWKRTC' | 'KKRTC'
  /** Who actually operates it, where that is known. `null` means unknown,
   *  and unknown must render as absent, never as `brand`. Section 10. */
  operatingCorporation: 'KSRTC' | 'NWKRTC' | 'KKRTC' | null
  /** How the corporation claim above is known. Section 10. */
  operatingCorporationBasis: ServiceProvenance
  /** How the service itself is known to exist and run as claimed.
   *  Section 3.2. */
  provenance: ServiceProvenance
  serviceClass: ServiceClass
  /** Ordered, in travel order, with a reporting time each. Section 4. */
  boardingPoints: BoardingPoint[]
  droppingPoints: BoardingPoint[]
  /** Which calendar dates this service runs. Section 3.3. */
  operatingPattern: OperatingPattern
  /** Departure from the first boarding point, minutes after midnight IST.
   *  May exceed 1440 for a service whose later stops fall on the next
   *  calendar day. */
  departureMinute: number
  /** Scheduled running time to the final dropping point, in minutes. */
  runningMinutes: number
  seatMapId: string
  fareTableId: string
  /** Non-refundable in every slab. Section 12. [V] */
  reservationFeePaise: number
  /** Refunded in full in every slab. Section 12. [V] */
  tollPaise: number
}
```

### 3.1 Service classes, and which of them this category sells

Karnataka's three intercity corporations share one reservation brand and portal
(AWATAR, at ksrtc.in), and their premium classes are run jointly under one
naming scheme with each corporation contributing its own buses to shared route
brands [V - Wikipedia infoboxes, `kkrtc.karnataka.gov.in`]. The class taxonomy
that matters here:

| Class code | Name | AC | Berth or seat | Layout | Sold here |
|---|---|---|---|---|---|
| `SARIGE` | Karnataka Sarige | No | Seat | 3+2 non-reclining | **No** |
| `ASHWAMEDHA` | Ashwamedha Classic | No | Seat | 3+2 non-reclining | **No** |
| `RAJAHAMSA` | Rajahamsa Executive | No | Seat | 2+2 | Yes |
| `AIRAVAT` | Airavat | Yes | Seat / semi-sleeper | 2+2 | Yes |
| `AIRAVAT_CLUB` | Airavat Club Class | Yes | Semi-sleeper | 2+2, 53 seats reported [S] | Yes |
| `PALLAKKI` | Pallakki (non-AC sleeper) | No | Berth | 2+1, 30 berths | Yes |
| `AMBAARI_UTSAV` | Ambaari Utsav | Yes | Berth | 2+1 | Yes |

`SARIGE` and `ASHWAMEDHA` are unreserved, walk-up, standing-room-permitted
ordinary buses run by the same corporations [V]. **They are deliberately not in
this category**: gating on the corporation rather than the class would block a
plain KSRTC mofussil bus from ever appearing as a walk-up option. Tatak's spec
makes exactly this argument from the router side and lands `reservationRequired`
on the route record rather than on the operator (section 4). This provider is the
other half of that: it publishes only classes that genuinely sell numbered
seats, and an ordinary intercity bus is a `TICKET`-category product that belongs
on the existing `SJT` path if it is ever modelled at all.

`EV_POWER_PLUS` and `AMBAARI_DREAM` exist in the research but with no confirmed
seat layout or route scale [S], so they are not in the fixture set. `CORONA` and
`CORONA_CLUB_CLASS` are not currently-marketed class names: "Corona" survives
only as the historic chassis name for the original 2015 Ambaari sleeper, and no
active product under that name was found [I - absence of evidence, not confirmed
absence]. Nothing in this repository may publish either.

**No fare multiplier between classes is encoded**, because none could be
sourced. The research is explicit that every figure found was either a
single-route anecdotal fare or an aggregator's "starting from ₹X" teaser, never
a corporation-published slab, and it flags any specific multiplier in its own
report as illustrative rather than a fare rule to encode. Section 4's fare table
is therefore a per-pair, per-class lookup with each cell carrying its own
sourcing label - not a base fare times a class coefficient.

### 3.2 Provenance travels with every service

```ts
/** How a service is known to exist and run on the schedule claimed. */
export type ServiceProvenance = 'confirmed' | 'inferred' | 'none'
```

The three values, and what each licenses:

- **`confirmed`** - several agreeing sources. An annual-report or timetable
  anchor plus an independent aggregator listing, or a mapped OSM corridor
  relation alongside either. Only the major trunk corridors reach this.
- **`inferred`** - derived from a road distance, a depot fleet count, a
  schedules-per-route ratio, or a single uncorroborated aggregator figure. The
  generated long tail.
- **`none`** - the type exists so it cannot silently default to a claim of
  confidence nobody checked. Nothing shipped should carry it.

**These are exactly the three values Tatak's statewide spec defines for
`ServiceProvenance` (section 8), and they must stay byte-identical**, because
the buyer app renders them and a fourth value here would be a value it cannot
draw. That spec also settles the rendering asymmetry, and this provider must not
undo it: **only `inferred` and `none` render a mark; a `confirmed` service is
silent.** Its reasoning is that a "verified" tick would be an affirmative
certification claim the app is not in a position to make, since agreeing
secondary sources are still not the operator's own published word, whereas a
mark on an inferred row costs nothing to justify because it only ever says how
little is known.

On the wire, every service carries the value whether or not it renders:

```json
{
  "descriptor": { "code": "SERVICE_PROVENANCE" },
  "display": false,
  "list": [
    { "descriptor": { "code": "BASIS" }, "value": "inferred" },
    { "descriptor": { "code": "SOURCE_COUNT" }, "value": "1" }
  ]
}
```

`SOURCE_COUNT` is the number of independent sources that agree, and it is what
makes `confirmed` auditable rather than asserted. A service claiming `confirmed`
with `SOURCE_COUNT: 1` is a bug, and section 20's fixture-integrity test fails
on it.

### 3.3 Operating pattern, and the calendar

```ts
export type OperatingPattern =
  | { kind: 'daily' }
  | { kind: 'daysOfWeek'; days: number[] }   // 0 = Sunday, IST
  | { kind: 'dates'; dates: string[] }        // ISO YYYY-MM-DD, IST
```

A search for a date the service does not run returns no item for it. There is no
"nearest date" fallback and no silent roll-forward: a rider asking about the
25th must not be sold the 26th, and the existing single-journey path's own
rollover discipline does not apply here because a reserved departure has a real
calendar date rather than a time of day.

**The advance window is enforced here as well as in the buyer app, and the two
are not redundant.** KSRTC's own reservation terms allow booking 30 days ahead
excluding the day of departure, and close reservations 30 to 45 minutes before
departure, longer on some late-night and major-city routes [V -
ksrtc.in/reservation_terms]. Tatak's spec puts a pre-filter in `boardRoute` with
`MIN_ADVANCE_MS` and `MAX_ADVANCE_MS` constants specifically so that RAPTOR never
makes a network call inside its hot loop (section 4), and is careful to say the
two constants are not the same kind of fact: the closing window is close to a
hard operational reality, while the 30-day horizon is a fidelity choice about
how far ahead simulated inventory bothers to exist.

This provider holds the authoritative version of both. The buyer app's gate
stops unsellable legs appearing in a plan; this provider's gate refuses a
transaction. A `select` for a date outside the window is refused with
`OUTSIDE-BOOKING-WINDOW`, naming which edge and the boundary instant, because a
client that filtered correctly will never see it and a client that did not needs
to know which of its two constants disagrees.

Defaults, both configurable and both stated in `.env.example`:

| Constant | Default | Standing |
|---|---|---|
| `RESERVATION_CLOSE_MINUTES` | `45` | The conservative end of KSRTC's own published 30-45 minute range [V]. Conservative because refusing a sale this provider might have made costs nothing, and making one an operator would have refused is the wrong error. |
| `RESERVATION_HORIZON_DAYS` | `30` | Matches KSRTC's own published advance window [V], but the reason it is enforced here is a fidelity choice: inventing a seat map for a date nobody could book yet is fabrication with extra steps. |

### 3.4 The corridors the fixtures carry

The fixtures carry the corridors the research actually sourced, and each carries
its sourcing forward:

**Bengaluru to Hampi / Hosapete.** Route `2259BNGHMP` departs Majestic at 22:59
daily, reaches Hosapete about 06:00 and Hampi about 06:30, roughly 7.5 hours,
9 stops including Kudlagi. Return `2001HMPBNG` departs Hampi 20:00, halts at
Hospet and departs 20:30, reaches Majestic about 04:30. **[S - a route-aggregator
page reached only through a search summary; the direct fetch of `ksrtcbus.in`
failed with a DNS error and was not independently re-verified.]** Class:
`PALLAKKI`, the 2+1 30-berth non-AC sleeper. Aggregator "cheapest fare" figures
of ₹450-606 Bengaluru-Hampi and ₹570+ Bengaluru-Hosapete were reported but read
like promotional floor prices rather than a fare table [S, weak]. Provenance:
`inferred`, `SOURCE_COUNT: 1`.

**Bengaluru to Chennai.** 347 km, about 8 hours [S]. Classes running include
`AIRAVAT`, `AIRAVAT_CLUB` (Volvo AC multi-axle semi-sleeper, 2+2, 53 seats
reported), `AMBAARI_UTSAV` (Volvo 9600S AC sleeper, 2+1), `RAJAHAMSA` (non-AC
ultra-deluxe seater, 2+2) and non-AC sleeper [S]. This corridor is the one that
proves the fare key, because the Chennai side genuinely has many distinct
boarding and dropping points - Adambakkam, Adyar, Alandur, Ambattur, Anna Nagar,
Anna University, Ashok Nagar and others [S] - each with its own time and,
per the fare-key argument in section 4, potentially its own fare. Three KSRTC
departures were cited at 10:00, 21:55 and 22:15, and that is very likely a
subset of the real timetable rather than all of it [S, low confidence on
completeness]. Provenance: `inferred`.

**Mysuru to Madikeri.** About 118-120 km, roughly 3 to 4 hours [S], daytime
seater classes only - a short hill route, not an overnight run. One aggregator
listed about ₹495 as a KSRTC fare on this pair [S]. Provenance: `inferred`.

**No corridor in the shipped fixtures reaches `confirmed`.** Saying so is the
point: the value exists so that a corridor built later from several agreeing
sources can claim it, and shipping everything at `inferred` is the accurate
reading of what the research actually found. Nobody should demo a fixture
corridor as a sourced timetable.

**Bengaluru to Nandi Hills is deliberately absent.** One search result describes
a single daily KSRTC bus from Majestic at about 08:30, fare ₹50-200, called "the
only direct bus of the day" [S - low-confidence tourism-blog sourcing, not a
KSRTC timetable page]. A once-daily service of ambiguous current existence is a
genuine data thinness rather than a coverage gap, and modelling it as reservable
inventory would be inventing the most confident thing about the least confident
service in the research.

---

## 4. Boarding points, and the fare key

### The fare key is the boarding-point pair plus the class, not distance

**Settled.** `src/trv11/catalog.ts` prices nothing - it renders whatever
`TransitOffer.farePaise` a journey source supplied - and both of Tatak's own
fare models take a continuous distance or a band count as their sole geometric
input. That shape is right for BMTC and Namma Metro, where the same corridor
charges the same fare regardless of which pair of stops you name. It cannot
express intercity, where `AIRAVAT` and `PALLAKKI` on the identical
Bengaluru-Hampi corridor charge unrelated numbers, and where a rider boarding at
Electronic City on a Bengaluru-Chennai service departs later and may pay a
different fare than one boarding at Majestic.

The research could not resolve whether KSRTC prices by distance slab or by
point-to-point table from any published source, and says so [I]. What it did
establish is that differentiated multi-point boarding fares exist on the
Bengaluru-Chennai corridor, which a distance-only model could only reproduce by
inventing per-point distances anyway. A lookup table is therefore both the
honest shape and the cheaper one.

```ts
export interface FareTable {
  fareTableId: string
  currency: 'INR'
  fares: {
    fromBoardingPointId: string
    toBoardingPointId: string
    serviceClass: ServiceClass
    /** Integer paise, as everywhere else in this repository. */
    farePaise: number
    /** 'V' | 'S' | 'I', carried per cell rather than per table. */
    sourcing: 'V' | 'S' | 'I'
  }[]
}
```

Sourcing is per cell because a table can be part-sourced: one corridor's
Majestic-to-Hampi fare might be an aggregator figure while the same table's
Electronic City-to-Hosapete fare is interpolated. A per-table label would launder
the second into the first.

**A missing cell is refused, never interpolated.** `FARE-NOT-PUBLISHED` names the
boarding pair and the class. This mirrors the pass path's
`CONCESSION-RATE-NOT-PUBLISHED` exactly (`src/trv11/concession.ts`), and for the
same reason: silently pricing at a neighbouring cell's value would be inventing a
fare, and a buyer app that asked for a price this provider does not have needs to
hear that rather than receive a plausible number.

### No GST line

AC bus tickets attract 5% GST without input tax credit, or 12% with full ITC
eligibility; non-AC bus tickets are exempt [S - several tax-advisory sites,
consistent with each other, not a primary CBIC citation]. **No GST is computed
and no tax line appears in any quote.** Tatak's spec states the rule this follows:
a fare table sourced from real published fares can show a real number, but a
synthesised one must not perform tax arithmetic on a number it invented, because
that dresses up a guess as a bill. Every fare in the shipped fixtures is
synthesised or secondary-sourced, so no cell in them is a fare tax could honestly
be computed on.

### Boarding points

```ts
export interface BoardingPoint {
  /** Stable identity. The fare key's half, and the ticket's. */
  boardingPointId: string
  name: string
  nameLocal?: string
  /** Optional, and genuinely often absent. A named locality on the Chennai
   *  side of a corridor is a fare and time identity, not necessarily a
   *  surveyed point on a map. */
  gps?: { lat: number; lon: number }
  /** Minutes after the service's own departureMinute at which a rider must
   *  be at this point. This is what makes a boarding point a choice with
   *  consequences rather than a label. */
  reportingOffsetMinutes: number
  /** Where a code exists in an ingested feed, for joining to a stop. */
  stopCode?: string
}
```

A boarding point is not a GTFS stop and must not be modelled as one. Tatak's
spec makes the same distinction and names the reason: some boarding points have
no useful coordinate at all. This repository inherits the consequence - a
boarding point with no `gps` is published with none, and the buyer app draws
nothing rather than a placeholder pin.

**Drawing nothing is the right degradation.** Boarding points given as bare text
with no map is a long-documented failure across the incumbents, and KSRTC's own
is worse: an entire real stop was simply missing from the system. Redbus's fix -
in-app map integration - did not close it: **2026-dated complaints still report
the pin not matching where the bus actually stops** [confirmed,
`docs/research/reservation-ux-study.md` A.1 and E.5]. A pin is only as
trustworthy as the operational data behind it, so a boarding point with no
coordinate publishes none rather than one synthesised from a town centroid.

**A boarding point cannot be changed after an online booking.** KSRTC permits
boarding-point changes for counter and franchisee bookings up until advance
booking closes, and **not for online bookings** [V]. This provider sells only the
online path, so there is no boarding-point amendment action and no
`update`/`on_update` at all. A rider who chose the wrong point cancels under the
slab and rebooks. Section 12 makes that a real, priced consequence rather than a
shrug.

---

## 5. Seat maps

A seat map is authored per class, not per corridor, because the physical layout
repeats across every corridor a class runs on. Services reference one by
`seatMapId`.

```ts
export interface SeatMap {
  seatMapId: string
  serviceClass: ServiceClass
  kind: 'SEATER' | 'SLEEPER'
  /** 1 for a single-deck coach; 2 for a two-deck sleeper. */
  decks: 1 | 2
  seats: Seat[]
}

export interface Seat {
  /** The contract. A buyer app selects by this exact string, and it appears
   *  on the manifest and the ticket. */
  seatId: string
  deck: 1 | 2
  /** 1-based from the front. */
  row: number
  /** Position across the coach, 1-based from the left as the rider faces
   *  forward. The aisle is a gap in this sequence, not a column. */
  column: number
  kind: 'SEAT' | 'BERTH'
  /** True for a seat against a window on either side. Feeds the occupancy
   *  desirability weighting (section 6) and is worth rendering. */
  window: boolean
  /** The other half of a shared two-person berth, where one exists. Null
   *  for a single berth and for every seater seat. Section 7 uses this. */
  pairedSeatId: string | null
  /** Seats immediately across the aisle-free side, used by the gender
   *  adjacency rule. Section 7. */
  adjacentSeatIds: string[]
}
```

### 5.1 A 2+2 seater: `AIRAVAT`, `AIRAVAT_CLUB`, `RAJAHAMSA`

Two seats, aisle, two seats, repeated down the coach. `AIRAVAT_CLUB` on
Bengaluru-Chennai is reported at 53 seats [S], which is 13 full rows of four plus
a rear row of five - the last row of an Indian coach is conventionally
aisle-free. The fixture authors 13 rows of 4 and one rear row of 5.

```
        front
  row 1  [ 1A 1B ]   |   [ 1C 1D ]
  row 2  [ 2A 2B ]   |   [ 2C 2D ]
  ...
  row 13 [13A 13B]   |   [13C 13D]
  row 14 [14A 14B 14C 14D 14E]        <- rear bench, no aisle
        rear
```

`seatId` is `<row><columnLetter>`: `1A`, `13D`, `14E`. `window` is true for the
`A` and `D` columns and for `14A`/`14E`. `adjacentSeatIds` for `1A` is `["1B"]`
and for `1B` is `["1A"]` - **the aisle breaks adjacency**, so `1B` and `1C` are
not adjacent for the purposes of section 7's gender rule. This matters: a woman
in `1B` does not lock `1C`, because nobody sits shoulder to shoulder across an
aisle. `pairedSeatId` is null throughout: a seater seat is one person's.

### 5.2 A 2+1 two-deck sleeper: `PALLAKKI`, `AMBAARI_UTSAV`

Pallakki is 2+1 with 30 berths across upper and lower decks [S - Wikipedia,
Team-BHP, AbhiBus]. 2+1 means a **double berth** on one side and a **single
berth** on the other, on each deck. A double berth is one physical bunk wide
enough for two, and it is sold as two sellable places, not one.

```
        front                    LOWER DECK (deck 1)
  row 1  [ L1AB double ]   |   [ L1C single ]
  row 2  [ L2AB double ]   |   [ L2C single ]
  ...
  row 5  [ L5AB double ]   |   [ L5C single ]

        front                    UPPER DECK (deck 2)
  row 1  [ U1AB double ]   |   [ U1C single ]
  ...
  row 5  [ U5AB double ]   |   [ U5C single ]
```

Five rows per deck gives 5 × 3 × 2 = 30 berths, matching the reported figure.
`seatId` is `<deck><row><position>`: `L1A`, `L1B`, `L1C`, `U5C`. For `L1A`,
`pairedSeatId` is `L1B` and `adjacentSeatIds` is `["L1B"]`. For `L1C`, both are
empty - a single berth has no neighbour, which is precisely why it is the berth a
lone traveller wants and why section 7's rule never touches it.

**Deck is a first-class axis, not a row offset**, so a client can group by it
rather than parsing it out of a seat id. Lower berths are conventionally
preferred, and section 6's desirability weighting encodes that.

**Both decks always come back in one payload, and that is a deliberate
constraint on the client rather than a convenience.** The brief's sheet 05 calls
for "the upper/lower deck toggle", and `docs/research/reservation-ux-study.md`
section A.6 names a tab-per-deck seat map as an anti-pattern with measured
evidence behind it: MakeMyTrip's own data makes it **the lowest-converting step
in the entire booking funnel**, because riders select a berth in one tab, browse
the other, and lose track of the first [confirmed, Go-MMT design blog]. A wire
shape that returned one deck per call would force the failing pattern; returning
both makes a stacked or side-by-side view possible without a second round trip.
Whether the sheet's toggle survives is the client's decision, and it should be
taken against that finding rather than against the word "toggle".

Two more findings from the same section bear on what this provider must publish
rather than on how it is drawn. The seat-state vocabulary in section 14.3 has
**five** values and a client's legend must enumerate all five: a legend that
undercounts the states actually on screen is a confirmed real-world failure, and
it was compounded in the documented case by the missing state being the
safety-relevant one. And section 7's `FEMALE_ONLY` **must not be encoded by
colour alone**. The documented failure is a ladies-only seat distinguished by a
pale pink border, visually indistinguishable from an available seat, which led to
a rider booking one by accident and to a support response blaming the rider
rather than the interface [confirmed, consumer complaint]. This provider's part
is to publish the state as a distinct enumerated value rather than folding it
into `AVAILABLE` with a hint, which is what makes redundant encoding possible on
the client at all.

### 5.3 What a seat map is not

It carries no price. Fares are keyed by boarding pair and class (section 4), not
by seat, and this provider publishes no per-seat premium of any kind, because no
source establishes one. A window seat costs what an aisle seat costs.

It carries no vehicle. The seat map is the class's layout, and which physical
coach turns up is `transit-fleet-sim`'s question (section 18). A seat map that
named a chassis would be claiming a vehicle assignment this provider does not
make.

---

## 6. Occupancy: a consequence of the service and the date

**Settled: seat occupancy is deterministic and seeded from service identity plus
travel date, and it is not drawn per request.**

The sibling fleet simulator adopted exactly this discipline for bus load and its
reasoning transfers unchanged. `transit-fleet-sim`'s `src/sim/occupancy.ts`
opens by naming what it replaced: "The old implementation rebucketed a keyed hash
every five minutes: no route, no direction, no time of day, no stop-level
boarding, so a bus's fullness jumped arbitrarily instead of filling toward a
centre and emptying after it." What it built instead treats load as a
**consequence of the trip** - position along the route, time of day, direction,
vehicle class - with random draws present only "as perturbations layered on this
shape, keyed through `rand` so the same vehicle at the same instant always
answers the same. Nothing here reads the wall clock or an unseeded source."

A seat map gets the same treatment. Occupancy is a consequence of which service,
on which date, in which class, with a per-seat perturbation on top - never a
coin flip per seat and never a fresh roll per request.

### 6.1 The fill fraction

```
fillFraction(service, travelDate) =
  clamp(
    service.popularity                       // authored per service, 0..1
      * dayOfWeekMultiplier(travelDate)      // IST calendar day
      * classMultiplier(service.serviceClass),
    MIN_FILL, MAX_FILL)
```

Every input is a property of the service and the date. `popularity` is authored
in the fixture per service and is a **fidelity dial, not a claim** - it is not
derived from ridership data, because none exists for these corporations at route
level, and the fixture states so per service. `dayOfWeekMultiplier` favours
Friday and Sunday, which is the ordinary shape of Indian intercity demand [I].
`classMultiplier` reflects that a cheaper class fills first at the same
popularity [I].

**Nothing in this function reads the request instant, and that is deliberate
even though it costs realism.** A booking curve that filled a coach as its
departure approached would be more lifelike and would also be indistinguishable
on screen from real inventory moving - which is a claim this provider cannot
make. A static seeded map is visibly a simulation, keeps a screenshot and a
golden-file test reproducible, and means the answer to "why does berth L3B show
sold" does not depend on when you asked. Section 19's fidelity table records the
realism this costs.

### 6.2 Which seats, not just how many

Seats do not sell in index order, and a map that filled `1A, 1B, 1C, 1D, 2A...`
would look wrong to anyone who has boarded a coach. Each seat gets a
deterministic **desirability weight**, and the sold set is the top
`round(fillFraction × capacity)` seats by
`weight(seat) + perturbation(seed, serviceId, travelDate, seatId)`:

| Factor | Direction |
|---|---|
| Window | Preferred over aisle-side |
| Lower deck | Preferred over upper, on a sleeper |
| Single berth | Preferred over half of a double, on a sleeper |
| Forward rows | Mildly preferred over rear |
| Rear bench | Least preferred |

The perturbation is `rand(seed, serviceId, 'seat-rank', seatId)`, the same
FNV-1a-plus-xoshiro construction `transit-fleet-sim/src/sim/rand.ts` already
uses, so that noise perturbs the shape rather than being the shape. A half-full
coach then shows its windows gone and its middles free, which is what a rider
actually sees.

`SEAT_OCCUPANCY_SEED` is configurable and defaults to a fixed constant so that
the repository's own tests, a demo recording and a stranger's first clone all
draw the same coach.

### 6.3 Seeded occupancy carries a seeded gender

A notionally-occupied seat also gets a deterministic gender, from the same keyed
hash, because section 7's adjacency rule cannot evaluate a lock without knowing
who is notionally beside the empty seat. This is a genuine consequence of
choosing a deterministic simulation over a live feed: **this provider fabricates
a gender for seats nobody booked**, purely so that a real, rule-following lock
can be demonstrated. It never leaves the
seat-state computation as an identity; what the wire carries is the resulting
lock (`FEMALE_ONLY`), not a claim about a person.

### 6.4 The three sources of a seat's state

A seat's published state at request time is the union of three things, in this
order:

1. **Seeded occupancy** (this section). Marked `SOLD`, simulated.
2. **A live hold** placed by some transaction in this stack (section 8). Marked
   `HELD`. A hold placed by the requesting transaction itself is marked
   `HELD_BY_YOU`, because a client must be able to distinguish its own hold from
   somebody else's without inference.
3. **A confirmed booking** in this stack (section 15). Marked `SOLD`.

Rows 2 and 3 are facts this provider actually holds; row 1 is not. The wire
distinguishes them: a `SEAT_MAP` entry carries `simulated: true` on a seeded-sold
seat and `simulated: false` on a booked one, so a buyer app can honestly say
"this berth was sold in this demonstration" about one and nothing at all about
the other. The `SIMULATED_INVENTORY` mark rides on the seat map as a whole
regardless.

---

## 7. Gender locking, and the adjacency rule that relocks

AWATAR's booking app carries a "Single Lady" checkbox; selecting it restricts the
adjacent seat to female booking only. It applies across most service classes and
excludes Karnataka Sarige and BMTC Volvo services [S - a terms-and-conditions
summary, not a primary AWATAR document]. Neither exclusion bites here: this
category sells neither.

### The rule

**A seat adjacent to one occupied by a female passenger is sellable only to a
female passenger, unless both seats belong to the same booking.**

Each part of that sentence does work:

**Adjacency is physical, not numerical.** `Seat.adjacentSeatIds` is authored on
the seat map (section 5) and the aisle breaks it. `1B` and `1C` are numerically
consecutive and are not adjacent. Deriving adjacency from seat numbering would
lock the wrong seat on every 2+2 coach in the fleet.

**The lock is across bookings, not within one.** A family or a couple booking a
double berth together is the ordinary case, and refusing it would make the
feature absurd. So the lock is evaluated against seats held by *other* bookings
and against seeded occupancy, and never against the other seats in the request
being evaluated.

**The lock is a property of the seat's neighbourhood, recomputed on read, not a
stored flag.** This is what makes the relock work, and it is the same lazy-read
discipline the hold sweep uses (section 8) and that Tatak's own
`sweepExpiredTickets` already applies on its side.

### The relock

The interesting case, and the one a test must pin:

1. A booking takes berths `L1A` and `L1B` - one double berth - for a male
   passenger in `L1A` and a female passenger in `L1B`. Allowed: same booking.
2. The booking is partially cancelled, releasing `L1A`. (Or, equivalently, a
   whole booking is cancelled and a different booking re-takes `L1B` alone.)
3. `L1A` is now free, and its neighbour `L1B` holds a female passenger belonging
   to a *different* booking than any prospective buyer of `L1A`.
4. **`L1A` becomes `FEMALE_ONLY`.** The exemption that made it sellable to a man
   was the shared booking, and that booking no longer holds it.

A `select` naming `L1A` with a male or unspecified-gender passenger is refused
with `SEAT-GENDER-LOCKED`, naming the seat and the required gender, and never
naming the neighbouring passenger or anything about them.

### Where the rule cannot be honest

The gender on the manifest is what the buyer app asserts. This provider verifies
nothing about it and has no way to, exactly as it verifies nothing about a
concession class (`docs/passes.md` section 3). The lock is therefore a
convention this stack enforces mechanically, not a safety guarantee, and no
surface may describe it as protection. What it is: a refusal to sell a specific
seat to a specific declared gender, which is what AWATAR appears to do [S] and
is all this provider is in a position to model.

A passenger whose gender is `null` on the manifest cannot take a locked seat.
That is a consequence of the rule rather than a separate policy, and it is the
right one: an undeclared gender cannot satisfy a female-only constraint, and
inferring one from a name would be a far worse move than refusing.

---

## 8. The hold lifecycle

**Settled: holds are server-authoritative. This provider issues the hold, sets
its TTL, and returns the absolute expiry instant. The client never computes an
expiry and never extends one.**

### 8.1 The TTL is ten minutes

`RESERVATION_HOLD_TTL_SECONDS`, default `600`.

The best-sourced incumbent figure is **five minutes, not ten**, and this
document deliberately departs from it. `docs/research/reservation-ux-study.md`
section A.7 documents redBus's mechanism as the one worth copying and states its
duration precisely: pessimistic lock on tap, immediate disappearance from every
other session, **a five-minute TTL confirmed by a rider's own account of a
booking session**, and silent release on timeout. A looser figure of 10 to 15
minutes appears in `docs/research/ksrtc-domain-research.md` section 5, but it is
weaker material - a summary of Quora and security-research posts rather than an
official redBus statement - and where the two disagree the confirmed account
wins. **No KSRTC-specific documentation of AWATAR's own lock duration was found
anywhere** [I].

So ten minutes is twice the best-documented incumbent, and choosing it needs an
argument rather than a citation. Two differences from a redBus checkout justify
it, and neither is a preference:

**The form is longer.** A redBus five-minute window covers a passenger form and
a payment. This category's window covers a name, an age and a gender **per
seat** - six fields for a couple, twelve for a family of four - typed on a phone,
by someone who may be asking the person beside them for their age. The UX study's
own finding on that screen is that riders arrive at it having already lost track
of their earlier choices and rely on memory; a form that hostile under a
five-minute clock produces abandoned bookings rather than fast ones.

**There is no payment step to fail fast.** redBus's five minutes is bounded by a
payment that either completes or does not. Nothing here charges anything
(section 19), so the window is pure form-filling and there is no early exit.

The cost is bounded and worth naming: on a 30-berth Pallakki coach, a ten-minute
hold caps the damage one abandoned session can do at 3.3% of the coach for one
sixth of an hour. **If that trade is judged wrong, five minutes is the better
default and the constant is one line** - `RESERVATION_HOLD_TTL_SECONDS` exists
precisely so this does not require a code change to revisit.

**Tatak's own spec independently picked ten minutes with the same reasoning**
(section 5: "long enough to fill a five-field passenger form without punishing a
slow typist, short enough that an abandoned booking does not lock a seat for the
rest of the day"). The two sides agreeing is not evidence the number is right; it
is a reason not to have them disagree. Since holds are now server-authoritative,
the buyer app must stop holding the constant at all and render the expiry this
provider returns.

The brief's own UX ruling depends on that: it refuses "2 seats left" and permits
instead "a countdown on the hold the rider actually owns, which is a fact about
their own booking rather than a claim about strangers". A countdown is only a
fact about the rider's own booking if the instant it counts to came from the
party that will honour it.

**One qualification the brief's wording does not carry.** It calls "2 seats left"
the sector's defining dark pattern. `docs/research/reservation-ux-study.md`
section A.9 is careful to say the opposite about the evidence: no literal
urgency-countdown screenshot or quote was confirmed for redBus in that research
pass, and it asks that this be stated as an unconfirmed assumption about the
category rather than an established fact about any incumbent. **The ruling is
unaffected** - the study's own conclusion is to avoid the pattern regardless -
but nothing in this stack should print the accusation as though it had been
verified.

### 8.2 When a hold is taken

**At `select`, when the selection names seats.** `select` has two shapes:

- `select` naming a service, class and boarding pair, with an **empty** seat
  list, returns the seat map and the fare. **No hold is taken.** Browsing a seat
  map must not lock inventory, and `select` is the one action a client may
  legitimately call repeatedly.
- `select` naming one or more seats returns the priced quote **and takes a
  hold**, returning its absolute expiry.

This preserves the property the UX research identifies as the best mechanism in
the sector - the seat disappears from every other session the instant it is
taken, so contention is prevented before it can be rendered - while keeping the
map itself free to browse.

**One live hold per transaction, replaced rather than accumulated.** A second
seat-naming `select` in the same transaction releases the previous hold in the
same database transaction that acquires the new one. A rider comparing three seat
choices therefore holds at most one set at a time. Without this, a client
exploring the map would ratchet holds until the coach was locked by one
undecided rider.

**The hold TTL does not restart on a re-select of the same seats.** A `select`
naming exactly the seats already held by that transaction is idempotent: it
returns the same hold id and the same expiry, unchanged. A hold that renewed
itself every time a client repriced would have no TTL at all.

### 8.3 What the client is told

```json
{
  "descriptor": { "code": "HOLD_INFO" },
  "display": true,
  "list": [
    { "descriptor": { "code": "HOLD_ID" },   "value": "HLD-KSRTC-9F2C1E04" },
    { "descriptor": { "code": "EXPIRES_AT" }, "value": "2026-09-05T18:42:11.000+05:30" },
    { "descriptor": { "code": "TTL_SECONDS" }, "value": "600" }
  ]
}
```

`EXPIRES_AT` is absolute and authoritative. `TTL_SECONDS` is published only so a
client can show "held for 10 minutes" in copy without subtracting two instants;
it is never the thing counted against. A client whose device clock is wrong will
show a wrong countdown and still be refused or accepted correctly, because the
decision is made here against this provider's own clock.

### 8.4 Expiry

Expired holds are swept **lazily, inside the transaction that next touches that
(service, date)**, not by a background job. This matches Tatak's stated aversion
to workers and queues and this repository's own shape - a single Node process
with no scheduler. A hold that has passed its expiry is functionally released the
instant anyone asks, which is the only moment the answer matters.

A swept hold leaves a row in `seat_locks` with `state = 'EXPIRED'` rather than
being deleted, so that a confirm arriving against it can be refused with the
reason rather than with "unknown hold".

### 8.5 Double-booking

Two transactions racing for the same berth: the first `select` to reach the
acquire step wins; the second is refused with `SEAT-UNAVAILABLE`, naming the
seats that were taken and returning the current seat map alongside, so the client
can re-render without a second round trip.

**Inside one process, atomicity is structural.** The acquire path performs its
sweep, its availability check and its insert inside one SQLite transaction with
no `await` between them, so no interleaving is possible. The unique index does
the real work:

```sql
CREATE UNIQUE INDEX seat_locks_live
  ON seat_locks (service_id, travel_date, seat_id)
  WHERE state IN ('HELD', 'BOOKED');
```

A losing racer gets a constraint violation, which is translated into
`SEAT-UNAVAILABLE` rather than surfaced as an internal error. **The constraint,
not the check, is the guarantee** - the check exists to produce a good error
message, and if the two ever disagree the constraint is right.

Across processes, the same index over a shared libSQL file or server remains
correct. Section 15 says what changes if this is ever run behind more than one
replica.

### 8.6 A confirm that arrives one second late

**Refused. Always, deterministically, even when the seats happen to still be
free.**

`confirm` against a hold whose `state` is `EXPIRED`, or whose `expires_at` is at
or before this provider's clock, returns `HOLD-EXPIRED`, naming the expiry
instant that was already published on `on_select`. The client re-runs `select`
for the same seats, which will usually succeed immediately, and re-confirms.

Forgiving lateness when nobody else wanted the seat is the tempting behaviour and
the wrong one. It makes the outcome depend on whether an unrelated third party
happened to be looking at the same coach in the same second - a race the client
cannot observe, cannot reproduce, and cannot test against. A hold that is
sometimes honoured after expiry is not a hold; it is a suggestion, and every
client would then have to handle both outcomes anyway. Deterministic beats lucky,
and the cost of the strict rule is one extra round trip on a rare path.

No money moves anywhere in this stack (section 19), so a late confirm strands
nothing. On a stack where money did move, this rule would need a compensating
answer for a payment captured against a lapsed hold, and it would not be the same
rule.

### 8.7 A confirm against seats a hold does not cover

Refused with `HOLD-SEAT-MISMATCH`. The confirm's seat set must equal the hold's
exactly. A client that wants to drop one passenger re-selects, which is one round
trip and produces a hold whose expiry it can show honestly, rather than a
silently-shrunk booking whose price nobody quoted.

---

## 9. The passenger manifest

A reserved booking names people. `Order.billing` in the existing paths carries
exactly one `{name, phone}` pair for the whole order, and there is no precedent
anywhere in either repository for more than one named traveller per transaction.

```ts
export interface ReservationPassenger {
  seatId: string
  name: string
  /** Null when not supplied. Never inferred, never defaulted. */
  age: number | null
  gender: 'male' | 'female' | 'other' | null
}
```

**These are exactly the four fields Tatak's spec defines for
`ReservationPassenger` (section 5), and they must stay that way**, because the
manifest crosses the boundary between the two projects and a field only one side
knows about is a field neither can rely on.

### What operators actually require, and what this provider therefore does not collect

The research is precise about the boarding requirement: online, app and
franchisee bookings produce an A4 printout, an SMS m-ticket or a
phone-displayed QR or image, and **carrying a physical government photo ID
matching the ticket is mandatory** - driving licence, voter ID, passport, Aadhaar
or another government photo ID [V]. Counter bookings get pre-printed stationery
[V].

The conclusion that follows is the one this repository has already reached once:
**an identity document must be carried, and its number does not have to be
collected at booking to make that work.** The conductor matches a name on a
manifest against a card in a hand. Nothing in that loop requires a document
number to have crossed a network.

So, and this is a hard rule inheriting `docs/passes.md` section 3 unchanged:

- **No document type, no document number, no identity reference of any kind is
  ever accepted, stored or logged.** A `MANIFEST` tag group carrying an entry
  other than `SEAT_ID`, `NAME`, `AGE` or `GENDER` is **refused** rather than
  quietly stripped, with `MANIFEST-FIELD-NOT-ACCEPTED` naming the unexpected
  *codes* and never echoing their values. Error messages reach the event log, and
  an unexpected `value` is exactly where a document number would arrive.
- **One phone number per order, on `billing`, not per passenger.** A contact for
  the booking is a real operational need; a phone number per traveller is not,
  and collecting one would be collecting an identifier per person for no purpose
  this provider can name.

`age` and `gender` each earn their place rather than being form decoration:
`gender` drives the seat lock in section 7, and `age` is what a concession slab
would key on if this provider published one it could stand behind - which,
section 11 argues, it mostly cannot.

### Scope: one boarding point and one dropping point per booking

Not per passenger. Multi-drop-point group booking is real in the sector and adds
a genuinely separate axis of complexity that proves nothing this category needs
to prove. Tatak's spec draws the same line, and the two must agree or the wire
shape is ambiguous.

### The manifest is what a ticket carries instead of a scannable credential

A single-journey ticket carries a QR PNG; a pass carries a rotating TOTP secret.
A reserved booking carries **a booking reference and a list of names against
seats**, because that is what an intercity coach's boarding check actually is: a
conductor with a manifest, not a gate with a reader. There is no `authorization`
object on a reserved fulfillment at all, and inventing one would be modelling a
verification that does not happen. Section 19 restates what this means for the
specimen posture.

### 9.1 The bay: declined, and the catalogue carries no field for it

**Ruled: this provider publishes no bay, platform or stand-position identifier,
and the catalogue has no field for one.**

The mockup for the reserved ticket at the moment of boarding (sheet 09, "the
ticket at 22:00") makes the bay the largest element on the screen, above the seat
number and above the booking reference. The hierarchy argument behind that is
sound and this document does not dispute it: a rider standing at Majestic at
22:00 has to find the right coach before a seat number means anything, and a
booking reference is what staff ask for rather than what a rider searches for.

The field is declined anyway, for two reasons that compound.

**Nothing sources it.** The app-side spec already recorded this as a gap, and
this document's own sourcing sweep agrees: neither the aggregator harvest, nor
OpenStreetMap's 171 statewide `amenity=bus_station` nodes, nor the operators'
annual administration reports carry bay-level granularity for any Karnataka bus
stand. There is no dataset to fill the field from and no prospect of one.

**Even a real operator could not fill it at booking time.** At a large stand,
a bay is assigned close to departure and announced, not printed on a ticket sold
three weeks earlier [I, from ordinary practice at Indian bus stands rather than
from a KSRTC document]. So a bay is not a property of a service or of a dated
service instance at all - it is an operational fact that comes into existence
minutes before the coach does. A field on the catalogue would be the wrong shape
for it even if the data existed.

A nullable field that stayed null in every shipped fixture would be worse than
none: it would let the mockup stand unchanged on the expectation that data lands
later, with a headline built around a value that never arrives. Saying nothing
here means not having the field at all.

**Where a bay would belong if it ever existed.** Beside the duty resolution at
run time (section 18), not in the catalogue - the same class of fact as which
coach is running, resolved at the same moment, by the party that owns operational
state. If `transit-fleet-sim` ever grows a real bay assignment, it grows it
there, and this provider still carries none.

**What the ticket shows instead**, and the mockup has to change to match:

1. **The boarding point and its reporting time.** "Majestic (Kempegowda Bus
   Station) · report by 22:44." This provider does source this - `reportingOffsetMinutes`
   on the boarding point (section 4) - and it is the strongest true thing the
   ticket has at the top of the screen. It is also the fact that actually governs
   the rider's next few minutes.
2. **The service number and the class.** "2259 · Pallakki sleeper." Section 9.2.
3. **A plain sentence where the bay was:** *bay announced at the station.* Not a
   placeholder, not a dash, not a skeleton waiting to fill. A sentence, because
   the honest answer to "which bay" is a piece of information about how the stand
   works, and a rider who reads it once knows what to do.
4. Then the seat, then the booking reference.

That ordering keeps the mockup's own argument intact. The rider still gets, at
the top of the screen, the thing that tells them where to stand and by when - it
is a time and a place rather than a number, which is what the data can actually
support.

### 9.2 What identifies the coach, given the rider has never seen it

The rider is looking for a specific vehicle among many, at night, at a stand with
no bay number on their ticket. What this provider can honestly give them:

| Fact | Source | Always present |
|---|---|---|
| Service number | `ReservedService.serviceNumber`, on the coach's own board | Yes |
| Destination | The final dropping point on the fulfillment | Yes |
| Class | `SERVICE_CLASS`, and the class name is painted on premium coaches | Yes |
| Brand | `OPERATOR_DISCLOSURE.BRAND` | Yes |
| Departure and reporting time | The fulfillment's stop timestamps | Yes |
| Registration plate | **Not this provider's.** `transit-fleet-sim`, at run time | No |
| Operating corporation | Retired from the rider surface by section 10.2's ruling. Was `OPERATOR_DISCLOSURE.CORPORATION`; now settlement-only (section 10.3) | Never |

The first five are what a real KSRTC e-ticket gives a rider, and they are enough
to find a coach at a stand, because they are what the coach itself displays.

**The plate is resolved, never carried.** The booking carries `VEHICLE_LOOKUP`
with `SERVICE_ID` and `TRAVEL_DATE` (section 14.5), which is exactly what a
duty lookup needs and nothing more. When the simulator resolves it, the ticket
surface can add the plate and mark it as of the moment it was fetched, following
the simulator's own rule that stored vehicle details are historical and a live
one requires a call.

**When the simulator has nothing, the ticket says nothing.** No placeholder
plate, no "TBA", no greyed-out row. The rider falls back to the five facts above,
which is where a real ticket leaves them anyway. `duty.status: unknown` from the
simulator and no reachable simulator at all must render identically, because the
rider's situation is identical in both.

**A corporation resolved by the simulator is not the corporation section 10.3
attributes a sale to.** The simulator assigns a vehicle from a fleet it
generated; the corporation attached to that assignment is a property of the
simulation, not a claim about who dispatches the real 22:59 to Hampi, still
less a claim about who is owed money for the seat. It must never be written
into `bookings.settlement_corporation`, and the two must never be compared or
merged. Confusing them would turn a deliberate refusal to guess (section 10.4)
into a guess arriving through a side door, and this guess would be worse than
the disclosure-era one: a wrong screen misleads a rider who sees it, a wrong
settlement attribution misdirects money nobody is watching closely enough to
catch the error.

---

## 10. The operating corporation: a disclosure retired, an attribution kept

Karnataka has four state-owned road transport corporations, not one: BMTC
(Bengaluru city), KSRTC (southern Karnataka excluding Bengaluru city, and the
parent body), NWKRTC (north-western Karnataka, formed 1997) and KKRTC
(Kalyana Karnataka - Kalaburagi, Bidar, Yadgir, Raichur, Koppal, Ballari and
Vijayanagara districts; established as NEKRTC in 2000 and renamed by
gubernatorial order on 6 July 2021) [V - Wikipedia, `kkrtc.karnataka.gov.in`].

**Bengaluru to Hampi is Kalyana Karnataka territory.** Hosapete is in Ballari
district and Hampi is in Vijayanagara district, both KKRTC [V]. And yet KSRTC,
NWKRTC and KKRTC share a single reservation brand and portal, and the premium
classes are run jointly under one naming scheme with each corporation
contributing its own buses to shared route brands [V]. So a coach booked as
"KSRTC" on ksrtc.in or on any aggregator may be a KKRTC vehicle, and the research
could not confirm from any primary source which corporation owns the specific
nightly Majestic-origin bus - it recommends treating "which corporation" as
administratively ambiguous rather than cleanly KSRTC [I].

**No consumer surface examined discloses this**, and the honest form of that
finding is narrower than a flat claim.
[`docs/research/karnataka-network-scope.md`](research/karnataka-network-scope.md)
section 2 records it as *"no dedicated confirmation found either way"*: AWATAR's
own terms page describes the booking flow without mentioning operator disclosure
at all, and the OTAs list an operator field of "KSRTC" generically for buses that
include NEKRTC, NWKRTC and BMTC fleet under that umbrella tag [S]. So the retail
brand is being used as a catch-all for "Karnataka government bus" the way "Coke"
gets used for any cola, which actively obscures the operating corporation rather
than merely omitting it.

The likely explanation for the Hampi service specifically, and it is an inference
rather than a finding: KSRTC runs it as one of its own long-haul services
originating in its territory and terminating in KKRTC's, the same way it runs
services into Kerala and Goa without those being KSRTC territory [I]. That is
plausible and it is not evidence, which is exactly why section 22's second open
question stays open.

### 10.1 The field, and why it is nullable

```json
{
  "descriptor": { "code": "OPERATOR_DISCLOSURE" },
  "display": true,
  "list": [
    { "descriptor": { "code": "BRAND" }, "value": "KSRTC" },
    { "descriptor": { "code": "CORPORATION" }, "value": "KKRTC" },
    { "descriptor": { "code": "CORPORATION_BASIS" }, "value": "confirmed" }
  ]
}
```

**This shape is superseded. Section 10.2 records the ruling: `CORPORATION` and
`CORPORATION_BASIS` are retired from `OPERATOR_DISCLOSURE` outright, not made
conditional on being known.** The reasoning below is kept rather than deleted,
because the case for treating the field as nullable when it did exist on the
wire is the same case now used to argue that a `null` value settles a ledger
rather than a screen (section 10.3, section 10.4) - the argument survived the
ruling even though the wire shape did not.

`BRAND` is always present: it is what the rider is being sold and there is no
uncertainty about it. Under the shape this subsection originally proposed,
`CORPORATION` and `CORPORATION_BASIS` would have been **omitted entirely** when
the operating corporation was not known to a `confirmed` standard, so that
absence meant unknown and a buyer app rendered the brand alone rather than
`brand` in the corporation's place. Section 10.2 goes further: the fields are
never present, known or not.

**This narrows Tatak's spec, which types the ticket field as
`operatingCorporation: 'KSRTC' | 'NWKRTC' | 'KKRTC' | 'BMTC'` with no null**
(section 7). That spec's justification for the non-null type is sound and
survives: because the dataset is authored per corporation, the operating
corporation is known at ingestion time rather than inferred at display time. It
holds for an **authored** service. It does not hold for a **synthesised** service
on a shared-brand corridor, where the corporation is exactly the fact the
research could not establish. Publishing an inferred corporation would be worse
than publishing nothing, because the whole value of the disclosure is that it
closes a gap every other surface leaves open - a disclosure that is sometimes
wrong closes nothing and misleads instead.

So the field is nullable here, and the app-side type needs to become
`| null` to match. **This is a change to an already-written spec and it needs the
owner's sign-off**; section 22 carries it as an open question rather than
assuming it.

`CORPORATION_BASIS` reuses `ServiceProvenance`'s three values (section 3.2)
rather than inventing a second confidence vocabulary. It is published even when
`confirmed`, unlike the service-level provenance mark, because a disclosure this
repository is making a point of is a disclosure whose basis should be auditable
on the wire.

**Do not conflate this with `provenance`.** A service can be `confirmed` (several
sources agree it runs at 22:59) while its operating corporation is unknown. The
two are different claims about different things and share only a type.

### 10.2 Ruled: the corporation comes off the rider's screen

Section 10.1's whole argument assumed the operating corporation was something a
rider benefits from knowing - a value differentiator, because "no consumer
surface examined discloses this," and closing that gap was the entire reason to
publish `CORPORATION` and `CORPORATION_BASIS` on the wire at all. The owner has
ruled that assumption wrong, and the ruling changes what the fact is *for*
rather than whether it exists:

> "since we are plannign to build a uniform QR system, it's just that if NWKRTC
> operates the bus from Gokarna to mangaluru, they get the sale, if KSRTC
> operates the bus from Mangaluru to Honnavara, they get the sale. It's just our
> headache, the end experience for the user will be the same."

**The fact still has to be known and recorded**, because somebody is owed money
for every seat sold, and it will not always be the corporation whose brand
printed the ticket. That is the argument section 10.1 already made in full, and
none of it was wrong - a coach booked under one brand can be a different
corporation's vehicle, and the three corporations sharing AWATAR does not make
the underlying revenue shared. The gap section 10.1 found real is still real.

**But the rider gets none of it.** A uniform QR system, by the owner's own
framing, means the boarding experience is identical regardless of which
corporation's coach shows up - the rider does the same thing at the same gate
for a KSRTC coach and an NWKRTC one, and there is nothing on that screen for a
corporation name to add. Disclosing it would be publishing an operational fact
the rider has no decision to make with, dressed as though it mattered to their
trip.

So `OPERATOR_DISCLOSURE.CORPORATION` and `OPERATOR_DISCLOSURE.CORPORATION_BASIS`
are withdrawn from the wire entirely - not made optional, not demoted to
`display: false`, removed. `BRAND` stays, `display: true`, because it is
genuinely what the rider bought and there is no ambiguity about it. The tag's
name no longer describes everything it once carried; `OPERATOR_DISCLOSURE` used
to disclose a brand and a corporation, and now it carries only the brand.
Renaming the tag is left to whoever builds this and is not required for
correctness - the wire test in section 10.6 checks for the absence of the
corporation fields, not for a particular tag name.

Section 9.2's "Operating corporation" row and section 17's instruction to
render `brand` in the corporation's absence both describe a rider-facing
corporation field that no longer exists on the wire. Both are corrected in
place, below, rather than left standing as though the ruling had not happened.

The fact itself moves rather than disappearing: sections 10.3 onward are the
same information, held for a different reader.

### 10.3 Settlement attribution: what a sale is owed to, and where it comes from

**The attribution.** Every `CONFIRMED` booking carries a claim about which
corporation the sale is owed to. It is resolved once, at the instant `confirm`
succeeds, never recomputed afterward, and it is never carried on any Beckn
payload this provider sends - not in `on_search`, not in `on_select`, not in
`on_init`, not in `on_confirm`, not in `on_status`, not in `on_cancel`. It
exists in exactly one place: a pair of columns on the `bookings` row this
provider already keeps (section 15).

```sql
ALTER TABLE bookings ADD COLUMN settlement_corporation TEXT
  CHECK (settlement_corporation IN ('KSRTC','NWKRTC','KKRTC'));
ALTER TABLE bookings ADD COLUMN settlement_basis TEXT NOT NULL
  CHECK (settlement_basis IN ('confirmed','inferred','none'));
```

`settlement_basis` reuses `ServiceProvenance`'s three values for the same
reason `operatingCorporationBasis` does (section 3.2, section 10.1): a second
confidence vocabulary would say nothing the first one doesn't. It is a
different field from the wire tag `SETTLEMENT_BASIS` that already exists in
this stack's Beckn settlement-terms machinery (`SPEC.md` section 9, the
`BUYER_FINDER_FEES` / `SETTLEMENT_WINDOW` group) - that one is a BAP-BPP
financial-settlement term carried on every order to make the payload validate,
and it means nothing today because no money moves (`SPEC.md` section 9). This
one means the opposite of nothing: it is the honesty label on an internal
accounting fact. The two share a word because English only has the one word for
it, not because they share a mechanism, and neither is ever compared against
the other or carried on the same payload.

**Where it comes from.** `ReservedService.operatingCorporation` and
`operatingCorporationBasis`, and nothing else. At the moment a booking's status
becomes `CONFIRMED`, this provider copies both fields from the service record
as it stands for that `(serviceId, travelDate)` pair straight onto the booking
row. No inference happens at this step - inference, where it happens at all,
already happened upstream, when the fixture or the source (section 16) decided
what `operatingCorporationBasis` a service carries. Confirm is a copy, not a
computation.

**Resolved at confirm, not at search.** A `select`, even one that takes a hold,
commits nobody to anything - section 8.6 is explicit that no money moves
anywhere in this stack, and a hold that lapses unconfirmed was never a sale.
Computing an attribution for a hold would be doing accounting work for a
transaction that, most of the time, never happens. It also has to be frozen
once done, for the same reason `refund_paise` and `slab_code` are frozen at the
moment of cancellation and never recomputed on a later read (section 13): a
corporation attribution that shifted underneath an already-confirmed booking -
because a later data refresh reclassified the service - would let a settled
sale get quietly reassigned to someone else's ledger after the fact, and
nothing about a re-ingested fixture should be able to reach back into a
transaction that already closed.

### 10.4 The honest gap: most sales cannot be attributed at the moment of sale

Section 3.2 already states it as a fact about provenance: no corridor in the
shipped fixtures reaches `confirmed`, and `operatingCorporationBasis` is a
stricter claim than `provenance` is - even a `confirmed` corridor's *timetable*
can leave its *operator* unknown, which is exactly the Bengaluru-Hampi case
(section 10.1). The reason is structural, not a gap this research pass left for
a better source to close: AWATAR is one booking backend shared by three
corporations, each contributing buses to jointly-branded route names, and
nothing published anywhere - not the reservation terms, not an OTA listing, not
a depot roster this project has access to - establishes which corporation's
coach is rostered against a given service on a given night. The three
corporations settle that among themselves, off any network this provider or
AWATAR exposes, and the owner's own framing says as much: "it's just our
headache."

So this provider will, for nearly every service it can sell today, reach
`confirm` without knowing who the money is owed to.

**Refuse the sale.** The cleanest-sounding option, and the wrong one. This
provider already refuses rather than guesses in every case where guessing
would misinform a party who reads the answer - a missing fare cell
(`FARE-NOT-PUBLISHED`, section 4), an unpublished concession rate
(`CONCESSION-RATE-NOT-PUBLISHED`, section 11), a stale cancellation quote
(`REFUND-SLAB-MOVED`, section 12). Those refusals cost one transaction each, in
a case a rider or a buyer app can act on by asking again or asking differently.
Refusing an unattributable sale is not that: `operatingCorporation` is null on
nearly every service this specification ships, so the refusal would not be an
edge case, it would be the default outcome, and it would refuse a seat the real
operator sells today without having solved this problem either - AWATAR takes
the booking, prints the ticket, and the three corporations settle between
themselves afterward. A specimen that is stricter than the system it specimens
is not more honest, it is inventing a rule the incumbent does not have in order
to dodge a problem the incumbent already lives with.

**Attribute provisionally, from the territory the boarding point sits in.**
Tempting because it fills the field with *something*, and wrong for the same
reason section 10.1 already argued against publishing an inferred corporation
on the disclosure - a claim that is sometimes wrong is worse than an admitted
unknown, because it looks resolved when it is not. Territory is a fact about
geography, not about which coach and crew showed up; a coach can be dispatched
from any corporation's depot to run a route through another corporation's
district, which is the entire reason the Hampi corridor is ambiguous in the
first place (KKRTC territory, widely sold and likely operated as a KSRTC
service, section 10.1). Deriving a corporation from territory would not be a
second, independent confirmation of anything - it would be manufacturing a
value at the same `inferred` confidence the field already refuses to publish,
and then treating the manufactured value as though it settled a ledger. Section
10.5 is the sharper version of this argument, because that corridor makes
territory disagree with itself mid-route.

**Record `null`, and reconcile later. The ruling.** `settlement_corporation` is
`NULL` whenever `operatingCorporationBasis` is not `confirmed`, and
`settlement_basis` carries whatever the service's own basis actually is -
`inferred` or `none` - never silently promoted. An unattributed sale is not a
failure state; it is the accurate description of what this provider currently
knows, recorded rather than hidden, exactly as `provenance: 'inferred'` already
is for the same corridors and the same reason (section 3.2). What resolves it
is not this specification: a reconciliation process, run by whoever actually
splits the three corporations' revenue, against whatever record tells them
which depot's coach ran which service on which night - a roster, a driver's own
logbook, a fuel-card charge, none of which this provider has or should invent
access to.

What this specification does own is naming the shape of the backlog that
process would consume, because an honest `null` nobody can query is not
meaningfully better than a guess nobody can check:

```sql
-- Illustrative. Not built by this specimen (section 19): there is no real
-- money to reconcile yet, the same reason there is no payment gateway.
SELECT service_id, travel_date,
       COUNT(*)                                              AS bookings,
       SUM(base_paise + reservation_fee_paise - refund_paise) AS owed_paise
FROM bookings
WHERE settlement_corporation IS NULL
  AND status IN ('CONFIRMED', 'CANCELLED')
GROUP BY service_id, travel_date;
```

`owed_paise` is not the gross fare - section 10.6 below says why, and it is the
same figure a cancelled-and-attributed booking would owe. Grouping by
`(service_id, travel_date)` rather than by booking is deliberate: whoever
eventually confirms which corporation ran a given dated departure resolves
every unattributed booking against that one service instance in a single
stroke, which is the shape the real problem actually has.

### 10.5 The coastal corridor that crosses a boundary

No corridor in section 3.4's shipped fixtures runs this route; it is used here
because it is the sharpest available proof of the resolution rule in 10.3, not
because it ships. The coastal spine from Mangaluru to Karwar crosses a
territorial seam partway along its own length: Dakshina Kannada and Udupi, at
the Mangaluru end, are KSRTC territory; Uttara Kannada, toward Karwar, is
NWKRTC territory [V - `docs/research/karnataka-network-scope.md` section 2, the
confirmed post-2000 territorial split]. A single overnight service can board at
one end and alight at the other, so its boarding point sits in one
corporation's home territory and its dropping point sits in another's, and
neither fact is a claim about who is driving.

**Territory-of-boarding and territory-of-alighting can disagree, and this
provider consults neither.** Section 10.4 already rules out territory as an
attribution source generally; this corridor is why the rule cannot carry a
boundary-crossing exception. If territory were consulted, a coach that boards
in KSRTC's home ground and alights in NWKRTC's would have two candidate answers
from one trip, and picking either - boarding, alighting, or some rule about
which one "counts more" - would be inventing a tie-break for a question
territory was never evidence for in the first place. The operator is a fact
about one vehicle and one crew running one scheduled trip start to finish; it
does not change at a district line, because the vehicle does not swap
corporations mid-route.

**The resolution is the same resolution as any other corridor:
`ReservedService.operatingCorporation`, whole-trip, or `null`.** A single
service has exactly one attribution for its entire run, matching the reality
that one coach makes the whole journey. If the coastal spine's
`operatingCorporation` is confirmed - say, because it is rostered out of a
specific KSRTC depot - the full sale, Mangaluru boarding through Karwar
alighting, is owed to KSRTC, including the leg that physically runs through
Uttara Kannada. If it is unconfirmed, which is the ordinary case per section
10.4, the sale attributes to `null` and reconciles later exactly like every
other service. **The boundary crossing changes nothing about how the sale is
attributed**, and that is the intended outcome of ruling territory out
entirely: a rule with a special case for the corridor that crosses a boundary
would be a rule that was quietly using territory everywhere else.

A rider boarding at an intermediate stop inside either territory still pays the
fare their boarding-to-alighting pair prices (section 4); which district that
boarding point falls in has no bearing on the fare, and, per this section, no
bearing on the corporation the fare is owed to either.

### 10.6 What the rider sees: nothing

**Stated plainly: no settlement field of any kind appears in any response this
provider returns to a rider or to a buyer app acting on one.** Not
`settlement_corporation`, not `settlement_basis`, not the retired
`OPERATOR_DISCLOSURE.CORPORATION` or `CORPORATION_BASIS` (section 10.2), in any
of `on_search`, `on_select`, `on_init`, `on_confirm`, `on_status` or
`on_cancel`, confirmed or not, attributed or not. An unattributed sale is
exactly as invisible to the rider as an attributed one - the honest `null` in
section 10.4 is an accounting state, not a rendering state, and it must never
surface as a gap on a screen the way a missing fare or a missing gps coordinate
correctly does elsewhere in this document. There is no case in which this fact
should reach a rider partially, cautiously, or "for transparency" - the ruling
in section 10.2 is total.

This is the same kind of leak the module-boundary guards in section 2 already
exist to catch for the domain string, extended to a new payload rather than a
new vocabulary:

| Assertion | What it prevents |
|---|---|
| `settlement_corporation`, `settlement_basis` and `SETTLEMENT_CORPORATION` appear nowhere in any generated `on_search`, `on_select`, `on_init`, `on_confirm`, `on_status` or `on_cancel` payload, asserted against every fixture in `tests/fixtures/reserved-golden/` (section 20) | The accounting fact leaking onto a rider's screen through a wire tag nobody remembered to strip |
| `CORPORATION` and `CORPORATION_BASIS` appear nowhere under the `OPERATOR_DISCLOSURE` tag in any of the same fixtures | Section 10.2's ruling regressing under a later edit that reintroduces the field it retired, rather than by anyone deciding to |
| No file responsible for shaping a wire payload (`src/reserved/schema.ts`, and whatever eventually builds `on_confirm`) imports or reads `bookings.settlement_corporation` or `bookings.settlement_basis` | The two columns acquiring a serializer by copy-paste from a neighbouring column that does belong on the wire, such as `refund_paise` |

The middle row earns its own line even though the first row's fixture check
would likely also catch it, for the same reason section 20 keeps its
fare-basis check as two separate assertions rather than one: a single broad
test that happens to catch two different mistakes gives one failure message for
both, and the person reading it should be told which promise broke.

Cancellation's effect on the attribution is specified in section 12, where the
rest of cancellation's arithmetic already lives.

---

## 11. Concessions this category can price, and the several it cannot

KSRTC publishes real concessions, and they are unusually well sourced for this
domain - which makes the ones this provider still cannot encode more instructive
than the ones it can.

**Senior citizens**: 60 and over, Karnataka residents only, 25% off basic fare on
Rajahamsa and lower classes, ID required [V]. **Children**: 6 and under travel
free; 6 to 12 get 50 to 75% off depending on service class; over 12 pay full
adult fare [V]. **The Shakti scheme** (launched 11 June 2023) gives
Karnataka-resident women and gender minorities free travel on ordinary and
express services only, explicitly excluding Rajahamsa, non-AC and AC Streepar,
Airavat, Airavat Club Class, Ambaari, Ambaari Dream, Ambaari Utsav, Fly Bus and
EV Power Plus [V - `bengaluruurban.nic.in`].

### What this provider publishes

**Shakti never applies to anything in this category, and this is a fact rather
than a limitation.** Every class this category sells is a seat-numbered premium
class, and Shakti's own published exclusion list names every one of them. No
Shakti tag exists, no Shakti path exists, and a request naming one is refused
with `CONCESSION-NOT-APPLICABLE` - the same code and the same reasoning as a
concession on a single-journey order (`src/trv11/concession.ts`).

**The senior concession is published on `RAJAHAMSA` only**, because "Rajahamsa
and lower classes" is where the source stops. Where Pallakki sits in that
ordering is not established: it is a non-AC sleeper, below AC sleeper and above
seater by comfort, and no source places it relative to Rajahamsa for concession
purposes. Airavat, Airavat Club and Ambaari Utsav are unambiguously above
Rajahamsa and carry no senior rate.

A concession claim naming a class with no published rate is refused with
**`CONCESSION-RATE-NOT-PUBLISHED`**, the existing code, reusing the existing
message shape:

```
CONCESSION-RATE-NOT-PUBLISHED
  No SENIOR_CONCESSION_PERCENT rate is published for class PALLAKKI on this
  service; this provider publishes a senior rate for RAJAHAMSA only
```

**The child concession is not implemented.** "50 to 75% depending on service
class" is a range, not a rate, and the per-class breakdown behind it was not
found. A midpoint would be an invented number, and this repository already has
one constant in that condition (`docs/passes.md`'s 33% student rate, which the
disclosure describes as "a round number invented so the product exists"). Adding
a second is not a precedent worth extending. Children 6 and under travelling free
is precise, and it interacts with seat allocation - a free child occupies no
numbered seat, or shares a berth - which is a modelling question this category
does not answer. Both are named in section 22.

**Verification is nobody's job here, exactly as before.** This provider trusts
an age and a concession class the buyer app asserts, checks nothing behind them,
and never accepts, stores or logs a document. Senior concession requires an ID at
boarding [V], which is a human check by a conductor, off this network, in the
same shape as the pass concession's face-to-face attestation.

---

## 12. Cancellation: a quote, then a commitment

**Settled: two steps. The refund slab is evaluated server-side at request time
and the exact figure is returned before the rider commits.**

### The slabs

KSRTC's own published reservation terms [V - ksrtc.in/reservation_terms]:

| Time before departure | Deducted from base fare |
|---|---|
| More than 72 hours | 10% |
| 72 to 24 hours | 25% |
| 24 to 2 hours | 50% |
| Less than 2 hours, or after departure | No refund |

The reservation fee is always non-refundable regardless of slab. Toll and bridge
charges are refunded in full regardless of slab [V].

**This is a real, cited operator policy and it is encoded rather than invented**,
which makes it the best-sourced number in this entire category. `ReservedService`
carries `reservationFeePaise` and `tollPaise` as separate fields precisely so the
arithmetic is expressible:

```
refundPaise = round(basePaise × (100 - slabPercent) / 100) + tollPaise
```

with `reservationFeePaise` deducted in full by never entering the sum. The
breakup shows the arithmetic rather than only the result, as the pass quote
already does:

```json
"refund": {
  "price": { "currency": "INR", "value": "412.50" },
  "breakup": [
    { "title": "BASE_FARE",        "price": { "currency": "INR", "value": "550" } },
    { "title": "SLAB_DEDUCTION",   "price": { "currency": "INR", "value": "-137.50" } },
    { "title": "RESERVATION_FEE",  "price": { "currency": "INR", "value": "-20" } },
    { "title": "TOLL_REFUND",      "price": { "currency": "INR", "value": "20" } }
  ]
}
```

**Rounding is round-half-up on paise, and it is genuinely exercised here**,
unlike the pass path where every combination divides exactly
(`docs/passes.md` section 3). A 25% deduction on a ₹550 base is ₹137.50, which is
exact, but a 10% deduction on ₹4,505 is ₹450.50 and a 25% one is ₹1,126.25, which
is not. The rule is stated, tested against the boundary cases, and published in
the terms document so both sides compute the same figure.

### The two steps

**Step one, the quote.** `cancel` with `message.descriptor.code = "SOFT_CANCEL"`
evaluates the slab against this provider's clock and returns `on_cancel` with the
refund breakup, the slab code that applied, and the **quote's own short
expiry** - `PT2M`. Nothing changes state. The booking stays `CONFIRMED`.

**Step two, the commitment.** `cancel` with
`message.descriptor.code = "CONFIRM_CANCEL"`, carrying the `REFUND_QUOTE_ID` from
step one, re-evaluates the slab and either cancels or refuses.

**It re-evaluates rather than trusting the quote, and this is the whole point of
the design.** A rider who quotes at 72 hours and 1 minute and confirms at 71
hours and 59 minutes has crossed from a 10% deduction to a 25% one. Honouring the
stale quote would mean this provider paying a refund its own slab does not
support; honouring the new slab silently would mean the rider committing to one
number and receiving another. So the confirm is **refused** with
`REFUND-SLAB-MOVED`, carrying the new quote in the same response, and the rider
sees the real number before committing again. The two-minute quote expiry makes
this a rare path rather than a routine one.

The naming here is this document's own. Beckn models cancellation richly and
TRV11 carries nine distinct cancellation flows (`SPEC.md` section 2.2), including
soft and confirmed variants, and the two-step shape is modelled on that idiom.
**The exact values `SOFT_CANCEL` and `CONFIRM_CANCEL`, and the tag codes
`REFUND_SLAB`, `REFUND_QUOTE_ID` and `SLAB_CODE`, are unverified against any
published enumeration** and must be pinned before anyone relies on them, in the
same condition and for the same reason as `authorization.status: "ISSUED"` on the
pass path.

### Partial cancellation

One or more seats from a multi-seat booking may be cancelled, leaving the rest
`CONFIRMED`. The slab applies to the cancelled seats' share of the base fare;
the reservation fee is deducted once per cancelled seat; the toll share is
refunded for the cancelled seats.

This is what makes section 7's relock reachable, and it is the reason partial
cancellation is in scope at all rather than deferred: a design with a gender
adjacency rule and no way to release one seat of a pair has a rule nothing can
exercise.

Cancelling every remaining seat cancels the booking. A booking with no
`CONFIRMED` seats left is `CANCELLED`, not an empty `CONFIRMED` booking.

### After departure

`cancel` on a booking whose departure instant has passed returns the no-refund
slab and, on `CONFIRM_CANCEL`, moves the booking to `CANCELLED` with
`refund_paise = 0`. It does not refuse. The rider is entitled to have the record
say what happened, and refusing would leave a booking that reads as live for a
coach that has gone.

**"Cancelled" and "completed" are different words for different facts.** Tatak's
spec settles the display vocabulary and this provider's stored states must
support it: a `CONFIRMED` booking past its own departure, never cancelled, is
`Completed` - a claim about the booking's state machine, not about whether the
rider boarded, since nobody scans a coach ticket at the door. A `HELD` row whose
hold lapsed is `EXPIRED`, which means something unrelated and must not share a
word with either. The four stored states in section 15 are exactly the four that
distinction needs.

### Cancellation reverses an attribution, not a fact about who ran the service

A refund reverses money, not history. Cancelling a `CONFIRMED` booking does not
change `settlement_corporation` or `settlement_basis` (section 10.3) - whichever
corporation the confirmed sale was owed to, or, per section 10.4, was not yet
known to be owed to, is unaffected by whether the passenger later cancelled,
because the attribution is a claim about which corporation actually ran the
service, and a cancellation changes nothing about that. What changes is how
much of the sale is still owed.

**The reservation fee is never refunded, so it is never reversed either.** A
whole-booking cancellation leaves the reservation fee, plus whatever share of
the base fare the applicable slab retains, still owed to whichever corporation
the booking was attributed to. The toll is not part of this at all: it is
refunded in full in every slab because it was never the corporation's revenue
to begin with - a pass-through to a toll authority - and a settlement
attribution was never claiming that portion in the first place.

The amount still owed after a cancellation is derivable from the figures this
provider already stores, and it needs no column of its own:

```
retainedPaise = round(basePaise × slabPercent / 100) + reservationFeePaise
```

which is the complement of this section's own `refundPaise` formula
(`round(basePaise × (100 - slabPercent) / 100) + tollPaise`) - the two split the
same base fare between the rider and the corporation, and the toll sits outside
the split on both sides. Nothing new is stored: `base_paise`,
`reservation_fee_paise` and `refund_paise` are already on the `bookings` row
(section 15), computed once at the moment of cancellation and never
re-evaluated (section 13), and `retainedPaise` is arithmetic over them at read
time, not a fact that needs its own frozen copy.

**Partial cancellation prorates the retained amount the same way it already
prorates the refund.** This section's partial-cancellation rule deducts the
reservation fee once per cancelled seat and applies the slab to each cancelled
seat's base-fare share; the retained amount for a partial cancellation is the
same `retainedPaise` formula summed over the cancelled seats only, leaving the
uncancelled seats' full base fare, plus their own reservation fees, owed as an
ordinary confirmed sale. A booking with three attributed seats, one cancelled,
owes the attributed corporation two full seats' worth of revenue and one
cancelled seat's retained share - never zero, and never the whole original
sale, for the same reason the refund itself is neither.

**An unattributed booking that gets cancelled reconciles for the retained
amount, not the gross fare.** Section 10.4's reconciliation query already
reflects this - it sums `base_paise + reservation_fee_paise - refund_paise`
rather than the raw fare, and includes `CANCELLED` bookings alongside
`CONFIRMED` ones for exactly this reason. Whoever eventually resolves a `null`
attribution is resolving a claim on whatever is actually still owed at that
point, cancellations included, not on a snapshot of the original sale.

---

## 13. Idempotency

The existing confirm path already does most of this and the reserved path
inherits it rather than reinventing it. `TransitOrderService.confirm` keys on
`(operator, bap_id, bap_uri, transaction_id)`, returns an already-confirmed order
unchanged if one exists, and coalesces a concurrently in-flight confirm through a
promise keyed the same way (`src/orders/service.ts`). The transaction identity,
not a client-supplied header, is the idempotency key - which is right, because a
Beckn `transaction_id` is already defined as constant for the whole life of one
order (`SPEC.md` section 3.3).

| Action | Repeat behaviour |
|---|---|
| `search` | Pure. Same inputs, same catalogue, because occupancy is seeded (section 6). |
| `select`, no seats | Pure. |
| `select`, same seats, same transaction | Returns the same `HOLD_ID` and the **same, unextended** `EXPIRES_AT` (section 8.2). |
| `select`, different seats, same transaction | Releases the previous hold and takes a new one, in one database transaction. |
| `init` | Idempotent. Re-stating the manifest against a live hold replaces it wholesale; the hold is untouched. |
| `confirm` | Returns the existing booking, unchanged, including its reference. Never a second booking. |
| `status` | Pure. |
| `cancel` / `SOFT_CANCEL` | Not idempotent by design: it is a quote against the clock, and the clock moves. Each call returns a fresh quote with a fresh id and expiry. |
| `cancel` / `CONFIRM_CANCEL` | Idempotent on an already-cancelled booking: returns the **stored** refund figure and slab code from the cancellation that actually happened, never a re-evaluation. |

That last row is the one worth being explicit about. Re-evaluating the slab on a
repeated confirm would return a smaller refund as time passed, for a cancellation
that already completed, which would make a retry look like a penalty. The figure
is computed once, at the moment of cancellation, stored in
`bookings.refund_paise` and `bookings.slab_code`, and read back thereafter.

---

## 14. The wire: actions, shapes and vocabulary

Endpoints follow the existing per-operator prefix (`src/app.ts`), with `ksrtc`
joining `bmtc` and `bmrcl`:

| Method | Path | Then POSTs to bpp-client |
|---|---|---|
| POST | `/ksrtc/search` | `/on_search` |
| POST | `/ksrtc/select` | `/on_select` |
| POST | `/ksrtc/init` | `/on_init` |
| POST | `/ksrtc/confirm` | `/on_confirm` |
| POST | `/ksrtc/status` | `/on_status` |
| POST | `/ksrtc/cancel` | `/on_cancel` |
| POST | `/ksrtc/inbound` | dispatches by `context.action` |

`/ksrtc/inbound` exists for the same reason the other two operators have one: the
pinned ONIX protocol server exposes one `client.webhook.url` per BPP rather than
one per action, which the README already records as contradicting `SPEC.md`
section 6.1.

Every callback is asynchronous. The inbound action is `ACK`ed on the open
connection and the answer arrives as a separate POST, exactly as today. A domain
error - a locked seat, a lapsed hold, a missing fare - arrives as an `error` on
the callback with no `message.order`, which is this stack's equivalent of a NACK
for a domain error and the path every existing `OrderLifecycleError` already
takes.

### 14.1 `search`

```json
{
  "context": {
    "domain": "TRANSIT.LOCALHOST:INTERCITY",
    "version": "0.1.0",
    "action": "search",
    "location": { "country": { "code": "IND" }, "city": { "code": "std:080" } },
    "bap_id": "bap.transit.localhost",
    "bap_uri": "http://bap-network:5002",
    "transaction_id": "…", "message_id": "…",
    "timestamp": "2026-09-05T09:14:02.000Z", "ttl": "PT15S"
  },
  "message": {
    "intent": {
      "category": { "descriptor": { "code": "RESERVED" } },
      "fulfillment": {
        "stops": [
          { "type": "START", "location": { "descriptor": { "code": "BLR" } } },
          { "type": "END",   "location": { "descriptor": { "code": "HMP" } } }
        ],
        "travel_date": "2026-09-25"
      },
      "vehicle": { "category": "COACH" },
      "item": { "descriptor": { "code": "PALLAKKI" } }
    }
  }
}
```

**`travel_date` is a bare ISO calendar date in `Asia/Kolkata`, and it is
mandatory.** Not an instant. Tatak's spec is emphatic about why, having found
that its own planner collapses an ISO timestamp to a time of day and silently
discards the date component: "the caller must name the date it means" (section
3). A reserved search with no `travel_date` is refused with
`TRAVEL-DATE-REQUIRED` rather than defaulting to today, because defaulting to
today is exactly the silent discard that motivated the field.

The endpoints name **towns**, not boarding points. A rider searching Bengaluru to
Hampi has not chosen a pickup yet, and the boarding-point choice is a
consequence of the service (sheet 06 in the brief). `item.descriptor.code` is an
optional class filter.

### 14.2 `on_search`

One provider, whose `categories` gain a third entry alongside `TICKET` and
`PASS`, and whose items are dated service instances:

```json
{
  "message": { "catalog": {
    "descriptor": { "name": "Karnataka State Road Transport Corporation Specimen Reserved Catalogue" },
    "providers": [{
      "id": "P1",
      "descriptor": { "name": "Karnataka State Road Transport Corporation" },
      "categories": [
        { "id": "C1", "descriptor": { "name": "Ticket",   "code": "TICKET" } },
        { "id": "C2", "descriptor": { "name": "Pass",     "code": "PASS" } },
        { "id": "C3", "descriptor": { "name": "Reserved", "code": "RESERVED" } }
      ],
      "items": [{
        "id": "RSV-2259BNGHMP-2026-09-25-PALLAKKI",
        "category_ids": ["C3"],
        "descriptor": { "name": "Pallakki non-AC sleeper", "code": "RESERVED" },
        "price": { "currency": "INR", "value": "550" },
        "quantity": { "available": { "count": 19 }, "maximum": { "count": 6 }, "minimum": { "count": 1 } },
        "fulfillment_ids": ["F-RSV-2259BNGHMP-2026-09-25-PALLAKKI"],
        "time": { "label": "Departure", "timestamp": "2026-09-25T22:59:00.000+05:30" },
        "tags": [
          { "descriptor": { "code": "SERVICE_INFO" }, "list": [
            { "descriptor": { "code": "SERVICE_ID" },     "value": "2259BNGHMP" },
            { "descriptor": { "code": "SERVICE_NUMBER" }, "value": "2259" },
            { "descriptor": { "code": "TRAVEL_DATE" },    "value": "2026-09-25" },
            { "descriptor": { "code": "SERVICE_CLASS" },  "value": "PALLAKKI" },
            { "descriptor": { "code": "RUNNING_MINUTES" }, "value": "451" } ] },
          { "descriptor": { "code": "PRICED_FOR" }, "display": false, "list": [
            { "descriptor": { "code": "FROM_BOARDING_POINT_ID" }, "value": "BP-BLR-MAJESTIC" },
            { "descriptor": { "code": "TO_BOARDING_POINT_ID" },   "value": "BP-HMP-HAMPI" } ] },
          { "descriptor": { "code": "OPERATOR_DISCLOSURE" }, "display": true, "list": [
            { "descriptor": { "code": "BRAND" }, "value": "KSRTC" } ] },
          { "descriptor": { "code": "SERVICE_PROVENANCE" }, "display": false, "list": [
            { "descriptor": { "code": "BASIS" }, "value": "inferred" },
            { "descriptor": { "code": "SOURCE_COUNT" }, "value": "1" } ] },
          { "descriptor": { "code": "SIMULATED_INVENTORY" }, "display": true, "list": [
            { "descriptor": { "code": "NOTICE" }, "value": "Modelled inventory. The seats shown as sold are simulated by this specimen provider, not KSRTC's live availability." } ] },
          { "descriptor": { "code": "SPECIMEN_INFO" }, "display": true, "list": [
            { "descriptor": { "code": "NOTICE" }, "value": "SPECIMEN - NOT VALID FOR TRAVEL" } ] }
        ]
      }],
      "fulfillments": [{
        "id": "F-RSV-2259BNGHMP-2026-09-25-PALLAKKI",
        "type": "RESERVATION",
        "vehicle": { "category": "COACH" },
        "stops": [
          { "id": "1", "type": "START", "location": { "descriptor": { "name": "Majestic (Kempegowda Bus Station)", "code": "BP-BLR-MAJESTIC" } },
            "time": { "timestamp": "2026-09-25T22:59:00.000+05:30" } },
          { "id": "2", "parent_stop_id": "1", "type": "INTERMEDIATE_STOP",
            "location": { "descriptor": { "name": "Madiwala", "code": "BP-BLR-MADIWALA" } },
            "time": { "timestamp": "2026-09-25T23:31:00.000+05:30" } },
          { "id": "3", "parent_stop_id": "2", "type": "END",
            "location": { "descriptor": { "name": "Hampi", "code": "BP-HMP-HAMPI" } },
            "time": { "timestamp": "2026-09-26T06:30:00.000+05:30" } }
        ],
        "tags": [ { "descriptor": { "code": "SEAT_MAP_REF" }, "list": [
          { "descriptor": { "code": "SEAT_MAP_ID" }, "value": "PALLAKKI-2P1-30" } ] } ]
      }]
    }]
  } }
}
```

**`quantity.available.count` is the seats-remaining integer**, published quietly
and without adornment. The brief's ruling governs how it renders and this
provider must not make that harder: it never animates, never turns red, and never
appears without the rider having asked for that service. Publishing a number is
this provider's job; refusing to dress it as urgency is the client's, and the
wire carries nothing that would encourage the dressing - no `low_stock` flag, no
threshold, no percentage.

**Stop timestamps are absolute and cross midnight.** The Hampi arrival is
2026-09-26, one calendar day after the travel date. This is the case the
existing paths have never produced, and it is why `travel_date` and the
departure instant are separate fields rather than one.

### 14.3 `select`

Two shapes, distinguished by whether `seats` is empty.

```json
{ "message": { "order": {
  "provider": { "id": "P1" },
  "items": [{ "id": "RSV-2259BNGHMP-2026-09-25-PALLAKKI",
              "quantity": { "selected": { "count": 2 } } }],
  "fulfillments": [{ "id": "F-RSV-2259BNGHMP-2026-09-25-PALLAKKI",
    "stops": [
      { "type": "START", "location": { "descriptor": { "code": "BP-BLR-MADIWALA" } } },
      { "type": "END",   "location": { "descriptor": { "code": "BP-HMP-HOSAPETE" } } } ] }],
  "tags": [ { "descriptor": { "code": "SEATS" }, "list": [
    { "descriptor": { "code": "SEAT_ID" }, "value": "L2A" },
    { "descriptor": { "code": "SEAT_ID" }, "value": "L2B" } ] } ]
} } }
```

`quantity.selected.count` must equal the number of `SEAT_ID` entries when any are
present, and the mismatch is refused with `SEAT-COUNT-MISMATCH` rather than one
of the two winning. The boarding pair is named here because it is half the fare
key.

`on_select` with an empty seat list returns the order with a `SEAT_MAP` tag and
the fare for the chosen boarding pair, and no `HOLD_INFO`. With seats, it returns
the priced quote and `HOLD_INFO` (section 8.3). Either way the seat map comes
back, so a client always has a current view without a second call:

```json
{ "descriptor": { "code": "SEAT_MAP" }, "display": false, "list": [
  { "descriptor": { "code": "SEAT_MAP_ID" }, "value": "PALLAKKI-2P1-30" },
  { "descriptor": { "code": "L1A" }, "value": "SOLD:simulated" },
  { "descriptor": { "code": "L1B" }, "value": "FEMALE_ONLY" },
  { "descriptor": { "code": "L1C" }, "value": "AVAILABLE" },
  { "descriptor": { "code": "L2A" }, "value": "HELD_BY_YOU" },
  { "descriptor": { "code": "L2B" }, "value": "HELD_BY_YOU" },
  { "descriptor": { "code": "L3C" }, "value": "HELD" },
  { "descriptor": { "code": "U1A" }, "value": "SOLD:booked" }
] }
```

Five states, and the brief's sheet 04 asks for four plus the rider's own
selection, drawn with no red and no green. `SOLD:simulated` and `SOLD:booked`
render identically to a rider and differ on the wire, so a client that wants to
say "sold in this demonstration" about one and nothing about the other can.

### 14.4 `init`

Adds `billing` (one name, one phone for the order), a `payments` array with
`status: NOT_PAID`, and the manifest:

```json
{ "descriptor": { "code": "MANIFEST" }, "display": false, "list": [
  { "descriptor": { "code": "SEAT_ID" }, "value": "L2A" },
  { "descriptor": { "code": "NAME" },    "value": "A Passenger" },
  { "descriptor": { "code": "AGE" },     "value": "34" },
  { "descriptor": { "code": "GENDER" },  "value": "female" },
  { "descriptor": { "code": "SEAT_ID" }, "value": "L2B" },
  { "descriptor": { "code": "NAME" },    "value": "B Passenger" },
  { "descriptor": { "code": "GENDER" },  "value": "male" }
] }
```

Entries are read as records delimited by each `SEAT_ID`, in order. `AGE` is
omitted rather than sent as `null` or `0` when unknown, the same
absence-means-say-nothing discipline the pass path already applies to a missing
concession. A code other than the four is refused (section 9).

`on_init` re-validates the gender locks against the manifest, because the manifest
is the first point at which this provider learns which gender is going in which
seat - the hold taken at `select` named seats only. A lock violation surfaces
here rather than at `confirm`, which is where the rider can still act on it.

### 14.5 `confirm` and `on_confirm`

`confirm` carries `payments[].status: PAID`, a payment id and `params`, exactly as
the existing paths do, and `HOLD_ID`. `on_confirm` returns the booking:

```json
{ "message": { "order": {
  "id": "SPECIMEN-RSV-KSRTC-7A19C42E",
  "status": "ACTIVE",
  "fulfillments": [{
    "id": "F-RSV-2259BNGHMP-2026-09-25-PALLAKKI",
    "type": "RESERVATION",
    "tags": [
      { "descriptor": { "code": "BOOKING_REF" }, "list": [
        { "descriptor": { "code": "NUMBER" }, "value": "SPECIMEN-KSRTC-7A19C42E" } ] },
      { "descriptor": { "code": "MANIFEST" }, "list": [ "…as sent…" ] },
      { "descriptor": { "code": "VEHICLE_LOOKUP" }, "display": false, "list": [
        { "descriptor": { "code": "SERVICE_ID" },  "value": "2259BNGHMP" },
        { "descriptor": { "code": "TRAVEL_DATE" }, "value": "2026-09-25" } ] },
      { "descriptor": { "code": "SPECIMEN_INFO" }, "display": true, "list": [
        { "descriptor": { "code": "NOTICE" },
          "value": "SPECIMEN - NOT VALID FOR TRAVEL - not issued by KSRTC, NWKRTC or KKRTC" } ] }
    ]
  }],
  "cancellation_terms": [ { "external_ref": { "mimetype": "text/html", "url": "…/terms" } } ]
} } }
```

**There is no `authorization` object anywhere on a reserved fulfillment.** No QR,
no TOTP, no token. Section 9 argues why: the boarding check is a manifest, not a
reader, and minting a credential would model a verification nobody performs.

`BOOKING_REF.NUMBER` is **this provider's own reference, not an operator PNR**,
and the `SPECIMEN-` prefix says so on its face. Tatak's spec calls for a PNR-like
reference "generated by Tatak's own reservation subsystem (there being no real
operator system to issue one against)"; under decision 1 the generator moves
here, and the reasoning is unchanged.

`VEHICLE_LOOKUP` carries the two fields a vehicle join needs and nothing else.
Section 18.

### 14.6 `status`

Unchanged in shape from the existing path: `{ order_id }` or `{ ref_id }`,
returning the stored booking. `ref_id` accepts the booking reference, which is
the lookup path a rider who has only a printed reference needs.

### 14.7 `cancel` and `on_cancel`

```json
{ "message": {
  "order_id": "SPECIMEN-RSV-KSRTC-7A19C42E",
  "descriptor": { "code": "SOFT_CANCEL" },
  "tags": [ { "descriptor": { "code": "SEATS" }, "list": [
    { "descriptor": { "code": "SEAT_ID" }, "value": "L2A" } ] } ]
} }
```

Omitting `SEATS` cancels the whole booking. `on_cancel` for `SOFT_CANCEL` returns
the refund breakup, `SLAB_CODE`, `REFUND_QUOTE_ID` and the quote's expiry, with
the order unchanged. For `CONFIRM_CANCEL` it returns the order at
`status: CANCELLED` (or still `ACTIVE` with the cancelled seats removed, on a
partial) carrying the stored refund.

### 14.8 The vocabulary this document introduces

Every code here is **this document's own naming**, not a transcription of a
published enumeration, for the reason section 2 gives: there is no released
specification to transcribe from. Kept in one table so a future TRV12 mapping is
a table-to-table exercise.

| Code | Where | Carries |
|---|---|---|
| `RESERVED` | `Category.descriptor.code`, `Item.descriptor.code` | The third catalogue axis |
| `RESERVATION` | `Fulfillment.type` | Parallel to `TRIP` and `PASS` |
| `COACH` | `vehicle.category` | Parallel to `BUS` and `METRO` |
| `travel_date` | `intent.fulfillment` | ISO calendar date, IST |
| `quantity.available.count` | `Item.quantity` | Seats remaining |
| `SERVICE_INFO` | Item tag | `SERVICE_ID`, `SERVICE_NUMBER`, `TRAVEL_DATE`, `SERVICE_CLASS`, `RUNNING_MINUTES` |
| `PRICED_FOR` | Item tag | `FROM_BOARDING_POINT_ID`, `TO_BOARDING_POINT_ID` - the pair the headline price is for (§17.1) |
| `SERVICE_PROVENANCE` | Item tag | `BASIS`, `SOURCE_COUNT` |
| `OPERATOR_DISCLOSURE` | Item tag | `BRAND` only. `CORPORATION` and `CORPORATION_BASIS` are retired by section 10.2's ruling; the corporation is a settlement fact (§10.3), never a wire field |
| `SIMULATED_INVENTORY` | Item tag | `NOTICE` |
| `SEAT_MAP_REF` / `SEAT_MAP` | Fulfillment tag / order tag | `SEAT_MAP_ID`, then one entry per seat |
| `SEATS` | Order tag, cancel message tag | One `SEAT_ID` per seat |
| `HOLD_INFO` | Order tag | `HOLD_ID`, `EXPIRES_AT`, `TTL_SECONDS` |
| `MANIFEST` | Fulfillment tag | `SEAT_ID`/`NAME`/`AGE`/`GENDER` records |
| `BOOKING_REF` | Fulfillment tag | `NUMBER` |
| `VEHICLE_LOOKUP` | Fulfillment tag | `SERVICE_ID`, `TRAVEL_DATE` |
| `REFUND_SLAB` | `on_cancel` message tag | `SLAB_CODE`, `PERCENT`, `REFUND_QUOTE_ID`, `QUOTE_EXPIRES_AT` |

### 14.9 Error codes

| Code | Meaning |
|---|---|
| `TRAVEL-DATE-REQUIRED` | A reserved search carried no `travel_date` |
| `SERVICE-NOT-FOUND` | No such service, or it does not run on that date |
| `OUTSIDE-BOOKING-WINDOW` | Too soon or too far out; names which edge and the boundary instant |
| `FARE-NOT-PUBLISHED` | No fare cell for that boarding pair and class |
| `SEAT-NOT-ON-MAP` | A seat id this class's seat map does not contain |
| `SEAT-UNAVAILABLE` | Held or sold; names the seats and returns the current map |
| `SEAT-GENDER-LOCKED` | Names the seat and the required gender, never the neighbour |
| `SEAT-COUNT-MISMATCH` | `quantity.selected.count` disagrees with the seat list |
| `HOLD-REQUIRED` | `init` or `confirm` with no live hold for this transaction |
| `HOLD-EXPIRED` | Names the published expiry instant |
| `HOLD-SEAT-MISMATCH` | Confirm's seats do not equal the hold's |
| `MANIFEST-INCOMPLETE` | A held seat has no manifest record |
| `MANIFEST-FIELD-NOT-ACCEPTED` | Names the unexpected codes, never their values |
| `CONCESSION-RATE-NOT-PUBLISHED` | Reused from the pass path, unchanged |
| `CONCESSION-NOT-APPLICABLE` | Reused; also covers a Shakti claim |
| `BOOKING-NOT-FOUND` | Unknown reference, or belongs to another BAP |
| `REFUND-SLAB-MOVED` | Carries the new quote |
| `REFUND-QUOTE-EXPIRED` | The `PT2M` quote lapsed |
| `MIXED-CATEGORY-ORDER` | Reused; a reserved item cannot share an order with a ticket or a pass |

---

## 15. Storage and migrations

### Why this category cannot stay in memory

`InMemoryOrderStore` is correct for what it holds today. A confirmed specimen
ticket is a settled fact whose loss costs nothing: the rider's own device holds
the wallet, and two devices disagreeing about whether a ticket exists costs
nothing because neither can invalidate the other.

**A held or booked seat is the opposite.** It is a shared, finite resource, and a
process restart that forgot every hold and every booking would release seats
somebody is mid-checkout on, orphan bookings a buyer app still displays, and make
"how many seats are left" a function of this provider's uptime. Tatak's spec
identifies the same inversion from its own side and scopes it tightly: for the
window between held and confirmed-or-released, the server row **is** the fact
rather than a copy of one.

Under decision 1 the party holding that row is this provider, and the fact must
outlive a release. The accounts layer on the app side already made this move -
"the accounts layer runs on libSQL, so a session survives a release" - and the
same engine and the same conventions apply here.

**libSQL, one file, no extra service.** `RESERVED_DB_URL` defaults to
`file:./data/reserved.db`, and `:memory:` in tests. A stranger cloning the
repository still runs it with nothing else up, which is the property section 16
exists to protect.

### The schema

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- One row per seat that is not free. Holds and bookings share this table
-- because they are the same claim on the same resource at two strengths,
-- and one unique index over both is what makes double-booking impossible.
CREATE TABLE seat_locks (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  travel_date  TEXT NOT NULL,          -- ISO YYYY-MM-DD, Asia/Kolkata
  seat_id      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('HELD','BOOKED','EXPIRED','RELEASED')),
  hold_id      TEXT,                   -- non-null while HELD
  booking_id   TEXT REFERENCES bookings(id),
  operator     TEXT NOT NULL,
  bap_id       TEXT NOT NULL,
  bap_uri      TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  expires_at   INTEGER,                -- HELD only; NULL once BOOKED
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX seat_locks_live
  ON seat_locks (service_id, travel_date, seat_id)
  WHERE state IN ('HELD','BOOKED');

CREATE INDEX seat_locks_service_date ON seat_locks (service_id, travel_date);
CREATE INDEX seat_locks_hold ON seat_locks (hold_id) WHERE hold_id IS NOT NULL;

CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,     -- SPECIMEN-RSV-<OP>-<HEX>
  reference      TEXT NOT NULL UNIQUE, -- SPECIMEN-<OP>-<HEX>, the rider-facing one
  operator       TEXT NOT NULL,
  bap_id         TEXT NOT NULL,
  bap_uri        TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  service_id     TEXT NOT NULL,
  travel_date    TEXT NOT NULL,
  service_class  TEXT NOT NULL,
  from_boarding_point_id TEXT NOT NULL,
  to_boarding_point_id   TEXT NOT NULL,
  departure_at   INTEGER NOT NULL,     -- absolute epoch ms; the slab keys on this
  status         TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED')),
  base_paise             INTEGER NOT NULL,
  reservation_fee_paise  INTEGER NOT NULL,
  toll_paise             INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  cancelled_at   INTEGER,
  -- Computed once, at the moment of cancellation, never re-evaluated (§13).
  refund_paise   INTEGER,
  slab_code      TEXT,
  order_json     TEXT NOT NULL         -- the on_confirm order, as sent
);

CREATE UNIQUE INDEX bookings_transaction
  ON bookings (operator, bap_id, bap_uri, transaction_id);

-- Personal data. Retention: section 15's note. Nothing identifying beyond a
-- name is ever accepted here (§9).
CREATE TABLE booking_seats (
  booking_id  TEXT NOT NULL REFERENCES bookings(id),
  seat_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  age         INTEGER,                 -- NULL means not supplied, never 0
  gender      TEXT CHECK (gender IN ('male','female','other')),
  status      TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED')),
  PRIMARY KEY (booking_id, seat_id)
);
```

`bookings_transaction` is the idempotency key from section 13 expressed as a
constraint, so a second confirm on the same transaction cannot create a second
booking even if the application-level check is bypassed.

### Migrations

Numbered, forward-only, plain SQL under `migrations/`, applied at boot inside a
transaction, recorded in `schema_migrations`. No down migrations: a rollback of a
schema change to a table holding live holds is a data-loss operation dressed as a
convenience, and the honest recovery is a forward migration. The application
refuses to start if the file's version is ahead of the code's, because a newer
schema read by older code is how a hold quietly stops being honoured.

### Retention

`booking_seats` holds names and, where supplied, ages. `RESERVED_MANIFEST_RETENTION_DAYS`
(default `30`) drops manifest rows for bookings whose departure passed more than
that long ago, on the same lazy sweep as expired holds. The booking row itself
survives, because a rider needs to see that a journey happened; the names do not,
because nothing needs them once the coach has gone. The `GET /orders/:orderId`
inspection endpoint, already bearer-gated and off unless
`ORDER_INSPECTION_TOKEN` is set, now returns manifest names as well as tokens -
which makes leaving it enabled on a shared host a more consequential decision
than it already was, and `docs/passes.md` section 6's note about that should be
extended rather than repeated.

### If this ever runs behind more than one replica

The unique index remains the guarantee, provided every replica writes to one
libSQL server rather than to its own file. The lazy sweep is safe under
concurrency because it runs inside the acquiring transaction. What would break is
the in-process promise-coalescing in `TransitOrderService.confirm`, which
deduplicates only within one process; the `bookings_transaction` unique index is
what catches the cross-replica case, and the confirm path must translate its
violation into "return the existing booking" rather than into an error. Worth
writing now, since it costs a `catch` and buys correctness under a deployment
this repository might plausibly reach.

---

## 16. The source interface, and the fixture strategy

### `ReservedServiceSource`

The protocol layer must not know about Karnataka, exactly as it does not know
about Bengaluru today. `JourneySource` (`src/sources/types.ts`) is the precedent
and this is its parallel:

```ts
export interface ReservedServiceSource {
  readonly operator: OperatorProfile

  /** Services running between two towns on one calendar date. */
  services(query: ReservedSearchQuery): Promise<ReservedService[]>

  /** The seat map a class uses. Authored per class, not per service. */
  seatMap(seatMapId: string): Promise<SeatMap | undefined>

  /** The fare table a service references. */
  fareTable(fareTableId: string): Promise<FareTable | undefined>
}

export interface ReservedSearchQuery {
  fromTownCode: string
  toTownCode: string
  /** ISO YYYY-MM-DD in Asia/Kolkata. Never an instant. */
  travelDate: string
  serviceClass?: ServiceClass
  cityCode: string
}
```

Everything downstream of `ReservedService` is protocol shaping and lives here.
Everything upstream is somebody's transit data. Two implementations, matching the
existing pattern exactly:

- **`FixtureReservedSource`, the default.** Reads JSON from
  `fixtures/ksrtc/`. No harvester, no database of Karnataka, no cold start. A
  stranger clones the repository and gets a working reserved-intercity BPP in
  under five minutes with nothing else up. This is what makes the repository
  worth publishing, and it is the same argument `SPEC.md` section 7.2 makes for
  `FixtureJourneySource`.
- **`HttpReservedSource`, optional.** `RESERVED_SOURCE=http` plus
  `RESERVED_SOURCE_URL`, a five-second timeout, and a fall back to fixtures on
  timeout or error with a logged `FALLBACK` event - byte for byte the behaviour
  `HttpJourneySource` already implements. The contract is published as
  `docs/reserved-source-http.md` and as a JSON Schema in
  `schemas/reserved-source-response.json`, so **any** dataset can satisfy it,
  including the harvested three-operator dataset Tatak's spec sub-project B
  builds. Neither repository depends on the other.

**Inventory is never in the source.** A source supplies services, seat maps and
fares - the static shape of what is sellable. Occupancy is seeded here (section
6) and holds and bookings live here (section 15). A source that could supply
"which seats are sold" would be a source that had live operator inventory, which
is exactly the thing nobody has.

### The fixtures

```
fixtures/ksrtc/
  operator.json          # OperatorProfile: id, name, vehicleCategory COACH, window
  towns.json             # BLR, HMP, HPT, MYS, MDK, MAA - code, name, nameLocal
  boarding-points.json   # per town, with reportingOffsetMinutes and optional gps
  services.json          # the three corridors of §3.4, each with its sourcing label
  seatmaps/
    AIRAVAT-2P2-53.json
    AIRAVAT_CLUB-2P2-53.json
    RAJAHAMSA-2P2-53.json
    PALLAKKI-2P1-30.json
    AMBAARI_UTSAV-2P1-30.json
  fares/
    FT-BNGHMP.json       # per-cell sourcing: V | S | I
    FT-BNGMAA.json
    FT-MYSMDK.json
```

Every fixture file carries a top-level `sourcing` block naming what its figures
came from and how strongly, in the same terms section 0 defines. A fixture whose
`provenance` claims `confirmed` with fewer than two named sources fails the
integrity test in section 20. **The fixtures are the fabrication disclosure in
machine-readable form**, which is a stronger discipline than a prose disclosure
alone, because it cannot go stale relative to the data it describes.

Fixture load validates the whole set at boot, as `validateOfferSet` already does:
every service's `seatMapId` and `fareTableId` resolve; every boarding point named
in a fare cell exists on the service; every seat map's `adjacentSeatIds` and
`pairedSeatId` are symmetric and reference seats that exist; every seat map's
seat count matches its class's documented capacity where one is documented. A
broken fixture fails at boot rather than at the first `select`.

---

## 17. The contract with Tatak

**Settled: this provider is the system of record for intercity inventory.**
Services, seat maps, holds, bookings, manifests and cancellations live here. The
buyer app never owns inventory and never computes a fare.

Tatak's statewide spec was written before that was settled, as a self-contained
design in which the app simulated its own seat inventory, held its own
`reservations` rows and computed its own fares. Most of it survives unchanged;
some of it moves. Naming exactly which, rather than leaving two documents to be
read against each other:

### What the buyer app may assume

- **Item ids are opaque and encode the date.** Never parse one. The
  `SERVICE_INFO` tag carries `SERVICE_ID`, `TRAVEL_DATE` and `SERVICE_CLASS` as
  fields precisely so nothing has to.
- **The quote is the price, and it is the only price.** There is no client-side
  fare arithmetic for this category and no second opinion to check it against.
  Section 17.1 is the whole argument, because an earlier draft of this document
  got it wrong by analogy and the wrong version would have licensed reusing
  machinery whose justification does not exist here.
- **The hold expiry is absolute and authoritative.** The app renders
  `EXPIRES_AT`; it does not add ten minutes to anything. The ten-minute constant
  leaves the app's code.
- **`quantity.available.count` is an integer or absent.** Absent means not
  computed, never zero. This is `seatsRemaining: number | null` on the app side,
  and the null discipline is unchanged.
- **A seat map is simulated and says so.** The app's `SIMULATED_INVENTORY_MARK`
  survives, marking a value received rather than a value computed, and it must
  still be undroppable by a caller.
- **`operatingCorporation` never reaches the app at all.** Section 10.2's ruling
  retired `OPERATOR_DISCLOSURE.CORPORATION` and `CORPORATION_BASIS` from the
  wire entirely; the app renders `brand` and nothing else, in every case, not
  only when the corporation happens to be unknown. The fact still exists -
  section 10.3 - but it settles a ledger this provider keeps, not a screen the
  app draws.
- **The refund figure comes from a `SOFT_CANCEL` and may move.** The app shows
  the quote, and handles `REFUND-SLAB-MOVED` by re-showing rather than by
  retrying silently. Sheet 08's "refund slab shown before the money moves" is a
  quote, not a computation.
- **The booking reference is this provider's own, not an operator PNR.** It is
  prefixed `SPECIMEN-`.
- **There is no bay, and there will not be one.** Section 9.1 declines the field
  outright rather than shipping it permanently null. Sheet 09's headline has to
  become the boarding point and its reporting time, with the service number
  beside it and *bay announced at the station* where the number was. **This is
  the one place a ruling in this document requires a mockup already built to
  change**, and it is cheaper to change now than to discover during wiring that
  the largest element on the ticket has nothing behind it.
- **`SERVICE_NUMBER` is the rider-facing coach identifier**, distinct from
  `SERVICE_ID`, which is a join key and must never be shown. Section 9.2.
- **`ONDC_ENABLED` is irrelevant to this category.** Tatak's spec is right that
  reservations should not ride the ONDC flag, and the domain string in section 2
  is what makes that structurally true rather than merely conventional: this is a
  different domain reached through a different client configuration. A separate
  `RESERVED_ENABLED` flag, defaulting to false, keeps the existing deployment
  safety line intact.

### 17.1 Intercity has one fare authority, so it gets no two-source check

**Conceded, and corrected.** An earlier draft of this document said the app
should treat its `IntercityFareTable` as a reconciliation reference feeding
`src/ondc/reconcile.ts`, on the reasoning that the app already has machinery for
comparing its own answer against the network's. That reasoning does not survive
contact with decision 1.

`reconcileFare` compares two **independently derived** figures: Tatak's own
distance-based fare formula against a live quote from the operator. The
comparison carries information exactly because the two sides computed the number
separately, so a gap is real evidence that one of the two fare models is wrong.
The module's own header says so: *"A ₹1 gap is a disagreement about the fare
model, not noise."* Refusing to show any fare is the right response to a genuine
dispute between two authorities, because there is no principled way to pick a
winner.

**Intercity has no second authority.** This provider's fare table is the only
derivation of an intercity fare that exists, by decision 1 and by section 4's
design. Nothing on the app side derives one independently, because there is no
formula to derive it from - the fare is a lookup, not a curve, and the lookup
lives here. So a cached app-side copy that disagrees with a live quote is not two
parties calculating differently. **It is one fact with one owner, and the cache
is behind.**

The consequence lands in the copy, on screen. `FARE_DISAGREEMENT_LABEL` reads
`Why there is no fare here`, and it belongs to a refusal: the commit control is
removed and both figures are shown, because the app genuinely cannot say which is
right. Showing that for intercity would tell a rider there is a dispute between
two authorities when no such dispute is possible. The honest sentence is nearer
*this fare may have changed*, and the honest action is to refetch rather than to
refuse.

**What the app should reuse is already in the same file, and it is a different
member of the same type.** `FareVerdict` has a third case beside `agreed` and
`disagreed`:

> `unchecked` - Tatak has no figure of its own for this leg, so there is nothing
> to disagree with. This is not the same as agreement and must not render as one:
> the BPP's number is the only number, and it must be presented as the operator's
> claim, not as a fact.

That is precisely the intercity situation, written down before intercity existed.
Every intercity fare is `unchecked`, always, by construction rather than by
accident of a missing local figure. It renders as the operator's claim, attributed,
and it is never dressed as a fact two parties agreed on.

**What a cached app-side fare is for, then.** Planning-time ranking, before any
`select` round trip - sorting a results list, or showing an approximate band on a
dated-departures screen. It is not an authority and it must not gate a commit.
The commit surface always shows the live quote from `on_select`, and a difference
between the two is a refetch and a changed number, not a refusal.

**The one comparison that does survive, and the trap inside it.**
`reconcile.ts`'s other axis, `catalogue-and-quote`, compares the operator against
itself: the price published in `on_search` against the quote `on_select` returned
for the same item. That is not two authorities either, but it is a real
internal-consistency check on one, and a mismatch means this provider is broken
rather than that two parties differ.

**It must not be applied naively to intercity, because here the two figures
legitimately differ.** The catalogue price is for one boarding pair; the quote is
for the pair the rider chose, and by decision 5 a different pair is a different
fare. Running the existing check unchanged would fire on every rider who picks up
at Madiwala instead of Majestic, and a false alarm on a fare screen trains riders
to ignore a real one.

So the catalogue price names its own basis, and the check becomes conditional on
it. `SERVICE_INFO` carries the pair the headline price was computed for:

```json
{ "descriptor": { "code": "PRICED_FOR" }, "list": [
  { "descriptor": { "code": "FROM_BOARDING_POINT_ID" }, "value": "BP-BLR-MAJESTIC" },
  { "descriptor": { "code": "TO_BOARDING_POINT_ID" },   "value": "BP-HMP-HAMPI" } ] }
```

A quote for that exact pair must equal the catalogue price to the paise, and a
gap is a bug in this provider worth surfacing. A quote for any other pair is
expected to differ and is not compared. Without `PRICED_FOR` the app has no way
to tell the two cases apart, which is the gap this objection exposed rather than
a refinement it requested.

### What the buyer app keeps

Everything in Tatak's spec sections 2, 3, 4, 7 and 9 stands: the `reserved`
certainty tier and `certaintyTier()`, `travelDate` on `/api/plan` and
`tryParseTravelDate`, the `boardRoute` advance-window pre-filter,
`reservationDisplayStatus`, the ticket's `travelAtMs`, and the whole
connection-buffer design. None of them are inventory questions.

Its `reservations` and `reservation_seats` tables also stay, with their meaning
changed: they become the **buyer-side booking record**, a replica keyed by this
provider's booking reference, holding what the app needs to render My Bookings
offline. The invariant its section 6 protects - two devices cannot both believe
they hold the same seat - is preserved rather than abandoned; arbitration simply
moves one hop further out, to the party that owns the inventory. The app's
`HELD` row is now a display of a hold rather than the hold itself, and its
`expires_at` is copied from `EXPIRES_AT` rather than computed.

### What moves here

The seat-inventory simulation (`hashSeed(serviceId, travelDate)`), the hold
arbitration, the fare lookup as a pricing authority, the cancellation slab
evaluation, and the PNR generator. Four of the five were already sketched on the
app side; they are the same designs, relocated to the party that can actually
enforce them.

---

## 18. The contract with `transit-fleet-sim`

**This provider never invents a plate, and never names a vehicle.**

The confirmed order carries `VEHICLE_LOOKUP` with `SERVICE_ID` and `TRAVEL_DATE`
and nothing else. Which physical coach runs `2259BNGHMP` on 25 September is a
question about a fleet, and the fleet simulator is the party that answers it.
This is the same division `transit-fleet-sim`'s own specification already draws
for city buses: *"the ticketing service stores what was true when the ticket was
issued, and calls this service for what is true now."*

**A reserved ticket at issue therefore carries no plate at all, and that is
correct rather than a gap.** A real KSRTC e-ticket does not name a registration
number either; the coach is identified at the stand, by a route board and a
service number. A ticket that named a plate this provider chose would be
asserting a vehicle assignment nobody made.

### The endpoint the join needs, which does not exist yet

`transit-fleet-sim` resolves a vehicle by BIN or by plate today
(`GET /fleet/resolve`), and serves one vehicle's position by BIN
(`GET /fleet/vehicle/{bin}/position`). **There is no lookup keyed by service and
date.** Saying so plainly is better than implying the join already works.

What it would have to be, in that repository's own vocabulary:

```
GET /fleet/duty?service=2259BNGHMP&date=2026-09-25
```

returning either a vehicle - BIN, class, current plate with its `since`, and the
same `duty` object shape `/fleet/resolve` already returns - or a null result with
a reason. Its `duty.status` vocabulary is already the right one:
`confirmed | inferred | unknown | out_of_service`, with `duty.source` of
`roster | position_match | none`. A rostered intercity coach is `confirmed` from
`roster`; a service the simulator has no roster for is `unknown`, and the app
shows the service number alone.

That endpoint is work in `transit-fleet-sim`, not here, and this document does
not schedule it. What this document commits to is the join key: **`serviceId` is
stable across dates and releases, and it is the same string in this provider's
fixtures, in Tatak's dataset and in whatever roster the simulator builds.** A
service id that differed between the three would make the join impossible, and
it is the one field all three projects have to agree on before any of them
builds.

**The simulator must not be asked for a boarding bay.** Nothing sources one, and
section 9.1 declines the field rather than moving the gap from the catalogue to
the roster and calling it solved.

**Nor for the corporation that section 10.3 attributes a sale to.** The
simulator's fleet is generated, so a corporation attached to a generated
vehicle is a fact about the simulation rather than about Karnataka. It may
perfectly well report which corporation it modelled the coach as belonging to;
that value renders, if at all, beside the plate and under the same "simulated"
framing, never in `bookings.settlement_corporation` and never on any rider
surface at all (section 10.6).

**What the rider sees when the simulator has nothing** is section 9.2's table
without its last two rows: the service number, the destination, the class, the
brand, and the reporting time. That is what a real KSRTC e-ticket carries, so the
degraded case is not degraded relative to the world - only relative to what this
stack could have shown.

The simulator's own honesty rule carries over unchanged: a dark or untracked
vehicle reports no position and no occupancy, and a stale fix is evaluated
against its own instant rather than the serve time. A reserved coach with no
tracking is a coach with no tracking, and neither this provider nor the app may
fill that in.

---

## 19. What is real and what is staged

**Real:** the Beckn-shaped lifecycle and its asynchronous callback model, the
ACK/NACK envelope, the registry lookup, the gateway fan-out, the Ed25519 signing
pipeline, schema validation on both directions, the seat-map geometry for each
class, the hold arbitration and its concurrency guarantee, the cancellation slabs
and their arithmetic, the reservation window, the boarding-point-pair fare key,
the manifest's field set, and the refusal to collect anything identifying.

**Staged, or absent:**

| Aspect | What is not real | Consequence |
|---|---|---|
| The domain | `TRANSIT.LOCALHOST:INTERCITY` is a local string under a reserved, unresolvable name. `ONDC:TRV12` intercity is still draft [S] and no state RTC is a live ONDC participant for intercity booking. | This category is modelled on a draft, not conformant to it, and there is no upstream example set to test against (§2, §20). |
| Seat availability | Seeded from service identity and travel date. Nobody's real inventory. | Marked `SIMULATED_INVENTORY` on every item and every seat map. A rider must never read it as KSRTC availability. |
| The booking curve | Occupancy does not change as the departure approaches, by deliberate choice (§6.1). | Less lifelike than real inventory, and visibly a simulation, which is the trade taken. Reproducible screenshots and golden files are the compensation. |
| A seeded seat's passenger gender | Fabricated, purely so the adjacency rule has something to evaluate against (§6.3). | Never leaves the computation as an identity claim; only the resulting lock is published. |
| Timetables | Departure and arrival times are secondary-sourced. The Bengaluru-Hampi 22:59 departure comes from a route-aggregator page reached through a search summary; the primary fetch failed with a DNS error and was not re-verified [S]. | Fixture times carry their label. No output may present one as a published timetable. |
| Fares | Aggregator floor prices and single-route anecdotes, per cell [S, weak]. No corporation-published fare table was found for any corridor or class. | `FARE-NOT-PUBLISHED` rather than interpolation, and no GST arithmetic on an invented number (§4). |
| Service provenance | Every shipped corridor is `inferred`. None reaches `confirmed`. | The app renders the mark on all of them, which is the accurate reading. |
| The operating corporation | Unconfirmed for the Bengaluru-Hampi service, which is the corridor where the settlement stakes are highest [I]. | Recorded as `null` and reconciled later rather than guessed (§10.4), and never rendered to a rider in any case, known or not (§10.2, §10.6). |
| Concessions | Senior 25% on Rajahamsa and lower [V], but where Pallakki sits in that ordering is unestablished. The child 50-75% range is not a rate. | Published only where sourced; refused elsewhere with the existing code (§11). |
| The booking | A specimen. No coach carries the manifest, no conductor checks it, no seat is held anywhere but here. | `SPECIMEN - NOT VALID FOR TRAVEL - not issued by KSRTC, NWKRTC or KKRTC` on every order. |
| Payment | No gateway, no collection, no settlement. `status: PAID` is written because the field is required. | No money moves, and no refund is paid. A refund figure is arithmetic, not a payment. |
| The vehicle | Not named here at all. | The plate join is `transit-fleet-sim`'s, through an endpoint that does not exist yet (§18). A corporation the simulator assigns is a property of the simulation and must never reach `settlement_corporation` or any rider surface (§10.6, §18). |
| The boarding bay | No source exists for bay-level data at any Karnataka stand, and a real bay is assigned near departure rather than at booking. | Declined outright rather than carried as a permanently-null field (§9.1). Sheet 09's headline becomes the reporting time and the service number, with *bay announced at the station* where the number was. |
| The operator's systems | **No call is made to ksrtc.in, to AWATAR, or to any operator booking system, at request time or at any other time, from this service.** | The dataset is fixtures and, optionally, a source this provider reads over HTTP. Whether Tatak harvests offline to build that dataset is Tatak's ruling and its consequence, not this provider's runtime behaviour. |

**The one-sentence version:** *the protocol shape, the inventory arbitration and
the refund arithmetic are real; the domain is local, the seats sold are
simulated, the timetable is secondary-sourced, and no seat on any coach in
Karnataka is affected by anything that happens here.*

---

## 20. The test plan

Layered as `SPEC.md` section 11.3 layers its own, with one honest subtraction.

**A. Unit tests on the mapping and the model.** Pure functions, no network, no
containers. Highest value per minute, because this is where a design is most
easily misread.

- Seat map geometry: a 2+2 map's `adjacentSeatIds` never cross the aisle; a 2+1
  map's `pairedSeatId` is symmetric; a single berth has neither; seat counts
  match the class's documented capacity.
- Occupancy determinism: the same `(serviceId, travelDate)` produces a
  byte-identical sold set across a thousand calls and across two process starts;
  a different date produces a different one; **the sold set does not change when
  the clock does**, which is the invariant section 6.1 chose and the one most
  likely to be broken by a well-meaning later edit.
- Occupancy shape: at a 50% fill, window seats are over-represented in the sold
  set and lower berths over upper, so a change that flattened the desirability
  weighting into a plain hash fails rather than passing silently.
- Gender lock: adjacency within one booking is allowed; across bookings it locks;
  a `null` gender cannot take a locked seat; **the relock case in section 7 is
  pinned end to end** - book a mixed pair, cancel one seat, assert the freed seat
  is `FEMALE_ONLY` to a third party.
- Fare lookup: a missing cell refuses rather than interpolating; a fare table's
  per-cell sourcing survives into the published tag.
- Refund arithmetic: each slab boundary at one second either side; the
  reservation fee never refunded; the toll always refunded; round-half-up on a
  figure that does not divide (the ₹4,505 at 25% case from section 12).
- Concession: `RAJAHAMSA` prices a senior discount; `PALLAKKI` refuses with
  `CONCESSION-RATE-NOT-PUBLISHED`; a Shakti claim refuses with
  `CONCESSION-NOT-APPLICABLE`.
- Manifest: an unexpected code refuses and its *value* appears nowhere in the
  error message or the log line. This test asserts on the log, not only the
  error, because the log is where a document number would actually land.

**B. Fixture integrity.** Boot-time validation, asserted as a test rather than
trusted: every reference resolves; every `confirmed` provenance names at least
two sources; every fare cell carries a sourcing label; every service's
`operatingCorporation` is either null or accompanied by a `confirmed` basis.

**C. Concurrency.** The layer the existing test suite has no equivalent of,
because nothing before this could be contended.

- Two `select` calls racing for the same seat, driven concurrently against one
  app instance: exactly one succeeds, the other gets `SEAT-UNAVAILABLE`, and the
  seat map returned to the loser already reflects the winner's hold.
- A hold expiring between `select` and `confirm`: `HOLD-EXPIRED`, naming the
  published instant, **even though the seat is still free** - the section 8.6
  rule, asserted as behaviour rather than described in a comment.
- A re-`select` of the same seats does not extend the expiry.
- A re-`select` of different seats releases the first hold, and a third
  transaction can immediately take the released seats.
- Two `confirm` calls on one transaction produce one booking with one reference.
- Two `CONFIRM_CANCEL` calls return the identical stored refund figure.

The clock is injected throughout, as `ServiceOptions.now` already is in
`TransitOrderService`, so none of these tests waits ten real minutes.

**D. Protocol and boundary.** Every generated `on_*` validates against the local
schema; a malformed request NACKs with the documented envelope; a domain error
arrives as an `error` on the callback with no `message.order`; `transaction_id`
is byte-identical across all hops of one booking; the reserved domain's items
never appear in a `ONDC:TRV11` search and vice versa.

Plus the three grep guards of section 2, which are cheap and catch a class of
mistake that code review reliably misses: no `ONDC` or `TRV11` under
`src/reserved/`, no `TRANSIT.LOCALHOST`, `RESERVED` or `INTERCITY` under
`src/trv11/`, and no `$ref` from the reserved schema tree into the TRV11 one.

And the fare-basis consistency check from section 17.1: a quote for the pair
named in `PRICED_FOR` equals the catalogue price to the paise, and a quote for
any other pair is not compared. Both halves are asserted, because a test that
only checked the equal case would pass an implementation that compared every
pair and fired constantly in production.

And the two settlement-boundary guards of section 10.6: `settlement_corporation`,
`settlement_basis` and the retired `CORPORATION`/`CORPORATION_BASIS` fields
appear nowhere in any generated `on_*` payload, checked against every golden
fixture below rather than against one hand-picked example.

**What is missing, and it is the important one.** `SPEC.md` section 11.3's layer
B - contract tests asserting that generated payloads share a key structure with
ONDC's own published example files - **cannot exist for this category**, because
there are no published examples for a domain that has not been released. That
test is described in the existing specification as "the test that stops the build
drifting into something that merely looks like Beckn," and this category ships
without it. The substitute is weaker and should be named as weaker: golden-file
tests against payloads checked into `tests/fixtures/reserved-golden/`, which
catch drift from *this document* but cannot catch drift from a specification that
does not exist yet. Section 2's migration list treats writing the real layer B as
the first thing to do if TRV12 intercity is released.

---

## 21. Effort

Engineer-days, one person, at this repository's demonstrated pace.

| Unit | Work | Days |
|---|---|---|
| **1. Domain plumbing** | The `TRANSIT.LOCALHOST:INTERCITY` domain constant and version, a `schemas/transit_local_intercity/0.1.0/` tree for the seven actions, a third operator identity (`ksrtc.bpp.transit.localhost`), its registry subscription, its gateway routing entry, and the ONIX core-schema compatibility work the second domain needs | **1.5** |
| **2. The model and the fixtures** | `ReservedService`, `SeatMap`, `FareTable`, `BoardingPoint`, `ReservedServiceSource`, `FixtureReservedSource`, five seat maps, three corridors, three fare tables, boot-time integrity validation | **2.0** |
| **3. Occupancy** | The seeded fill fraction, the desirability weighting, the per-seat perturbation, the seeded gender, and the determinism tests that pin all of it | **1.0** |
| **4. Storage and migrations** | libSQL wiring, the four tables, the live-lock unique index, the lazy sweep, the retention sweep, the forward-only migration runner | **1.5** |
| **5. The hold lifecycle** | Acquire, replace, expire, sweep, and the concurrency test layer. **The hardest unit, and the one to build first after storage** | **2.0** |
| **6. Catalogue and select** | `on_search` shaping, the two `select` shapes, the seat-map tag, the fare lookup, boarding-point resolution and reporting times | **2.0** |
| **7. Manifest, init and confirm** | Manifest parsing and its refusals, the gender-lock re-check at `init`, hold-to-booking transition, booking reference, idempotency | **1.5** |
| **8. Gender locking** | The adjacency rule, the cross-booking exemption, the relock on partial cancellation | **1.0** |
| **9. Cancellation** | Slab evaluation, the two-step quote and commitment, `REFUND-SLAB-MOVED`, partial cancellation, refund persistence | **1.5** |
| **10. `HttpReservedSource`** | The adapter, `docs/reserved-source-http.md`, `schemas/reserved-source-response.json`, the fallback path | **0.75** |
| **11. Repository furniture** | This document's cross-links, README sections, `.env.example`, `/terms` extension for the reserved slabs, and the module-boundary grep guards of section 2 | **0.75** |
| **12. Settlement attribution** | The two `bookings` columns of section 10.3, the confirm-time copy from `operatingCorporation`/`operatingCorporationBasis`, removing `CORPORATION`/`CORPORATION_BASIS` from the wire, and the two wire-boundary tests of section 10.6. No new endpoint and no new storage beyond two columns, which is why this rides on top of unit 7 rather than opening its own phase | **1.0** |
| | **Total** | **16.5** |

The four research documents are already vendored into `docs/research/`, so that
line has left the estimate rather than being costed.

**The smallest shippable increment, named:** units 1, 2, 3, 4, 5 and 6, with one
corridor (Bengaluru-Hampi, `PALLAKKI`), fixtures only, and `curl` as the BAP.
That is **10 days** and it already demonstrates a dated catalogue, a real seat
map, deterministic occupancy, a server-authoritative hold with a real
concurrency guarantee, and a boarding-point-keyed fare. It has no manifest, no
booking and no cancellation, so it cannot show sheet 07, 08, 10 or 11.

**What is not in this estimate.** The `GET /fleet/duty` endpoint in
`transit-fleet-sim` (section 18). The buyer app's wiring, which is Tatak's spec
sub-project G. The three-operator dataset harvest, which is that spec's
sub-project B at 20 to 30 days and is what would move a corridor from `inferred`
to `confirmed`. This provider runs on fixtures without any of it.

**Where this could go wrong**, ranked:

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| The second domain fights the ONIX stack - gateway routing, registry subscription, or the mounted core schema rejecting an unknown domain string | Medium | High | Spike unit 1 on day one before anything else is built. If the pinned ONIX build cannot carry a second domain, the fallback is to publish the reserved category under `ONDC:TRV11` with a `RESERVED` category code and a loud disclosure, which is worse and must be argued rather than defaulted to. |
| The unique index does not do what section 8.5 claims under libSQL's actual isolation | Medium | High | The concurrency test layer exists to find this, and it is written before the hold code rather than after. |
| Seeded occupancy drifts to a per-request hash under a later refactor | Medium | Medium | The determinism test in section 20 layer A is the guard, and it should assert across two process starts rather than within one. |
| Manifest handling leaks a value into a log line | Low | High | The layer A test asserts on the log rather than only the error. |
| Fixture times or fares get quoted in a demo as sourced | Medium | Medium | Per-cell and per-service sourcing labels, and the integrity test. A demo script that shows a fare without its provenance mark is the failure mode, not the code. |

---

## 22. Open questions

These are genuine, not rhetorical. Each names what would settle it.

1. **Should `operatingCorporation` be nullable on the app-side ticket?** Moot as
   originally framed. Section 10.1 argued yes, narrowing Tatak's spec's non-null
   `'KSRTC' | 'NWKRTC' | 'KKRTC' | 'BMTC'` on the reasoning that publishing an
   inferred corporation would defeat the disclosure's whole purpose. Section
   10.2's ruling removes the field from the app-side ticket altogether rather
   than choosing its type, so the nullability question this item originally
   posed has no surface left to apply to. The field should simply come out of
   the app-side ticket type, which is a smaller change than the one originally
   asked for. **Settled by the owner's ruling recorded in section 10.2**, not by
   further research.

2. **Which corporation actually operates the Bengaluru-Hampi nightly Pallakki?**
   No longer a disclosure question - section 10.2 retired that - but a real
   settlement one: this is the corridor where `settlement_corporation` staying
   `null` (section 10.4) costs the most, because it is the best-attested
   corridor this provider ships (section 3.4) and the unresolved amount
   compounds nightly. The research could not establish it from any primary
   source (section 10.1). Settled by a primary source from KSRTC, KKRTC or a
   route permit, or by whatever depot-level reconciliation section 10.4
   eventually runs.

3. **Where does Pallakki sit relative to Rajahamsa for the senior concession?**
   "Rajahamsa and lower classes" [V] is precise about its upper bound and silent
   about a non-AC sleeper. Until it is settled, no senior rate is published for
   Pallakki and a claim is refused. Settled by KSRTC's own concession page or by
   a counter enquiry.

4. **What is AWATAR's real seat-hold duration?** Ten minutes is chosen, not
   sourced (section 8.1). No KSRTC-specific documentation was found [I]. Settled
   by observing a real booking session, which nobody has been asked to do.

5. **Should the child concession be modelled at all?** "50 to 75% depending on
   service class" [V] is a range without a per-class breakdown, and children 6
   and under travelling free interacts with seat allocation in a way this
   document does not answer - does a free child occupy a berth, or share one?
   Settled by the per-class breakdown, or by a decision to leave children out
   entirely and say so on the buying surface.

6. **Are `SOFT_CANCEL` and `CONFIRM_CANCEL` the right names?** They are this
   document's own, unverified against any published enumeration (section 12), in
   exactly the condition `authorization.status: "ISSUED"` is already recorded in
   for the pass path. Settled by TRV12's own enumeration if it is released, and
   until then by a decision to keep them.

7. **Should the seat map fill as the departure approaches?** Section 6.1 chose
   no, trading realism for a stated invariant and for reproducibility. The
   opposite choice is defensible and would make a demo more convincing, which is
   a reason to be suspicious of it. Settled by the owner deciding which property
   matters more.

8. **Does a rider need a way to see a booking without the buyer app that made
   it?** `status` by `ref_id` exists, but it is a Beckn action addressed by a
   BAP, and a rider holding only a printed reference has no BAP. A read-only
   lookup surface is a real product question and it is not answered here.

9. **`serviceId` has to be one string across three projects** (section 18), and
   nobody has agreed its format. `2259BNGHMP` is KSRTC's own route code shape
   [S] and is the obvious candidate, which is not the same as it being agreed.
   Settled by the three repositories writing it down once, before any of them
   builds a join against it.

10. **Who runs the reconciliation query in section 10.4, and how often?** This
    specification names the shape of the backlog - a query grouped by
    `(service_id, travel_date)` over unattributed bookings - and deliberately
    does not build the process that consumes it, for the same reason it builds
    no payment gateway (section 19). A real deployment needs an owner for that
    process and a cadence, and neither is a research question. Settled by a
    decision, once there is real money for the process to reconcile.

11. **Does a corporation ever get told which of this platform's sales attributed
    to it?** Section 10.6 is unambiguous that a rider sees nothing; it says
    nothing about whether a corporation itself would eventually want a feed of
    its own `settlement_corporation` bookings to check against its own roster.
    That is a real integration surface this specification has not designed,
    because no corporation has asked for one and inventing an API nobody
    requested would be speculative in the direction this document otherwise
    avoids.
