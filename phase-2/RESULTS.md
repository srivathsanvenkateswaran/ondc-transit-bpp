# Phase 2 results

Run date: 20 August 2026.

## Result

The provider now implements `select`, `init`, `confirm`, `status` and all four
callbacks for both local operator identities. The gateway is used for search
only. Every later request is addressed directly to the `bpp_id` and `bpp_uri`
stamped into that BPP's `on_search` context.

The captured run produced two independent orders:

| Operator | Transaction | Order | Unit fare | Quantity | Total | Tickets |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| BMTC specimen | `20000000-0000-4000-8000-000000000001` | `SPECIMEN-ORD-BMTC-01E273F9` | ₹27 | 2 | ₹54 | 2 |
| BMRCL specimen | `20000000-0000-4000-8000-000000000002` | `SPECIMEN-ORD-BMRCL-F7022B24` | ₹30 | 1 | ₹30 | 1 |
| Journey total | | | | | ₹84 | 3 |

The IDs, totals and tickets above come from the raw response bodies, not from a
handwritten expected-output file. [`tests/evidence/phase2.test.ts`](../tests/evidence/phase2.test.ts)
parses the committed evidence on every `npm test` run.

## Raw lifecycle evidence

All response files below are the unmodified bodies written by `curl -o`.

| Operator | Action | Request | Raw synchronous BAP response |
| --- | --- | --- | --- |
| BMTC | search | [`bmtc-search-request.json`](evidence/bmtc-search-request.json) | [`bmtc-search-response.raw.json`](evidence/bmtc-search-response.raw.json) |
| BMTC | select | [`bmtc-select-request.json`](evidence/bmtc-select-request.json) | [`bmtc-select-response.raw.json`](evidence/bmtc-select-response.raw.json) |
| BMTC | init | [`bmtc-init-request.json`](evidence/bmtc-init-request.json) | [`bmtc-init-response.raw.json`](evidence/bmtc-init-response.raw.json) |
| BMTC | confirm | [`bmtc-confirm-request.json`](evidence/bmtc-confirm-request.json) | [`bmtc-confirm-response.raw.json`](evidence/bmtc-confirm-response.raw.json) |
| BMTC | status | [`bmtc-status-request.json`](evidence/bmtc-status-request.json) | [`bmtc-status-response.raw.json`](evidence/bmtc-status-response.raw.json) |
| BMRCL | search | [`bmrcl-search-request.json`](evidence/bmrcl-search-request.json) | [`bmrcl-search-response.raw.json`](evidence/bmrcl-search-response.raw.json) |
| BMRCL | select | [`bmrcl-select-request.json`](evidence/bmrcl-select-request.json) | [`bmrcl-select-response.raw.json`](evidence/bmrcl-select-response.raw.json) |
| BMRCL | init | [`bmrcl-init-request.json`](evidence/bmrcl-init-request.json) | [`bmrcl-init-response.raw.json`](evidence/bmrcl-init-response.raw.json) |
| BMRCL | confirm | [`bmrcl-confirm-request.json`](evidence/bmrcl-confirm-request.json) | [`bmrcl-confirm-response.raw.json`](evidence/bmrcl-confirm-response.raw.json) |
| BMRCL | status | [`bmrcl-status-request.json`](evidence/bmrcl-status-request.json) | [`bmrcl-status-response.raw.json`](evidence/bmrcl-status-response.raw.json) |

Each synchronous response contains the corresponding `on_*` callback received
through the BAP protocol servers. Request and callback have the same
`transaction_id` and `message_id`; successive actions use fresh `message_id`
values.

The BMTC search is category-specific, so its successful response contains the
BMTC callback and BMRCL records a structured `SKIPPED` event. The broad search
that returns both callbacks was repeated after the final stack restart. Its
request is [`stack-smoke-search-request.json`](evidence/stack-smoke-search-request.json)
and its raw response is
[`stack-smoke-search-response.raw.json`](evidence/stack-smoke-search-response.raw.json).
The evidence test asserts two distinct BPP identities and one transaction ID.

## Data model and pricing

