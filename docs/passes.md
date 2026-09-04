# Passes: the catalogue, the concessions, and the rotating credential

A pass is a fare for a **period** and a **scope of service** — not a fare for
a stop pair. It has no origin, no destination and no vehicle, which is why it
needed a different search axis, a different fulfillment type and a different
credential from the single-journey tickets this provider already sold.

`SPEC.md` section 2.2 named `PASS` as a real TRV11 item code and declined it
for phase one: *"TRV11 has `SJT`, `RJT` and `PASS` item codes. We issue `SJT`
only."* This is what closed that line. The single-journey `TICKET`-category
path is unchanged.

**This document is the fabrication disclosure for the whole feature.** Every
price and every concession rate below is derived or invented, and the sections
headed "how well sourced this is" say exactly how weakly. Nothing here is a
BMTC or BMRCL tariff.

---

## 1. The nine catalogue items

Three validity windows across three scopes. BMTC publishes six, BMRCL three.

| id | operator | window | scope | duration | price |
|---|---|---|---|---|---|
| `PASS-DAY-ORDINARY_BUS` | BMTC | day | Ordinary only | `P1D` | ₹75.00 |
| `PASS-DAY-AC_BUS` | BMTC | day | AC + Ordinary | `P1D` | ₹150.00 |
| `PASS-WEEKLY-ORDINARY_BUS` | BMTC | weekly | Ordinary only | `P7D` | ₹375.00 |
| `PASS-WEEKLY-AC_BUS` | BMTC | weekly | AC + Ordinary | `P7D` | ₹750.00 |
| `PASS-MONTHLY-ORDINARY_BUS` | BMTC | monthly | Ordinary only | `P1M` | ₹1350.00 |
| `PASS-MONTHLY-AC_BUS` | BMTC | monthly | AC + Ordinary | `P1M` | ₹2700.00 |
| `PASS-DAY-METRO` | BMRCL | day | Metro | `P1D` | ₹225.00 |
| `PASS-WEEKLY-METRO` | BMRCL | weekly | Metro | `P7D` | ₹1125.00 |
| `PASS-MONTHLY-METRO` | BMRCL | monthly | Metro | `P1M` | ₹4050.00 |

**There is no combined bus-and-metro item, and that is deliberate.** Neither
operator sells the other's network — the same fact that already makes a
bus-plus-metro *journey* two orders rather than one (`SPEC.md` section 6.4). A
buyer app that wants a combined pass buys the AC Bus item from BMTC and the
Metro item from BMRCL in the same window and binds them under one checkout id
on its own side. A combined pass is two pass orders wearing one wallet card.

**AC Bus covers Ordinary too.** A higher class is honoured on a lower service,
never the reverse. Metro covers metro only, in both directions.

`src/trv11/pass.ts` derives all nine from the constants below rather than
holding a price table, so the arithmetic and the disclosure cannot drift
apart. `tests/trv11/pass.test.ts` asserts the derived values against the
table above.

### How the prices were derived, and how well sourced that is

**No operator quotes a pass price to this software.** `fixtures/` carries no
fare products, and a stale real tariff stated confidently would cost a rider
real money — worse than an invented one stated openly. So every price is
derived from named multiples:

| constant | value | standing |
|---|---|---|
| `PASS_CEILING_MULTIPLE` | 2.5 | Day price = 2.5 × the scope's ceiling single fare, chosen so a day pass pays for itself on the third full-length ride. Inherited from Tatak's `DAY_PASSES`, which already shipped on this derivation. |
| `WEEKLY_DAY_MULTIPLE` | 5 | Five weekday-equivalents; the two weekend days are the saving a weekly pass is for. Reasoned, not sourced. |
| `MONTHLY_DAY_MULTIPLE` | 18 | **Open constant.** Proposed, not derived from anything BMTC has stated, and materially less defensible than the day multiple. Needs the owner's sign-off. |

Ceiling single fares the day price multiplies (`CEILING_SINGLE_FARE_PAISE`):
₹30 Ordinary, ₹60 AC, ₹90 Metro. These are Tatak's own existing fare
ceilings, and they are synthetic on that side too.

