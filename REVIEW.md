# Review of Phase 1

Reviewed at `aa9eae5`. Verified by running the repo, not by reading it:
`npm ci`, `npm run build`, `npm test` (15 passing), plus live TRV11 searches
against the provider with a stub callback sink.

## Phase 1 passes

The evidence in [`phase-1/RESULTS.md`](phase-1/RESULTS.md) holds up. Two
distinct subscriber IDs, a real gateway fan-out, the registry lookup recorded,
and a controlled TTL-drop test whose cost is written down rather than hidden.
It stops at the right point: `select`, `init`, `confirm` and `status` are
correctly left to Phase 2.

Seven items follow. Items 1 and 2 are the ones that matter. Take them in order
and commit each separately.

## 1. Signatures are off, and nothing says so

All six ONIX configs set `auth: false`:

- `stage-0/onix-sync/config/bap-client.yml:33`
- `stage-0/onix-sync/config/bap-network.yml:33`
- `stage-0/onix-sync/config/bmtc-bpp-client.yml:30`
- `stage-0/onix-sync/config/bmtc-bpp-network.yml:30`
- `stage-0/onix-sync/config/bmrcl-bpp-client.yml:30`
- `stage-0/onix-sync/config/bmrcl-bpp-network.yml:30`

SPEC acceptance criterion 14 requires every request between participants to
carry an `Authorization` header, and requires that tampering with a body in
flight causes the receiver to reject it. Nothing is signed today, and neither
RESULTS.md mentions it.

First try turning it on. Set `auth: true`, confirm the registry holds each
subscriber's signing public key under its `uniqueKey`, re-run the Phase 1
search, and capture an `Authorization` header from the wire as evidence. Then
prove rejection: replay a captured request with one byte of the body changed
and record the receiver's refusal.

If it cannot be made to work locally, that is an acceptable Phase 1 outcome,
but it must be stated rather than left silent. Add a section to
`phase-1/RESULTS.md` naming criterion 14 as unmet, saying auth is false on all
six services, and saying exactly what blocked it. Same note in `README.md`
beside the topology. Nothing in this repo may read as though messages are
signed while they are not.

## 2. The fare does not depend on distance

`farePaise` is a route-level constant in the fixture, and `sliceOffer`
(`src/sources/fixture.ts:57-66`) slices the stop list without touching the
price. Measured against the running provider:

| Search | Stops | Quoted |
| --- | ---: | ---: |
| METRO Indiranagar to Majestic | 8 | ₹30 |
| METRO Indiranagar to Halasuru | 1 | ₹30 |
| BUS Indiranagar 6th Main to Domlur | 1 | ₹27 |

BMRCL's real structure is a ₹10 floor rising with distance. The consuming app
models it that way, so the same one-stop leg would show ₹10 from the planner
and ₹30 from this BPP on one screen.

Do not paper over this by inventing a fare formula in the fixture source. That
source's job is to return what the fixture says. Two changes instead:

1. Make the fixture honest about what it is. Rename the field or add a sibling
   so a reader cannot mistake a whole-route flat fare for a computed one, and
   put a line in `README.md` saying the fixture fare is a placeholder for a
   single whole-route journey and is not distance-based.
2. Note in `phase-1/RESULTS.md` that distance-correct fares arrive with the
   `http` journey source in Phase 2, which reads fares from the planner, and
   that the fixture source is not a fare model.

Nobody should demo a sliced fixture offer as a priced journey until the `http`
source exists.

## 3. Reverse travel returns an empty catalogue

`sliceOffer` requires `toIndex > fromIndex`, so Majestic to Indiranagar returns
zero providers from both operators. Refusing to sell a route backwards is
right. Having only one direction in the fixtures is not.

Add the return direction as a separate offer in each fixture, with its own
`offerId`, its own `routeId` and its `route` array reversed. Add a test
asserting that a search in each direction returns exactly one offer, and that
the returned stop order matches the direction asked for.

## 4. A category mismatch is completely silent

`src/app.ts:135-137` ACKs and returns before the `logEvent` call at line 141,
so a metro BPP asked for `vehicle.category: BUS` produces no callback and no
log line at all. Meanwhile the no-offers path does send an `on_search` with
`providers: []`. Two different silences, and the one that means "not my mode"
leaves no trace in the evidence file.

Decide which of the two is correct and make both paths agree. The more useful
behaviour is to keep ACKing and stay silent on the callback, since that is what
a real BPP outside its mode does, but emit a log line for it either way, with
outcome `SKIPPED` and a reason naming the requested and expected category. Log
before returning. Add a test asserting the log line exists and no callback is
dispatched.

## 5. TRV11 schema provenance is not stated

`schemas/ondc_trv11/2.0.1/` is 210 and 103 hand-written lines carrying
`$id: https://ondc.local/...`, not ONDC's published TRV11 2.0.1 schemas. So
"validated against TRV11 2.0.1" currently means "validated against our own
subset of it", which is a weaker claim than it reads as.

Add a `README.md` section stating the schemas are locally authored subsets,
listing which constraints they do and do not enforce, and linking the upstream
ONDC mobility-specification release tag they were derived from. If the
published schemas can be vendored instead, prefer that and say which revision.

## 6. Fulfillment IDs collide

`src/trv11/catalog.ts:85` and `:141` both build the id as
``` `F${offer.offerId.replace(/\D/g, "") || "1"}` ```. Two offers with ids like
`I1A` and `I1B` both become `F1`, producing two fulfillments sharing one id
inside one provider and an ambiguous `fulfillment_ids` reference. Harmless with
one offer per operator. It breaks the moment item 3 adds a second.

Derive the id from the offer id without lossy stripping, compute it once and
use it in both places, and add a test asserting that a provider with two offers
emits two distinct fulfillment ids that each match exactly one item's
`fulfillment_ids`.

## 7. Placeholder instruction text

`src/trv11/catalog.ts:60` emits `instructions.name` as `Stop 3`. That field is
what a rider is shown at an intermediate stop. Either put something real in it,
the stop name or the change hint, or drop the `instructions` object where there
is nothing to say.

## Not an issue, recorded so it is not lost

Both fixtures declare provider id `P1`, which is legal within each BPP. The
consuming BAP will key providers by `(bpp_id, provider.id)`. No change needed
in this repo.