The catalogue item is `Single Journey Ticket` with descriptor code `SJT`. The
vehicle and ordered route remain on a `TRIP` fulfillment. No captured
`on_search` catalogue contains a quote.

The first quote appears on `on_select`. BMTC has one `BASE_FARE` line of ₹54
for two ₹27 items. BMRCL has one `BASE_FARE` line of ₹30 for one ₹30 item. The
evidence test parses rupee strings back to integer paise and proves:

```text
BMTC:  5400 == sum(5400)
BMRCL: 3000 == sum(3000)
```

The unit and integration tests also cover multiple breakup lines and the exact
conversion of 2700 paise to `"27"`. No floating-point fare arithmetic is used.

Fixture fares remain explicitly labelled whole-route placeholders. The new
optional `HttpJourneySource` sends the published planner request, validates the
response with [`schemas/journey-source-response.json`](../schemas/journey-source-response.json),
and consumes the planner's integer `farePaise` unchanged. HTTP error, invalid
response, and five-second timeout paths fall back to fixtures with a structured
`FALLBACK` log. The full contract is
[`docs/journey-source-http.md`](../docs/journey-source-http.md).

## Tickets and order storage

Every confirmed order has `status: ACTIVE`. Each selected unit produces one
`TICKET` fulfillment with:

- `authorization.type: QR`
- a non-empty base64 PNG whose decoded bytes start with the PNG signature
- a parseable `valid_to`
- `authorization.status: UNCLAIMED`
- a `TICKET_INFO` tag containing a distinct `NUMBER`

Order IDs and ticket numbers start with `SPECIMEN`. The order carries a visible
`SPECIMEN - NOT VALID FOR TRAVEL - not issued by BMTC or BMRCL` tag. The QR
encoder receives only:

```text
SPECIMEN|TRV11|{order_id}|{ticket_number}|NOT VALID FOR TRAVEL
```

The QR payload assertion is in the order-service test, using the same payload
builder as production. No real BMTC or BMRCL ticket payload or format is used.

The order store is in memory and keyed by order ID, with operator ownership
stored alongside the order. Both captured `on_status` orders are deeply equal
to their respective `on_confirm` orders. The two operators use different order
IDs and do not overwrite each other.

## Error evidence

A search with `context.domain` removed returned HTTP 400 and this raw body:
[`malformed-search-response.raw.json`](evidence/malformed-search-response.raw.json).
It is a `NACK` with `error.type: JSON-SCHEMA-ERROR` and names the missing
`domain`. The application test proves no callback is sent.

An unknown BMTC item was sent through the direct BAP-to-BPP action path. Its raw
response is
[`unknown-item-select-response.raw.json`](evidence/unknown-item-select-response.raw.json).
The callback contains `ITEM-NOT-FOUND`, an empty required `message` object, and
no quote. The empty `message` is required by the official generated TRV11
`on_select` schema.

## Routing, registry and signing

[`gateway-stack-smoke.raw.txt`](evidence/gateway-stack-smoke.raw.txt) is the raw
gateway log window for the final broad search. It contains the registry lookup,
both returned BPP identities, and fan-out search requests to both BPP URIs.
[`gateway-phase2.raw.txt`](evidence/gateway-phase2.raw.txt) is the raw gateway
window covering the captured lifecycles and contains no BPP `/select`, `/init`,
`/confirm` or `/status` URL.

[`registry-subscribers.raw.json`](evidence/registry-subscribers.raw.json) is the
unmodified `POST /subscribers/lookup` response. It contains subscribed records
for the gateway, BAP, BMTC BPP and BMRCL BPP, including signing public keys.
The pinned registry redirects unauthenticated `GET /subscribers` to its login
page, as captured in
[`registry-get-subscribers.raw.txt`](evidence/registry-get-subscribers.raw.txt).
Acceptance criterion 2 is therefore not met as literally worded, although the
registry lookup used by the gateway returns the required records.

Signing evidence remains in Phase 1 because it applies to the same six ONIX
services and keys. [`phase-1/evidence/auth-wire-request.txt`](../phase-1/evidence/auth-wire-request.txt)
contains the captured `Authorization: Signature` header.
[`phase-1/evidence/auth-tampered-response.raw.txt`](../phase-1/evidence/auth-tampered-response.raw.txt)
shows HTTP 401, `NACK`, and `Authentication failed` after one request-body byte
was changed.