**Every catalogue item carries the mark on the wire**, in a
`SYNTHETIC_PASS_INFO` tag with `display: true`: *"Modelled pass. The rules and
the price are set by this specimen provider, not by BMTC or BMRCL."* It also
rides on the order's own `tags` through `on_select`, `on_init` and
`on_confirm`, so a client that reads only the confirmed order still gets it.

---

## 2. Searching by category, not by stop pair

Every intent this provider had answered until now named two GPS points,
because every product was a fare between two places. A pass has neither end,
so that shape cannot express the question at all — forcing one through it
would mean inventing GPS points that mean nothing.

A pass search names a category and carries **no `fulfillment` block at all**:

```json
{ "intent": { "category": { "descriptor": { "code": "PASS" } } } }
```

`on_search` answers with a provider carrying two categories and items under
the second:

```json
"categories": [
  { "id": "C1", "descriptor": { "name": "Ticket", "code": "TICKET" } },
  { "id": "C2", "descriptor": { "name": "Pass",   "code": "PASS" } }
]
```

Pass items carry `category_ids: ["C2"]`, `descriptor.code: "PASS"`, and a
`PASS`-type fulfillment with no `stops` and no `vehicle`. A stop-pair search
is untouched: it still answers with a single `C1` category, `SJT` items and
`TRIP` fulfillments.

### This is a domain extension, not a transcription

**No worked TRV11 example of a `PASS`-category search exists in the vendored
evidence** (`phase-1/evidence/`), and none was found anywhere else. What is
real is narrower and worth stating precisely:

- `PASS` is a **real, published TRV11 item code**, cited in `SPEC.md`
  section 2.2 as one this provider declined to implement.
- The `categories: (TICKET / PASS)` axis on `Provider` is **real**, observed
  in TRV11's own metro `on_search` example (`SPEC.md` section 3.5).
- **The category-only intent shape is this feature's own extension** of that
  axis. It uses vocabulary the domain already owns to ask a question the
  vendored examples never ask.
- **`type: "PASS"` on a fulfillment is a new value**, parallel to the
  existing `TRIP`. Not observed in the evidence.
- **`authorization.type: "TOTP"` and `authorization.status: "ISSUED"` are new
  values.** `SPEC.md` section 3.5 already records the full
  `authorization.status` enumeration as `UNRESOLVED` — `UNCLAIMED` is the only
  value appearing in the metro examples — so `ISSUED` is unverified against
  the published enumeration and should be pinned against
  `api/components/enum/index.yaml` on `release-TRV11-2.0.1` before anyone
  relies on it.

---

## 3. Concessions

A concession is a **discount on whichever of the nine items was selected**,
never a separate catalogue item. Nine items × two classes × a full-price tier
would be twenty-seven items for no benefit: the concession changes an item's
price, not its identity.

### This provider verifies nothing, and cannot

An order names a **class** and nothing else:

```json
{
  "descriptor": { "code": "CONCESSION" },
  "display": false,
  "list": [{ "descriptor": { "code": "CLASS" }, "value": "SENIOR" }]
}
```

`value` is `SENIOR` or `STUDENT`. The tag travels unchanged through `select`,
`init` and `confirm`, and `on_confirm` echoes it on `order.tags` so a client
reading only the confirmed order can honestly render "bought at the student
concession rate". An order with no concession carries no `CONCESSION` tag at
all — absence is the ordinary case, not a zero-value entry.

**This provider trusts the class the buyer app asserts and checks nothing.**
Not an age, not a student status, not a document. Verification is a
buyer-side, human, face-to-face attestation performed by operator staff, fully
outside this repository — see `docs/specs/pass-purchase.md` in the Tatak repo.
**Concession verification is therefore entirely staged from this provider's
point of view**, and nothing in this repo should be described as verifying
anyone's eligibility.

**Nothing identifying is ever accepted, stored or logged.** No document type,
no document number, no verification date, no rider identity. A `CONCESSION`
group carrying any entry other than `CLASS` is **refused** rather than quietly
stripped, and the refusal names the unexpected *codes* while never echoing
their values. A class value this provider does not recognise is likewise never
reflected into an error message unless it is already a bare `A-Z_` code —
error messages reach the event log, and an unexpected `value` is exactly where
an identity could be smuggled into one.

