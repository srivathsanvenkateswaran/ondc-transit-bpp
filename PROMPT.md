# Codex prompt: Phase 2

Copy everything below the line into Codex. It is written to be pasted whole.

---

You are continuing work on `ondc-transit-bpp`, a mock ONDC seller for
Bengaluru public transport. Phase 1 is already done and passing. This is
Phase 2.

## Read first

- `SPEC.md` sections 3.5, 6.1, 6.3, 6.4, 7.1, 7.2, 8.1, 8.3, 11.2 and 11.4.
  Section 6.3 has the full call sequence as a diagram. Section 3.5 is the data
  model and it is the one people get wrong.
- `REVIEW.md`. Seven open items from a review of Phase 1.
- `phase-1/RESULTS.md`, so you know what already works and what was measured.

## What already works, do not rebuild it

`search` and `on_search` are live. One `POST /search` to the BAP returns HTTP
200 carrying two `on_search` responses, from two genuinely separate BPP
subscriber identities, fanned out by a real gateway after a real registry
lookup. The provider backend serves both operators on two URL prefixes. The
fixture journey source, the TRV11 schema validation and the ACK/NACK layer all
exist.

## Task A first, because it is short

Work `REVIEW.md`. Start with item 1, which is about fifteen minutes of writing.

Signing is off: `auth: false` on all six ONIX configs. That leaves SPEC
acceptance criterion 14 unmet, and nothing in the repository admits it. Try
turning it on. If the registry has the subscribers' signing public keys and it
works, capture an `Authorization` header from the wire as evidence and prove
that a tampered body is rejected. **If it fights you, stop and write it down
instead** - a section in `phase-1/RESULTS.md` naming criterion 14 as unmet,
saying auth is false on all six services and what blocked it, plus the same
note in `README.md`. Do not spend an evening on it. What is not acceptable is
leaving it silent, because then someone demonstrating this will say "signed
ONDC messages" and it will not be true.

Items 4, 6 and 7 are small. Item 2 is mostly a documentation fix; the real
answer to it arrives with the `http` journey source below. Item 3 is a ten
minute fixture addition. Item 5 is a README section.

## Task B: the four remaining actions

`select`, `init`, `confirm`, `status`, and their four callbacks. The gateway
appears **once**, during `search`. Everything after `on_search` is addressed
directly using the `bpp_id` and `bpp_uri` the BPP stamped into its own
`on_search` context. Do not route later actions through the gateway.

### The data model, which is the part to get right

`Item` is the **fare product**, not the vehicle and not the route. Section 3.5.
A Single Journey Ticket is an item. The bus is a fulfillment. Conflating them
is the mistake that makes the rest incoherent.

**A quote is not part of the `on_search` catalogue.** It first appears on
`on_select`. `quote.price.value` must equal the sum of `breakup[].price.value`,
with a `BASE_FARE` line per item. Assert that as a test, not as an intention.

**Integer paise in, rupee string out, no rounding drift.** `2700` paise renders
as `"27"`, never `"27.000000000000004"`. Acceptance criterion 16.

### The ticket

`on_confirm` carries one `TICKET`-type fulfillment per ticket, each with
`stops[0].authorization` holding `type: QR`, a base64 `token`, a parseable
`valid_to` and `status: UNCLAIMED`, plus a `TICKET_INFO` tag whose `NUMBER` is
the human-readable ticket number. Section 8.1.

Generate the QR yourself. Encode a plainly marked specimen string, something
like `SPECIMEN|TRV11|{order_id}|{ticket_number}|NOT VALID FOR TRAVEL`, so that
anyone who scans it reads a disclaimer. **Never encode anything that could be
mistaken for a real operator's ticket payload, and never reproduce a real BMRCL
or BMTC QR format.** This is a specimen and every artifact it produces has to
say so on its face.

### Order storage

`on_status` for a given `order.id` returns the same order. In-memory is fine
and is what the spec assumes; if you reach for a database, say why in the
commit.

### One journey is two orders

Section 6.4. A journey crossing a bus operator and a metro operator produces
two independent orders with two different BPPs. Nothing in the order store may
assume one order per journey.

## The fare problem, and the real fix

`REVIEW.md` item 2: the fixture fare is a whole-route constant that survives
slicing, so a one-stop metro hop quotes ₹30 exactly like an eight-stop one. The
consuming app models the real ₹10 floor, so the same leg shows two different
fares on one screen.

The real fix is the `http` journey source of SPEC section 7.2 and 7.3, which
reads fares from the planner instead of a fixture. Build it if you get there.
If you do not, make sure the fixture is plainly labelled as a placeholder so
nobody demos a sliced fixture offer as a priced journey.

## Do not build

The BAP client and the ticket mapping inside the consuming application, SPEC
stages 4 and 5. Those are being built in the Tatak repository in parallel,
against this SPEC's contract. Stay in this repository.

## Definition of done

SPEC section 11.2, criteria 1 to 17. Capture evidence the way Phase 1 did, in a
`phase-2/` directory with a `RESULTS.md` and raw unmodified response bodies.
Evidence beats claims, and Phase 1's evidence is why its result was trusted.

## Conventions

- Keep the `AI-Assisted-By: OpenAI Codex` trailer on your commits.
- Commit at every working state; do not accumulate a large uncommitted tree.
- No em-dashes in prose, comments or commit messages. Use a normal dash.
- Tests for anything with logic. Do not commit a red tree.
- If `SPEC.md` contradicts itself, the spec loses. Say so in the commit.
- Report what works, what you left out, and anything you found unbuildable.