## Acceptance criteria 1 through 17

| # | Result | Evidence and qualification |
| ---: | --- | --- |
| 1 | PARTIAL | [`docker-compose-ps.raw.txt`](evidence/docker-compose-ps.raw.txt) and [`docker-ps.raw.txt`](evidence/docker-ps.raw.txt) show the stack up. The repository still expects the external Phase 1 registry, gateway and Docker network to exist, and it has no `make seed` target. The criterion is not met as written. |
| 2 | PARTIAL | The raw lookup contains the four required subscribed identities. [`registry-get-subscribers.raw.txt`](evidence/registry-get-subscribers.raw.txt) proves unauthenticated `GET /subscribers` redirects to login; the pinned registry's JSON interface is `POST /subscribers/lookup`. The criterion is not met as written. |
| 3 | PASS | [`provider-health.raw.json`](evidence/provider-health.raw.json) is the raw 200 response body. |
| 4 | PASS | The final broad Phase 2 raw response has two distinct `on_search` callbacks with one transaction ID. |
| 5 | PASS | Both captured Phase 2 `on_search` bodies pass the local action schema; ONIX accepted each on the wire. |
| 6 | PASS | All ten successful Phase 2 callbacks plus the error callback pass the evidence validation test. ONIX also validated the official generated schema at every live hop. |
| 7 | PASS | The malformed raw response is a JSON schema `NACK`; the application test asserts no callback. |
| 8 | PASS | The unknown-item raw callback contains an error and no quote. |
| 9 | PASS | Each operator's five captured requests and callbacks preserve one byte-identical transaction ID. |
| 10 | PASS | Each action uses a distinct request message ID, and each callback matches its own request. |
| 11 | PASS | Both raw `on_confirm` bodies have active orders and complete specimen QR ticket fulfillments. |
| 12 | PASS | Each raw `on_status` order deeply equals its captured confirmed order. |
| 13 | PASS | The raw gateway logs show registry lookup and two search BPP URIs, with no later-action BPP URI. |
| 14 | PASS | Phase 1 wire and tamper artifacts prove signature presence and rejection. All six configs have `auth: true`. |
| 15 | PASS | Both captured quotes equal their parsed breakup sums. |
| 16 | PASS | Live fixture quotes match 2700 and 3000 paise exactly; unit tests cover exact HTTP planner paise and reject non-integers. |
| 17 | NOT EVALUATED | The two provider orders sum exactly to ₹84. Comparison with the journey total displayed by the consuming app belongs to Tatak stages 4 and 5, which this task explicitly excluded. |

Summary: 14 pass, 2 partial and not met as literally worded, 1 not evaluated
because its consuming application was out of scope.

## Verification

[`npm-test.raw.txt`](evidence/npm-test.raw.txt) is the unmodified test output:
42 tests, 42 passed. It includes the evidence audit, lifecycle service tests,
HTTP source tests, callback behavior, schema checks and fare mapping tests.

[`npm-build.raw.txt`](evidence/npm-build.raw.txt) is the unmodified TypeScript
build output. `docker compose config --quiet` also exited zero.

## Spec and implementation deviations

- SPEC section 6.1 assumes one configurable webhook URL per action. The pinned
  ONIX client has one webhook URL. The spec loses for this implementation, so
  each BPP uses one `/{operator}/inbound` route and dispatches by
  `context.action`. Action-specific provider routes remain for direct tests.
- ONIX does not ship a TRV11 2.0.1 schema. The exact upstream generated file is
  vendored beside a documented compatibility copy that permits only the extra
  context and stop-tag fields ONIX and this provider add.
- The official TRV11 error envelope requires `message` on `on_select` and does
  not allow `error.type`. The unknown-item callback follows the official schema
  rather than the earlier local subset.
- Fixture fares are whole-route placeholders. Only the HTTP source provides the
  distance-correct planner fare required for a real priced demonstration.
- No BAP application client or consuming-application ticket mapping was built.
  Those are SPEC stages 4 and 5 and were explicitly excluded.