### Published rates, and how uneven the sourcing is

Every item publishes its own rates, so both sides compute the same discounted
price without either hard-coding a percentage:

```json
{
  "descriptor": { "code": "CONCESSION_INFO" },
  "display": false,
  "list": [
    { "descriptor": { "code": "SENIOR_DISCOUNT_PERCENT" }, "value": "10" },
    { "descriptor": { "code": "STUDENT_DISCOUNT_PERCENT" }, "value": "33" }
  ]
}
```

`SENIOR_DISCOUNT_PERCENT` is `25` on day and weekly items, `10` on monthly
items. `STUDENT_DISCOUNT_PERCENT` is `33` everywhere. **These two numbers are
not the same kind of number and must not be presented as though they were:**

- **The senior figures are a real number that may no longer be current.**
  They trace to BMTC's own passenger charter as reported by Citizen Matters
  in 2014: 25% off a single fare, 10% off a monthly commuter pass. That
  article is eleven years old; BMTC's fares rose roughly 15% in January 2025
  and nothing found restates these figures after that revision; and **the
  source conflicts with itself on the qualifying age**, citing a
  contemporaneous report giving 65 against BMTC's own stated 60. Neither this
  provider nor the brief resolves that conflict.
- **Applying a BMTC-sourced bus rate to a BMRCL metro item is an
  extrapolation with no metro-specific source at all.** There is no evidence
  that BMRCL offers a senior concession at this rate, or at any rate.
- **`33` for the student rate has no source of any kind, weak or otherwise.**
  No current BMTC student pass price could be found from any primary source.
  It is a round number invented so the product exists, and it needs the
  owner's sign-off more than any other constant in this feature.

Neither rate is stated by BMTC or BMRCL to this software, and neither should
ever be printed as though it were.

### Refusing a class with no published rate

If a buyer app names a class this provider published no rate for, the request
is **refused** rather than silently priced at zero or at the full rate:

```
CONCESSION-RATE-NOT-PUBLISHED
  No CHILD_DISCOUNT_PERCENT rate is published on this catalogue;
  this provider publishes SENIOR_DISCOUNT_PERCENT and
  STUDENT_DISCOUNT_PERCENT only
```

**The refusal arrives as an error on the callback, not as a synchronous
NACK**, because this provider answers every action asynchronously (`SPEC.md`
section 3.2): the inbound `select` is `ACK`ed, and the real answer is an
`on_select` carrying `error.code` and `error.message` with no `message.order`.
That is this stack's equivalent of a NACK for a domain error, and it is the
same path every other `OrderLifecycleError` already takes. The concession
class is deliberately **not** constrained to an enum in the request schema,
precisely so the refusal can name the missing rate rather than reading as a
generic schema violation.

### The quote shows its arithmetic

```json
"quote": {
  "price": { "currency": "INR", "value": "1809" },
  "breakup": [
    { "title": "BASE_FARE", "item": { "id": "PASS-MONTHLY-AC_BUS", "...": "..." },
      "price": { "currency": "INR", "value": "2700" } },
    { "title": "STUDENT_CONCESSION", "price": { "currency": "INR", "value": "-891" } }
  ]
}
```

The breakup exists so a receipt shows the arithmetic rather than only the
result. A `BASE_FARE` line attributes to an item; a concession line is a
modifier on the order and carries no `item`, one aggregated line per order.

**No rounding is ever exercised.** Every shipped price is a whole number of
rupees and every rate a whole percent, so `price × percent ÷ 100` divides
exactly in paise for all nine items and both classes — which is what lets two
independently-built implementations agree without having agreed on a rounding
convention. `tests/trv11/pass.test.ts` asserts this for all eighteen
combinations, so it fails loudly if a future price or rate breaks the
property. Were one to, the stated rule is round-half-up on paise.

---

## 4. The rotating credential

A single-journey ticket's `authorization.token` is a base64 QR PNG: static per
ticket, minted once, shown once. **A pass cannot use that shape.** A static
code screenshotted once works for every remaining day of a monthly pass. So a
pass's credential is a **shared secret**, and the client derives a short-lived
code from it.

