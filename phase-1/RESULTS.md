# Phase 1 two-operator discovery

## Result

Phase 1 passes. One `POST /search` to the synchronous BAP protocol server
returned HTTP 200 with two automatically generated `on_search` responses:

| BPP subscriber | Provider | Mode | Fare |
| --- | --- | --- | ---: |
| `bmrcl.bpp.transit.localhost` | Bangalore Metro Rail Corporation Limited | METRO | ₹30 |
| `bmtc.bpp.transit.localhost` | Bengaluru Metropolitan Transport Corporation | BUS | ₹27 |

Both catalogues use an SJT fare product, rupee-string prices, a `TRIP`
fulfillment, real Bengaluru stop names, and a chain in which every stop after
the first points to the preceding stop through `parent_stop_id`. No callback
was posted by hand.

This is the required Phase 1 stop point. `select`, `init`, `confirm`, `status`,
order storage, `BASE_FARE` quote breakup, and ticket QR generation remain for
Phase 2. A quote is not part of the TRV11 `on_search` catalogue; it first
appears on `on_select` in the lifecycle described by SPEC section 6.

## Configuration used

The exact non-secret runtime values are in
[`evidence/config-used.json`](evidence/config-used.json). The generated signing
private keys remain in ignored runtime files. The tracked ONIX templates are
under [`../stage-0/onix-sync/config`](../stage-0/onix-sync/config), and the
provider and ONIX services are composed by
[`../docker-compose.yml`](../docker-compose.yml).

The important seams were:

```text
BAP synchronous client: http://127.0.0.1:5001/search
BMTC BPP webhook:       http://transit-bpp:7001/bmtc/search
BMRCL BPP webhook:      http://transit-bpp:7001/bmrcl/search
BMTC callback:          http://bmtc-bpp-client:6001/on_search
BMRCL callback:         http://bmrcl-bpp-client:6101/on_search
Search collection TTL:  PT4S
```

The published `fidedocker/protocol-server` image has no core schema file named
for 2.0.1. At container startup, Compose exposes the image's core 1.1.0 schema
under the 2.0.1 filename so ONIX can transport a `version: 2.0.1` envelope.
The provider validates the TRV11 2.0.1 discovery input and output with the
schemas under [`../schemas/ondc_trv11/2.0.1`](../schemas/ondc_trv11/2.0.1).

## Authentication and tamper rejection

SPEC acceptance criterion 14 passes. Authentication is enabled with
`auth: true` in all six ONIX client and network configurations. The local
registry's `signing_public_key` and `unique_key_id` values match the ignored
runtime key pairs for the BAP, BMTC BPP and BMRCL BPP identities.

[`evidence/auth-search.pcap`](evidence/auth-search.pcap) is the raw packet
capture of a gateway-to-BMTC BPP `POST /search`. Its decoded HTTP request is in
[`evidence/auth-wire-request.txt`](evidence/auth-wire-request.txt). The wire
request carries both the originating participant signature:

```text
AUTHORIZATION: Signature keyId="bap.transit.localhost|bap-transit-key|ed25519",...
```

and the gateway signature in `X-GATEWAY-AUTHORIZATION`.

The captured body and exact captured headers were first replayed unchanged.
The BMTC BPP network server returned HTTP 202 with `ACK`; the unmodified result
is [`evidence/auth-untampered-response.raw.txt`](evidence/auth-untampered-response.raw.txt).
The origin latitude was then changed by one byte from `12.9784` to `12.9785`
while keeping both signature headers byte-identical. The same receiver returned
HTTP 401 with `NACK` and `Authentication failed`; the unmodified result is
[`evidence/auth-tampered-response.raw.txt`](evidence/auth-tampered-response.raw.txt).
Representations of the two replay bodies are in
[`evidence/auth-replay-request.json`](evidence/auth-replay-request.json) and
[`evidence/auth-tampered-request.json`](evidence/auth-tampered-request.json).

## Request and raw response

The only protocol request submitted for the recorded successful run was:

```console
curl -sS -H 'Content-Type: application/json' \
  --data-binary @phase-1/evidence/search-request.json \
  -w '\nHTTP_STATUS=%{http_code}\nTIME_TOTAL=%{time_total}\n' \
  http://127.0.0.1:5001/search
```

Evidence:

- [`evidence/search-request.json`](evidence/search-request.json) is the request.
- [`evidence/search-response.raw.json`](evidence/search-response.raw.json) is
  the unmodified response body.
- [`evidence/search-timing.txt`](evidence/search-timing.txt) records HTTP 200 in
  4.681312 seconds.
- [`evidence/provider-events.jsonl`](evidence/provider-events.jsonl) records both
  webhook ACKs and both automatic callback ACKs for the same transaction and
  message IDs.

The BAP protocol server set its transport context timestamp to
`05:59:23.462Z`. BMRCL generated its callback at `05:59:24.888Z` and BMTC at
`05:59:25.562Z`. Both were therefore produced about 2.1 seconds into the
request, while the synchronous call still returned after 4.681312 seconds.

ONIX replaces the incoming context TTL with its general `app.ttl` value of
`PT10M` when it constructs an envelope. The synchronous collection duration is
controlled separately by `app.actions.requests.search.ttl` and
`app.actions.responses.on_search.ttl`; both were `PT4S` in this run.

## TTL behavior and dropped-response cost

The normal run proves that the BAP synchronous client does not return early
after both registered BPP responses arrive. Both callbacks existed about 2.1
seconds after the BAP timestamp, but the client waited through the configured
four-second collection window and returned in 4.681312 seconds including local
protocol overhead.

For a controlled drop test, only `BMRCL_CALLBACK_DELAY_MS` was changed from
`0` to `4500`. BMTC remained at `0`; the ONIX collection TTL remained `PT4S`.
The same broad discovery was then sent with fresh correlation IDs.

Evidence:

- [`evidence/delayed-search-request.json`](evidence/delayed-search-request.json)
  is the delayed test request.
- [`evidence/delayed-search-response.raw.json`](evidence/delayed-search-response.raw.json)
  is the raw result with BMTC only.
- [`evidence/delayed-search-timing.txt`](evidence/delayed-search-timing.txt)
  records HTTP 200 in 4.690558 seconds.
- [`evidence/delayed-provider-events.jsonl`](evidence/delayed-provider-events.jsonl)
  shows BMTC callback completion at `05:57:06.454Z` and BMRCL callback
  completion at `05:57:11.641Z`.

The late BMRCL callback was accepted by its BPP protocol server but was absent
from the already returned BAP response. The cost of the shorter demo TTL is
therefore explicit: any seller response that completes outside the four-second
window is dropped from that synchronous result. The delay was restored to zero
after the experiment.

## Verification

```text
npm test: 15 passing
npm run build: passing
docker image: ondc-transit-bpp:local built successfully
docker compose config --quiet: passing
live search: HTTP 200, two responses
delayed search: HTTP 200, one response
signed search replay: HTTP 202, ACK
one-byte tampered replay: HTTP 401, NACK
```
