# The reserved intercity source contract

**Status:** implemented. `RESERVED_SOURCE=http` turns it on.
**Schema:** [`schemas/reserved-source-response.json`](../schemas/reserved-source-response.json), which is the normative version of everything below.

This provider sells reserved intercity coach seats. It does not own a dataset
of Karnataka, and it should not: services, boarding points, layouts and fares
are somebody's transit data, and everything downstream of them is protocol
shaping. This document is the seam between the two.

The default source is the fixture set in `fixtures/ksrtc/`, and it stays the
default. A stranger who clones this repository gets a working seller in under
five minutes with nothing else running, which is the property that makes the
repository worth publishing at all. The HTTP source is what a deployment with a
real dataset points at, and the fixtures stay underneath it as the fallback.

## The request

```
GET <RESERVED_SOURCE_URL>
accept: application/json
```

No body, no query string, no per-search round trip. The journey source next
door asks a question per search because it asks a planner about two points and
an instant, and the answer differs every time. This asks for a dataset:
services, layouts and fares change on the timescale of a data release rather
than of a request.

Five seconds is the timeout. The answer is held for sixty seconds and then
asked for again, which also means a `select` and the `confirm` that follows it
are priced against the same catalogue rather than against two fetches that
might straddle a release.

## The response

```json
{
  "catalogue": {
    "operator": { "id": "P1", "name": "...", "vehicleCategory": "COACH",
                  "serviceWindow": { "startHHMM": "00:00", "endHHMM": "23:59" } },
    "towns": [ { "code": "BLR", "name": "Bengaluru", "nameLocal": "..." } ],
    "boardingPoints": [ { "boardingPointId": "BP-BLR-MAJESTIC", "name": "...",
                          "townCode": "BLR", "reportingOffsetMinutes": 0,
                          "gps": { "lat": 12.9776, "lon": 77.5713 } } ],
    "services": [ { "serviceId": "2259BNGHMP", "...": "..." } ],
    "seatMaps": [ { "seatMapId": "PALLAKKI-2P1-30", "...": "..." } ],
    "fareTables": [ { "fareTableId": "FT-BNGHMP", "...": "..." } ]
  }
}
```

The schema is normative and carries a comment on every field whose meaning is
not obvious from its name. What follows is the handful of rules a dataset
author gets wrong if nobody says them out loud.

### Inventory is never in the source

A source supplies the static shape of what is sellable. Which seats are sold is
decided in this provider's own process: seeded occupancy for the simulation,
and rows in its own database for real holds and bookings. There is no field for
availability in this contract and there will not be one, because a source that
could answer it would be a source with live operator inventory, which is
exactly the thing nobody has.

### A fare is a cell, and an absent cell is an answer

The fare key is the boarding-point pair plus the class. A table is allowed to
be incomplete: a pair with no cell is refused at request time with
`FARE-NOT-PUBLISHED` rather than interpolated from a neighbour. Do not fill
gaps to make the table look complete. Every cell carries its own sourcing
label, `V`, `S` or `I`, because a table can be part-sourced and a per-table
label would launder an interpolated cell into a sourced one.

### Absence means unknown, everywhere

`operatingCorporation` is `null` when nobody knows which corporation dispatches
the coach, and a named corporation must carry a `confirmed` basis. Publishing
an inferred corporation would be worse than publishing none. `gps` is omitted
on a boarding point with no surveyed coordinate rather than filled from a town
centroid. `documentedCapacity` is `null` for a class whose seat count nobody
published.

### Adjacency is authored, not derived

`adjacentSeatIds` is physical adjacency and the aisle breaks it. On a 2+2
coach, `1B` and `1C` are numerically consecutive and are **not** adjacent,
because nobody sits shoulder to shoulder across an aisle. This field drives the
gender lock, and deriving it from seat numbering would lock the wrong seat on
every coach in the fleet. It must be symmetric, as must `pairedSeatId`.

### A dataset is checked twice before it is sold from

The response is validated against the schema, and then the catalogue is
validated against itself with the same boot-time check the fixtures pass: every
`seatMapId` and `fareTableId` resolves, every boarding point a fare cell names
is one some service of that class stops at, every seat map's adjacency and
pairing are symmetric, every `confirmed` provenance names at least two sources,
and every named operating corporation carries a confirmed basis. A dataset that
fails either check is not half read: this provider logs a `FALLBACK` event and
serves the fixtures.

## What happens when the dataset is down

```json
{ "action": "reserved_source", "operator": "ksrtc", "source": "http",
  "fallback_source": "fixture", "outcome": "FALLBACK",
  "reason": "connect ECONNREFUSED" }
```

The fixtures answer instead. This is byte for byte the behaviour the journey
source already implements, and for the same reason: a seller that answers
nothing because a dataset service is down is worse than a seller that answers
from the data it shipped with, as long as nobody can mistake which happened.
The log line is what makes the difference legible, so an operator who sees
`FALLBACK` in production should treat it as an outage rather than as a
fallback working correctly.

## Configuration

| Variable | Meaning |
|---|---|
| `RESERVED_SOURCE` | `fixture` (default) or `http` |
| `RESERVED_SOURCE_URL` | Required when the source is `http` |
| `RESERVED_SOURCE_RESPONSE_SCHEMA` | Path to the schema above; defaults to the copy in this repository |