```json
{
  "type": "TOTP",
  "token": "JBSWY3DPEHPK3PXP…",
  "valid_from": "2026-09-03T00:00:00.000+05:30",
  "valid_to": "2026-10-03T00:00:00.000+05:30",
  "status": "ISSUED"
}
```

- **`type: "TOTP"`, not `"QR"`** — "here is a secret to derive a code from"
  rather than "here is an image to show".
- **`token` is an RFC 4648 base32 secret**, not a PNG. Twenty
  cryptographically random bytes — 160 bits, the length RFC 6238's own
  reference implementation recommends for HMAC-SHA1 — which encode to exactly
  32 base32 characters with no padding.
- **`TOTP_INFO` on the credential fulfillment** names the parameters:
  `ALGORITHM: SHA1`, `DIGITS: 6`, `PERIOD_SECONDS: 30`. **RFC 6238 is the
  reference and these are its own defaults**, used unchanged rather than
  varied per pass.
- **Minted at `confirm`, and only at `confirm`.** This provider is the party a
  verifier checks codes against, so it holds the secret's source of truth.
  Fresh per credential fulfillment, per unit of quantity, and never reused
  across passes — not even for the same rider buying two at once.

`src/trv11/totp.ts` is checked against **RFC 6238 appendix B's own SHA1 test
vectors** and RFC 4648 section 10's base32 vectors in
`tests/trv11/totp.test.ts`. Verification accepts the current time step and one
either side, which is the widest skew allowance RFC 6238 section 5.2 reads as
reasonable.

### The window is the pass's own, not the algorithm's

`valid_from` is **midnight in `Asia/Kolkata` on the day the pass was
confirmed** — not the purchase instant, so a pass bought at 11pm does not read
as still valid at 10pm the next day. `valid_to` is that midnight advanced by
the item's window, and is **exclusive**: the instant the pass stops being
valid. Both are emitted in `+05:30` form so the calendar boundary they are
anchored to is legible on the wire; they are ordinary RFC 3339 instants and
parse identically to a `Z` form.

A monthly window lands on the same day of the following month. Where that day
does not exist there — the 31st of January — it lands on the **first of the
month after**, so the pass covers the whole of the short month rather than
being cut off inside it or spilling past it. This is a modelling choice, not a
transcription of what a BMTC monthly pass does at the edges, and it is worth
confirming before it matters to anyone.

A code computed outside the window is not a question this provider answers:
**a verifier checks the window first and the code second.**

### What the rotation does not solve

**It does not prevent sharing, and this repo must not describe it as though it
did.** A screenshot of a currently-valid code, shared to another phone, passes
for the rest of that thirty-second window, and would keep passing if the
screenshot were retaken every window. Nothing here can distinguish a device
holding the secret from a photograph of one device's screen.

What rotation does is **shorten the useful life of a shared code from the
whole pass period to thirty seconds**. That is a real improvement over a
static QR and it is the entire claim.

The mitigation for the rest is a visibly animated element on the code the
rider shows, so a human inspector can see the display is live rather than a
still image. **That is a human check, not a cryptographic one**, and it lives
in the client, not here.

This is the same shape of gap as the concession design's: an annually
re-verified senior concession bounds how long a leaked account can draw a
discount without closing the hole, and a secret provisioned to the device that
bought the pass means a leaked login alone does not hand over a working pass.
Neither mechanism is airtight; each narrows what the other leaves open.

---

## 5. Paying for a ride with a pass

**There is no second order path, and that is the design's best property.** A
rider boarding on a pass they already hold goes through exactly the same
`search` → `select` → `init` → `confirm` sequence as an ordinary on-board
sale, on the same single-journey item. Same intent, same item, same order
shape. One tag group on the payment changes:

```json
{
  "descriptor": { "code": "PASS_SETTLEMENT" },
  "display": false,
  "list": [
    { "descriptor": { "code": "PASS_ORDER_ID" }, "value": "SPECIMEN-ORD-BMTC-…" },
    { "descriptor": { "code": "PASS_CODE" },     "value": "482913" }
  ]
}
```

**`params.amount` still carries the fare that would have been charged** — a
real Ordinary fare, not `0`. A pass ride is not a zero-rupee ride: the ticket
has to keep saying what the ride was worth, which is what later lets a buyer
app's own advisor tell a rider whether their pass paid for itself.

**Checking the claim is this provider's job**, because this provider minted the
secret. At `confirm` it checks, in this order: that this operator holds a pass
under that order id for this buyer app, that the pass's scope covers the ride's
tier, that the pass is inside its own window, and only then that the presented
code matches the stored secret.

A claim that fails any of those is **refused** — not quietly downgraded to a
full-fare sale, because recording a ride as pass-settled when it was not would
be a lie in the ledger, and a buyer app that sent a bad claim needs to hear
which check failed:

| code | meaning |
|---|---|
| `PASS-SETTLEMENT-INVALID` | The tag group is malformed, duplicated, or on a pass purchase rather than a ride |
| `PASS-ORDER-NOT-FOUND` | This operator holds no such pass for this buyer app |
| `PASS-SCOPE-MISMATCH` | The pass's scope does not cover the tier being ridden |
| `PASS-WINDOW-EXPIRED` | The pass is outside its own validity window |
| `PASS-CODE-INVALID` | The code does not match the credential for the current window |

The presented code never appears in any of those messages: refusals reach the
event log.

**An uncovered service is charged the full fare, not the difference.** If the
tier being ridden is not in the pass's scope, a buyer app simply sends no
`PASS_SETTLEMENT` tag, and the order is an ordinary cash-equivalent sale.
There is no partial-credit path.

**One operator cannot verify another's pass.** A BMTC BPP holds no BMRCL
secret, exactly as it sells no BMRCL ticket — so a metro pass presented to
BMTC is `PASS-ORDER-NOT-FOUND`, and the credential lookup is keyed by
operator, buyer app and order id.

### The tier this provider can actually see, and where it cannot

The scope check needs the ride's class of service. `TransitOffer` now carries
an **optional** `serviceTier` (`ORDINARY_BUS` / `AC_BUS` / `METRO`), which a
journey source may supply — see `docs/journey-source-http.md`.

**When no source supplies it, the tier falls back to the operator's vehicle
category: a bus ride reads as `ORDINARY_BUS` and a metro ride as `METRO`.**
For this repo's own fixtures that is honest — the fixture bus fares are
Ordinary fares — but it has a consequence worth stating plainly: **with no
tier from the source, an AC bus ride cannot be told apart from an ordinary
one**, so an `ORDINARY_BUS` pass would settle a ride that was really on an AC
service. The scope check is only as good as the tier it is given. A journey
source that distinguishes AC from Ordinary closes that gap; the fixtures do
not.

### Metro entry and exit

For a metro leg on a pass, the same code is shown at entry and at exit, once
each. **That is a gate's job, not a Beckn action's.** Neither `select`, `init`
nor `confirm` models an entry or an exit; those are physical verifications
against the secret minted at `confirm`. This provider's job stops at minting
the secret and checking a presented code against it and against the window.

One property comes free once a verifier exists: a pass presented for entry
twice with no exit in between is visible to whatever holds the entry/exit
ledger, the same way a real gate refuses a double tap-in. Nothing here needs
to build that check for the design to be honest.

---

## 6. What is real and what is staged

**Real:** the protocol, the signing, the `PASS` item code on a real category
axis, the concession arithmetic and its published rates, the TOTP secret and
its RFC 6238 parameters, the scope and window checks, the schema validation on
both directions.

**Staged, on every surface a rider sees:**

- **Neither BMTC nor BMRCL will ever scan a code this provider mints.** The
  bus case is at least plausible today — a conductor looks at a phone the same
  way they would look at a paper pass. **The metro case needs a gate that
  accepts this code, and no such gate exists anywhere in Bengaluru.** None is
  being built here and none is coming.
- **A pass is exactly as much a specimen as a single-journey ticket**, and
  carries the same posture: `SPECIMEN - NOT VALID FOR TRAVEL` on every
  credential, `SPECIMEN - NOT VALID FOR TRAVEL - not issued by BMTC or BMRCL`
  on every order. A more convincing artefact needs the mark more, not less.
- **Every price is synthetic** and marked `SYNTHETIC_PASS_INFO` on the wire.
- **Concession verification is entirely staged from here.** This provider
  trusts a class tag with no way to check it, because checking it is not this
  provider's job.
- **No money moves.** `payments[].status: PAID` is written because the
  protocol requires a value (`SPEC.md` section 8.3), unchanged by any of this.

One operational note that follows from the secret being held here: a confirmed
pass order retains its secret in memory for the life of the process, and the
opt-in `GET /orders/:orderId` inspection endpoint returns the stored order
including it. That endpoint already exposed single-journey QR tokens the same
way, is bearer-token protected, and is off unless `ORDER_INSPECTION_TOKEN` is
set — but a pass secret is longer-lived than a ticket token, so leaving it
enabled on a shared host is worth deciding deliberately rather than by
default.

## 7. Additions beyond the pinned wire contract

The wire contract was pinned field-by-field in
`docs/prompts/ondc-02-sell-passes.md` and matched exactly on every field name
and tag code. These fields are **additional** to the examples there — all
additive, none renamed, and listed so the other side of the contract knows
they are coming:

| addition | why |
|---|---|
| `quantity: { maximum: { count: 6 }, minimum: { count: 1 } }` on catalogue items | Required by this repo's existing `on_search` schema, and the 1–6 bound is genuinely enforced |
| `time.timestamp` on catalogue items | Required by the same schema, as for `SJT` items |
| `SYNTHETIC_PASS_INFO` tag on every item and pass order | The synthetic mark has to travel on the wire, not only in a client's own constant |
| `TICKET_INFO`/`NUMBER` on the credential fulfillment | What the existing single-journey path already emits, and real TRV11 evidence (`SPEC.md` 3.5). Gives a credential a printable number |
| `item` on the `BASE_FARE` breakup line | Matches real TRV11 evidence and this repo's existing quote shape. Concession lines carry no `item` |
| `PASS_INFO` and `CONCESSION_INFO` on the *order* item, not only the catalogue item | So a client reading only `on_confirm` can freeze the window, the scope and the basis of the discount |
| `serviceTier` on `TransitOffer` (optional) | Makes the settlement scope check real rather than assumed |

Two behaviours are also worth naming because they are choices, not
transcriptions:

- **A `CONCESSION` tag on a single-journey order is refused**
  (`CONCESSION-NOT-APPLICABLE`) rather than ignored. Charging the full fare
  while the buyer app believed it had asked for a discount is the "silently
  price at the full rate" failure the contract forbids.
- **An order mixing pass and single-journey items is refused**
  (`MIXED-CATEGORY-ORDER`). The two are different products with no coherent
  combined quote.

**One thing this provider deliberately does not send:** there is no
verification-receipt tag on a successfully pass-settled `on_confirm`. The
`PASS_SETTLEMENT` tag echoes back unchanged and acceptance *is* the result;
inventing a field name for "this provider checked and it passed" would be
exactly the unilateral naming the contract warns against. If a client wants an
explicit receipt, the field name needs agreeing on both sides first.

## 8. Open questions for the owner

1. **`MONTHLY_DAY_MULTIPLE` (18×)** — proposed, not derived from anything BMTC
   has stated.
2. **The 33% student rate** — no source of any kind. The single number most
   needing sign-off.
3. **Whether 25%/10% is still current for the senior concession**, given the
   source is eleven years old, self-conflicted on the qualifying age, and
   predates a roughly 15% BMTC fare rise.
4. **`authorization.status: "ISSUED"`** — unverified against TRV11's own
   `authorization.status` enumeration, which `SPEC.md` 3.5 records as
   `UNRESOLVED`.
5. **The monthly window's short-month rule** — 31 January to 1 March is this
   feature's choice, unchecked against what a real monthly pass does.
6. **Whether the fixtures should distinguish AC from Ordinary bus offers**, so
   the settlement scope check is exercised against a tier the source actually
   states rather than a fallback.
